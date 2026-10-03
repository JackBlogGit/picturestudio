import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { AppError } from '../../common/http/app-error';

/**
 * crawl4ai-skill CLI 适配器（PRD 10.8 / D28 的候选来源通道）。
 * 本模块只做两件事：站外检索取回结果条目、读回单个页面的标题与摘要文本。
 * 不下载文件、不落盘任何抓取内容——采集到的字节只活在进程内存里，解析完即弃。
 */

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
}

export interface PageMeta {
  title: string;
  description: string;
}

export interface CrawlRunner {
  search(keyword: string, limit: number): Promise<SearchHit[]>;
  pageMeta(url: string): Promise<PageMeta>;
}

/** 接口在运行时被擦除，注入 token 单独给一个字符串常量，单测据此替换假实现 */
export const CRAWLER_RUNNER = 'CRAWLER_RUNNER';

/** CLI 输出可能是 JSON，也可能是 LLM 友好的 Markdown 列表，两种都在此收敛成条目 */
export function parseSearchOutput(raw: string, limit: number): SearchHit[] {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const push = (url: string, title: string, snippet: string): void => {
    const clean = url.trim();
    if (!/^https?:\/\//i.test(clean) || seen.has(clean)) return;
    seen.add(clean);
    hits.push({ url: clean, title: title.trim().slice(0, 255), snippet: snippet.trim().slice(0, 500) });
  };

  if (text.startsWith('[') || text.startsWith('{')) {
    let rows: unknown[] = [];
    try {
      const data: unknown = JSON.parse(text);
      rows = Array.isArray(data) ? data : Array.isArray((data as { results?: unknown[] })?.results) ? (data as { results: unknown[] }).results : [];
    } catch {
      rows = []; // 不是合法 JSON，按下面的 Markdown / 纯文本再试一次
    }
    if (rows.length) {
      for (const item of rows) {
        const row = (item ?? {}) as Record<string, unknown>;
        push(String(row.url ?? row.link ?? ''), String(row.title ?? ''), String(row.snippet ?? row.description ?? row.body ?? ''));
      }
      return hits.slice(0, limit);
    }
  }

  // Markdown 链接：- [标题](https://…) 摘要正文
  const link = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)([^\n]*)/g;
  for (const match of text.matchAll(link)) {
    push(match[2], match[1], match[3].replace(/^[\s:：\-—]+/, ''));
  }
  if (hits.length) return hits.slice(0, limit);

  // 退化形态：逐行 `标题 — https://…`
  for (const line of text.split('\n')) {
    const url = /https?:\/\/\S+/.exec(line)?.[0];
    if (!url) continue;
    push(url, line.replace(url, '').replace(/\s*[—|-]\s*$/, '').trim(), '');
  }
  return hits.slice(0, limit);
}

/** 从 CLI 抓回的 Markdown 里取标题与首段，取不到就留空，不猜 */
export function parsePageMeta(raw: string): PageMeta {
  const text = String(raw ?? '').trim();
  const heading = /^#\s+(.+)$/m.exec(text)?.[1];
  const title =
    heading ??
    /<title[^>]*>([^<]+)<\/title>/i.exec(text)?.[1] ??
    '';
  const body = text
    .split('\n')
    .map((l) => l.trim())
    .find(
      (l) => l.length > 20 && !l.startsWith('#') && !l.startsWith('!') && !l.startsWith('[') && !/^[->*`|]/.test(l),
    );
  return { title: title.trim().slice(0, 255), description: (body ?? '').slice(0, 500) };
}

export interface RunnerOptions {
  command: string;
  args: string[];
  timeoutMs: number;
  /** 上限保护：CLI 输出异常膨胀时直接截断，避免打爆后端内存 */
  maxBufferBytes: number;
}

@Injectable()
export class Crawl4AiRunner implements CrawlRunner {
  private readonly logger = new Logger(Crawl4AiRunner.name);

  async run(options: RunnerOptions): Promise<string> {
    const { command, args, timeoutMs, maxBufferBytes } = options;
    return new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true });
      let out = '';
      let err = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new AppError(504, 'CRAWLER_TIMEOUT', `采集超时（${Math.round(timeoutMs / 1000)} 秒），请稍后重试`));
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
        if (out.length > maxBufferBytes) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.kill('SIGKILL');
          reject(new AppError(502, 'CRAWLER_OUTPUT_TOO_LARGE', '采集返回内容过大，请缩小检索数量'));
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        err += chunk.toString('utf8').slice(0, 2000);
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const missing = error.code === 'ENOENT';
        if (missing) this.logger.warn(`采集命令不可用：${command}`);
        reject(
          new AppError(
            missing ? 503 : 502,
            missing ? 'CRAWLER_UNAVAILABLE' : 'CRAWLER_FAILED',
            missing
              ? `服务器未安装采集命令 ${command}，检索与页面读取暂不可用`
              : `采集进程启动失败：${error.message}`,
          ),
        );
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new AppError(502, 'CRAWLER_FAILED', `采集失败（退出码 ${code}）${err ? `：${err.slice(0, 200)}` : ''}`));
      });
    });
  }

  search(keyword: string, limit: number): Promise<SearchHit[]> {
    return this.run({
      command: process.env.CRAWLER_CLI_COMMAND?.trim() || 'crawl4ai-skill',
      args: ['search', keyword, '--num-results', String(limit)],
      timeoutMs: numberEnv('CRAWLER_SEARCH_TIMEOUT_MS', 45_000),
      maxBufferBytes: numberEnv('CRAWLER_MAX_BUFFER_BYTES', 2_000_000),
    }).then((out) => parseSearchOutput(out, limit));
  }

  pageMeta(url: string): Promise<PageMeta> {
    return this.run({
      command: process.env.CRAWLER_CLI_COMMAND?.trim() || 'crawl4ai-skill',
      args: ['crawl', url, '--format', 'raw_markdown'],
      timeoutMs: numberEnv('CRAWLER_PROBE_TIMEOUT_MS', 30_000),
      maxBufferBytes: numberEnv('CRAWLER_MAX_BUFFER_BYTES', 2_000_000),
    }).then(parsePageMeta);
  }
}

function numberEnv(key: string, fallback: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
