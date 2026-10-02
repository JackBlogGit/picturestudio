import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, Like, Repository } from 'typeorm';
import { AppError } from '../../common/http/app-error';
import { clampPaging, Page, pagedList } from '../../common/http/pagination';
import { Actor, ActorKind } from '../../common/permission/types';
import { UserLevel } from '../../common/enums/user-level.enum';
import {
  CrawlerLink,
  CrawlerLinkSource,
  CrawlerLinkStatus,
  CrawlerPlatform,
  LogTargetType,
} from '../../entities';
import { AuditService, RequestContext } from '../audit/audit.service';
import { CRAWLER_RUNNER, CrawlRunner, PageMeta, SearchHit } from './crawl-runner';
import {
  CreateCrawlerLinkDto,
  CRAWLER_SEARCH_LIMITS,
  ListCrawlerLinkDto,
  ProbeCrawlerDto,
  SearchCrawlerDto,
  UpdateCrawlerLinkDto,
} from './dto/crawler.dto';
import { assertKeyword, hashUrl, platformOf, toSafeUrl } from './url-policy';

/** 检索命中条目：附带平台归类与「是否已登记」，前端才好在结果里直接标出重复 */
export interface CrawlerSearchHitView extends SearchHit {
  domain: string;
  platform: CrawlerPlatform;
  registered: boolean;
  linkId: number | null;
}

export interface CrawlerSearchResult {
  keyword: string;
  limit: number;
  /** 采集到的原始条数 */
  fetched: number;
  /** 被 SSRF 闸门丢掉、或因非法地址无法登记的条数 */
  dropped: number;
  hits: CrawlerSearchHitView[];
}

export interface CrawlerProbeResult {
  url: string;
  domain: string;
  platform: CrawlerPlatform;
  title: string;
  description: string;
  registered: boolean;
  linkId: number | null;
}

export interface CrawlerLinkView {
  id: number;
  url: string;
  title: string;
  snippet: string;
  domain: string;
  platform: CrawlerPlatform;
  keyword: string;
  source: CrawlerLinkSource;
  status: CrawlerLinkStatus;
  note: string;
  createUid: number | null;
  auditUid: number | null;
  auditTime: string | null;
  createTime: string;
}

@Injectable()
export class CrawlerService {
  private readonly logger = new Logger(CrawlerService.name);

  constructor(
    @InjectRepository(CrawlerLink) private readonly repo: Repository<CrawlerLink>,
    @Inject(CRAWLER_RUNNER) private readonly runner: CrawlRunner,
    private readonly audit: AuditService,
  ) {}

  /**
   * 站外检索：结果只作为「候选来源」返回，不自动落库——
   * 是否登记由超管逐条决定，避免把搜索引擎的噪声写成站内数据。
   */
  async search(dto: SearchCrawlerDto, actor: Actor, ctx: RequestContext): Promise<CrawlerSearchResult> {
    const keyword = assertKeyword(dto.keyword);
    const limit = dto.limit ?? CRAWLER_SEARCH_LIMITS.fallback;
    const raw = await this.runner.search(keyword, limit);
    const kept: Array<{ hit: SearchHit; url: string; hash: string; domain: string }> = [];
    let dropped = 0;
    for (const hit of raw) {
      try {
        const safe = toSafeUrl(hit.url);
        kept.push({ hit, url: safe.url, hash: hashUrl(safe.url), domain: safe.domain });
      } catch {
        // 搜索引擎偶尔返回内网测试地址或畸形链接，跳过这一条而不是整次检索失败
        dropped += 1;
      }
    }

    const known = await this.findByHashes(kept.map((k) => k.hash));
    const hits = kept.map(({ hit, url, hash, domain }) => {
      const existing = known.get(hash);
      return {
        url,
        title: hit.title || '',
        snippet: hit.snippet || '',
        domain,
        platform: platformOf(domain),
        registered: !!existing,
        linkId: existing?.id ?? null,
      };
    });

    await this.audit.record(actor, ctx, {
      action: 'crawler_searched',
      detail: `${keyword} 命中 ${hits.length} 条，丢弃 ${dropped} 条`,
    });
    return { keyword, limit, fetched: raw.length, dropped, hits };
  }

  /** 读取单个页面的标题与摘要文本，供手敲登记前确认「这条链接是什么」 */
  async probe(dto: ProbeCrawlerDto, actor: Actor, ctx: RequestContext): Promise<CrawlerProbeResult> {
    const target = toSafeUrl(dto.url);
    const hash = hashUrl(target.url);
    const known = await this.findByHashes([hash]);
    let meta: PageMeta = { title: '', description: '' };
    try {
      meta = await this.runner.pageMeta(target.url);
    } catch (error) {
      // 站点反爬或超时不应让登记流程走不下去：元数据留空，由超管自己填
      this.logger.warn(`页面元数据读取失败 ${target.url}：${(error as Error).message}`);
    }
    await this.audit.record(actor, ctx, {
      action: 'crawler_probed',
      detail: target.url.slice(0, 300),
    });
    return {
      url: target.url,
      domain: target.domain,
      platform: platformOf(target.domain),
      title: meta.title,
      description: meta.description,
      registered: known.has(hash),
      linkId: known.get(hash)?.id ?? null,
    };
  }

  async list(query: ListCrawlerLinkDto): Promise<Page<CrawlerLinkView>> {
    const { skip, take, page, pageSize } = clampPaging(query);
    const base: FindOptionsWhere<CrawlerLink> = {};
    if (query.status !== undefined) base.status = query.status;
    if (query.platform) base.platform = query.platform;

    // 命中三列即可：标题、正文摘要常在登记时同填，URL 用来回答「这条链接搜出来了没」
    let where: FindOptionsWhere<CrawlerLink> | FindOptionsWhere<CrawlerLink>[] = base;
    if (query.q) {
      const pattern = `%${escapeLike(query.q)}%`;
      where = [
        { ...base, title: Like(pattern) },
        { ...base, url: Like(pattern) },
        { ...base, domain: Like(pattern) },
      ];
    }

    const [rows, total] = await this.repo.findAndCount({
      where,
      order: { createTime: 'DESC' },
      skip,
      take,
    });
    return pagedList(rows.map(toView), total, page, pageSize);
  }

  /** 登记一条站外来源；同一规范化地址只允许一条，重复登记返回已存在的 id */
  async create(dto: CreateCrawlerLinkDto, actor: Actor, ctx: RequestContext): Promise<CrawlerLinkView> {
    const target = toSafeUrl(dto.url);
    const hash = hashUrl(target.url);
    const existing = await this.repo.findOne({ where: { urlHash: hash } });
    if (existing) {
      throw new AppError(409, 'LINK_EXISTS', '该链接已登记', { id: existing.id, status: existing.status });
    }
    const saved = await this.repo.save(
      this.repo.create({
        url: target.url,
        urlHash: hash,
        title: (dto.title ?? '').slice(0, 255),
        snippet: (dto.snippet ?? '').slice(0, 500),
        domain: target.domain,
        platform: platformOf(target.domain),
        keyword: (dto.keyword ?? '').slice(0, 100),
        source: dto.keyword ? CrawlerLinkSource.Search : CrawlerLinkSource.Manual,
        status: CrawlerLinkStatus.Pending,
        createUid: this.uidOf(actor),
      }),
    );
    await this.audit.record(actor, ctx, {
      action: 'crawler_link_created',
      targetType: LogTargetType.Crawler,
      targetId: saved.id,
      detail: saved.url.slice(0, 300),
    });
    return toView(saved);
  }

  /** 跟进状态与备注由超管逐项推进，落库同时盖章审计人与时间 */
  async updateStatus(
    id: number,
    dto: UpdateCrawlerLinkDto,
    actor: Actor,
    ctx: RequestContext,
  ): Promise<CrawlerLinkView> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new AppError(404, 'NOT_FOUND', '登记记录不存在');
    const before = row.status;
    row.status = dto.status;
    if (dto.note !== undefined) row.note = dto.note.slice(0, 500);
    row.auditUid = this.uidOf(actor);
    row.auditTime = new Date();
    const saved = await this.repo.save(row);
    await this.audit.record(actor, ctx, {
      action: 'crawler_link_status',
      targetType: LogTargetType.Crawler,
      targetId: saved.id,
      detail: `${before} → ${saved.status}`,
    });
    return toView(saved);
  }

  async remove(id: number, actor: Actor, ctx: RequestContext): Promise<{ id: number; removed: true }> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new AppError(404, 'NOT_FOUND', '登记记录不存在');
    await this.repo.delete({ id });
    await this.audit.record(actor, ctx, {
      action: 'crawler_link_removed',
      targetType: LogTargetType.Crawler,
      targetId: id,
      detail: row.url.slice(0, 300),
    });
    return { id, removed: true };
  }

  private async findByHashes(hashes: string[]): Promise<Map<string, CrawlerLink>> {
    const unique = [...new Set(hashes)];
    if (!unique.length) return new Map();
    const rows = await this.repo.find({ where: { urlHash: In(unique) } });
    return new Map(rows.map((r) => [r.urlHash, r]));
  }

  private uidOf(actor: Actor): number {
    if (actor.kind !== ActorKind.Member) {
      throw new AppError(403, 'ADMIN_REQUIRED', '仅正式成员可登记站外来源');
    }
    if (actor.level < UserLevel.SuperAdmin) {
      throw new AppError(403, 'LEVEL_FORBIDDEN', '爬虫仅超级管理员可用');
    }
    return actor.uid;
  }
}

/** LIKE 的通配符必须转义，否则检索词里的 % 和 _ 会变成通配 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function toView(row: CrawlerLink): CrawlerLinkView {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    snippet: row.snippet,
    domain: row.domain,
    platform: row.platform,
    keyword: row.keyword,
    source: row.source,
    status: row.status,
    note: row.note,
    createUid: row.createUid,
    auditUid: row.auditUid,
    auditTime: row.auditTime ? new Date(row.auditTime).toISOString() : null,
    createTime: new Date(row.createTime).toISOString(),
  };
}
