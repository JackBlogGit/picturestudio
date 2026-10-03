/**
 * 站外来源登记的 mock（PRD 10.8 / D28），逐条对齐 server/src/modules/crawler：
 * URL 闸门、规范化与去重、状态流转、审计动作名与错误码位都取后端的写法。
 *
 * 与后端唯一的差别是采集源。真后端 spawn `crawl4ai-skill` CLI，浏览器里跑不了外部命令，
 * 于是下面的 POOL 直接充当 CLI 的输出——命中项照样过一遍 toSafeUrl，
 * 所以「内网地址被闸门丢掉、dropped 计数非零」这条路径在演示里是真的，不是写死的数字。
 *
 * 整组路由只认 L4：非成员 403 ADMIN_REQUIRED，L3 及以下 403 LEVEL_FORBIDDEN。
 * 这一入口不参与 D20 个人授权与 D21 能力位覆盖，超管也没法给别人开。
 * 后端的 6 次/60 秒检索限流由 @Throttle 全局守卫做，mock 不复现。
 */
import type {
  CrawlerLinkStatus,
  CrawlerLinkView,
  CrawlerPlatform,
  CrawlerProbeResult,
  CrawlerSearchHitView,
  CrawlerSearchResult,
  Page,
} from '@/types/api';
import {
  CRAWLER_PLATFORM_LABEL,
  CRAWLER_PLATFORMS,
  CrawlerLinkStatus as Status,
  CrawlerPlatform as Platform,
  UserLevel,
} from '@/types/api';
import type { Actor, MemberActor } from './policy';
import { fail, int, paged, requireReauth, str } from './shared';
import { writeLog } from './admin';

// ---------------- URL 闸门（对齐 url-policy.ts） ----------------

export interface SafeUrl {
  url: string;
  host: string;
  port: number;
  domain: string;
}

const MAX_URL_LENGTH = 1000;

/** 各平台分享链接都会挂的跟踪参数，去掉后同一篇内容才能收敛成一条记录 */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'spm',
  'spm_id_from',
  'from',
  'from_source',
  'from_spmid',
  'refer',
  'referer',
  'ref',
  'ref_url',
  'scene',
  'share_from',
  'share_fromUserID',
  'share_medium',
  'share_plat',
  'share_session_id',
  'share_source',
  'share_tag',
  'share_token',
  'src',
  'vd_source',
  'is_story_h5',
  'xhsshare',
]);

const TWO_LEVEL_SUFFIXES = new Set([
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'edu.cn',
  'ac.cn',
  'com.hk',
  'com.tw',
  'co.jp',
  'co.kr',
  'com.sg',
  'com.au',
  'co.uk',
  'com.br',
]);

const BLOCKED_SUFFIXES = ['.local', '.internal', '.localhost', '.lan', '.intranet', '.corp'];

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const INTERNAL = '该地址指向内网或保留网段，服务器不会访问';

function isPrivateIpv4(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && b >= 18 && b <= 19) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return a >= 224;
}

function checkIpv6(hostname: string): void {
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const dotted = /^::ffff:((\d{1,3}\.){3}\d{1,3})$/.exec(bare);
  if (dotted) {
    const parts = dotted[1].split('.').map(Number);
    if (isPrivateIpv4(parts[0], parts[1], parts[2])) fail(400, 'INTERNAL_URL_FORBIDDEN', INTERNAL);
    return;
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (hex) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    if (isPrivateIpv4((hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff)) fail(400, 'INTERNAL_URL_FORBIDDEN', INTERNAL);
    return;
  }
  if (bare === '::1' || bare === '::' || /^fe8/.test(bare) || /^fc/.test(bare) || /^fd/.test(bare)) {
    fail(400, 'INTERNAL_URL_FORBIDDEN', INTERNAL);
  }
}

function assertPublicHost(hostname: string): void {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    fail(400, 'INTERNAL_URL_FORBIDDEN', '内网域名不予采集');
  }
  if (host.startsWith('[')) {
    checkIpv6(host);
    return;
  }
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(host)) {
    const m = IPV4.exec(host);
    if (!m) fail(400, 'INVALID_URL', '地址的主机名不合法');
    if (isPrivateIpv4(Number(m[1]), Number(m[2]), Number(m[3]))) fail(400, 'INTERNAL_URL_FORBIDDEN', INTERNAL);
    return;
  }
  if (!host.includes('.')) fail(400, 'INVALID_URL', '地址缺少完整域名');
}

function registrableDomain(host: string): string {
  const bare = host.replace(/^\[|\]$/g, '');
  if (IPV4.test(bare)) return bare;
  const labels = bare.split('.');
  if (labels.length <= 2) return bare;
  const tail = labels.slice(-2).join('.');
  if (TWO_LEVEL_SUFFIXES.has(tail)) return labels.slice(-3).join('.');
  return tail;
}

/** 校验 + 规范化：拒掉非 http(s)、带凭据、非常规端口、内网目标，再摘掉 fragment 与跟踪参数 */
export function toSafeUrl(raw: string): SafeUrl {
  const value = String(raw ?? '').trim();
  if (!value) fail(400, 'INVALID_URL', '地址不能为空');
  if (value.length > MAX_URL_LENGTH) fail(400, 'URL_TOO_LONG', `地址最长 ${MAX_URL_LENGTH} 字符`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(400, 'INVALID_URL', '地址格式不正确，请填写完整链接');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail(400, 'INVALID_URL', '只支持 http / https 链接');
  }
  if (parsed.username || parsed.password) fail(400, 'INVALID_URL', '地址不应包含账号凭据');
  assertPublicHost(parsed.hostname);
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    fail(400, 'PORT_FORBIDDEN', '只允许默认的 80 / 443 端口');
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) parsed.searchParams.delete(key);
  }
  parsed.hash = '';
  const query = parsed.searchParams.toString();
  let path = parsed.pathname || '/';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return {
    url: `${parsed.protocol}//${parsed.host}${path}${query ? `?${query}` : ''}`,
    host: parsed.hostname.toLowerCase(),
    port: parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80,
    domain: registrableDomain(parsed.hostname),
  };
}

const PLATFORM_BY_DOMAIN: Array<[RegExp, CrawlerPlatform]> = [
  [/(^|\.)(weibo\.com|weibo\.cn)$/, Platform.Weibo],
  [/(^|\.)(bilibili\.com|b23\.tv)$/, Platform.Bilibili],
  [/(^|\.)(xiaohongshu\.com|xhslink\.com)$/, Platform.Xiaohongshu],
  [/(^|\.)(douyin\.com|iesdouyin\.com)$/, Platform.Douyin],
  [/(^|\.)(twitter\.com|x\.com|t\.co)$/, Platform.Twitter],
];

export function platformOf(domain: string): CrawlerPlatform {
  const host = domain.toLowerCase();
  for (const [pattern, platform] of PLATFORM_BY_DOMAIN) {
    if (pattern.test(host)) return platform;
  }
  return Platform.Other;
}

function assertKeyword(keyword: string): string {
  const value = String(keyword ?? '').trim();
  if (value.length < 2) fail(400, 'KEYWORD_TOO_SHORT', '检索词至少 2 个字符');
  if (value.length > 50) fail(400, 'KEYWORD_TOO_LONG', '检索词最长 50 个字符');
  return value;
}

/** 与后端 DTO 的校验同范围：越界值直接拒，不静默夹到边界 */
function clampLimit(value: unknown): number {
  if (value === undefined || value === '') return 10;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 20) fail(400, 'VALIDATION_FAILED', 'limit 只能是 1~20 的整数');
  return n;
}

// ---------------- 采集源替身：相当于 CLI 的检索输出 ----------------

interface PoolRow {
  url: string;
  title: string;
  snippet: string;
}

/**
 * 候选来源池。标题与摘要里的 {kw} 由检索词填入，所以换词能看到不同结果。
 * 末尾两条故意是内网地址与非法协议：搜索引擎偶尔真会带回这种东西，
 * 它们必须被闸门丢掉并计入 dropped，而不是变成一条登记记录。
 */
const POOL: PoolRow[] = [
  {
    url: 'https://weibo.com/ttarticle/p/show?id=2309405012345678901234&utm_term=share',
    title: '「{kw}」整本图集搬运，出处只字未提',
    snippet: '转载方把工作室返图拆成九宫格发布，评论区有人指出原图带水印被裁掉了。',
  },
  {
    url: 'https://www.bilibili.com/opus/876543210987654321',
    title: '{kw} cos 后期合集（自存）',
    snippet: '动态里写了「图源网络」，实际用的全是本次返图，未联系过本人。',
  },
  {
    url: 'https://www.xiaohongshu.com/explore/65a1b2c3d4e5f60789abcdef?xhsshare=CopyLink',
    title: '超还原的 {kw} ｜附全套场照',
    snippet: '笔记正文把 42 张场照说成「朋友拍的」，EXIF 与工作室样片一致。',
  },
  {
    url: 'https://www.douyin.com/video/7300123456789012345',
    title: '{kw} 混剪，卡点太绝了',
    snippet: '视频素材逐帧来自返图原图，未做授权声明。',
  },
  {
    url: 'https://b23.tv/abcdefg',
    title: '{kw} 相关稿件存档',
    snippet: '短链指向一篇转载稿件，原帖已设置仅自己可见。',
  },
  {
    url: 'https://twitter.com/i/web/status/1800123456789012345',
    title: '{kw} photo set repost',
    snippet: 'Account reposts full sets from multiple studios, no credit in bio.',
  },
  {
    url: 'https://www.pixiv.net/artworks/123456789',
    title: '{kw} 同人企划收录页',
    snippet: '页面把工作室的场地照作为参考图打包上传，可下载原始 zip。',
  },
  {
    url: 'https://example.com/gallery/{kw}',
    title: '{kw} 图集（自建站）',
    snippet: '自建图集站直接镜像了整本返图，站方联系邮箱在页面底部。',
  },
  {
    url: 'http://127.0.0.1:8080/admin?ref={kw}',
    title: '内网地址：不该出现在检索结果里',
    snippet: '用于验证 SSRF 闸门把这条丢掉。',
  },
  {
    url: 'ftp://files.example.com/{kw}.zip',
    title: '非法协议条目',
    snippet: '非 http(s)，同样应被丢掉。',
  },
];

/**
 * 页面元数据替身：真后端把规范化后的 URL 交给 `crawl4ai-skill crawl` 回读 Markdown，
 * 再取标题与首段。浏览器里跑不了外部命令，这里只按「平台名 + 路径末段」拼一个标题，
 * 摘要一律留空——留空正是后端读不到页面时的真实行为，此时由超管自己填。
 */
function fakePageMeta(target: SafeUrl): { title: string; description: string } {
  const slug = decodeURIComponent(new URL(target.url).pathname.split('/').filter(Boolean).pop() ?? '');
  const head = CRAWLER_PLATFORM_LABEL[platformOf(target.domain)];
  return { title: slug ? `${head} · ${slug.slice(0, 48)}` : head, description: '' };
}

function rotationOf(keyword: string): number {
  let h = 0;
  for (const ch of keyword) h = (h * 31 + ch.codePointAt(0)!) % 9973;
  return h;
}

// ---------------- 登记表 ----------------

/** 行形状与 CrawlerLinkView 一致；去重直接用规范化 url，后端的 sha256 url_hash 是同一件事的落库形态 */
const LINKS: CrawlerLinkView[] = [
  {
    id: 1,
    url: 'https://weibo.com/ttarticle/p/show?id=2309405012345678901234',
    title: '「夏日场照」整本图集搬运，出处只字未提',
    snippet: '转载方把工作室返图拆成九宫格发布，评论区有人指出原图带水印被裁掉了。',
    domain: 'weibo.com',
    platform: Platform.Weibo,
    keyword: '夏日场照',
    source: 'search',
    status: Status.Noted,
    note: '已存整页截图，等超管决定是否走平台投诉。',
    createUid: 1,
    auditUid: 1,
    auditTime: '2026-09-21T02:30:00.000Z',
    createTime: '2026-09-20T09:12:00.000Z',
  },
  {
    id: 2,
    url: 'https://www.bilibili.com/opus/876543210987654321',
    title: '国风 cos 后期合集（自存）',
    snippet: '动态里写了「图源网络」，实际用的全是本次返图，未联系过本人。',
    domain: 'bilibili.com',
    platform: Platform.Bilibili,
    keyword: '国风返图',
    source: 'search',
    status: Status.Contacted,
    note: '已私信 UP，同意补出处并保留，链接已更新。',
    createUid: 1,
    auditUid: 1,
    auditTime: '2026-09-24T11:20:00.000Z',
    createTime: '2026-09-22T13:40:00.000Z',
  },
  {
    id: 3,
    url: 'https://www.xiaohongshu.com/explore/65a1b2c3d4e5f60789abcdef',
    title: '超还原的猫系少女 ｜附全套场照',
    snippet: '笔记正文把 42 张场照说成「朋友拍的」，EXIF 与工作室样片一致。',
    domain: 'xiaohongshu.com',
    platform: Platform.Xiaohongshu,
    keyword: '猫系少女',
    source: 'search',
    status: Status.Pending,
    note: '',
    createUid: 1,
    auditUid: null,
    auditTime: null,
    createTime: '2026-09-25T04:05:00.000Z',
  },
  {
    id: 4,
    url: 'https://www.douyin.com/video/7300123456789012345',
    title: '卡点混剪，素材来自工作室返图',
    snippet: '视频素材逐帧来自返图原图，未做授权声明。',
    domain: 'douyin.com',
    platform: Platform.Douyin,
    keyword: '',
    source: 'manual',
    status: Status.Reported,
    note: '平台投诉已受理，工单号 DY20260926-0117。',
    createUid: 1,
    auditUid: 1,
    auditTime: '2026-09-26T08:00:00.000Z',
    createTime: '2026-09-26T01:30:00.000Z',
  },
  {
    id: 5,
    url: 'https://www.pixiv.net/artworks/123456789',
    title: '同人企划收录页（参考图打包）',
    snippet: '页面把工作室的场地照作为参考图打包上传，可下载原始 zip。',
    domain: 'pixiv.net',
    platform: Platform.Other,
    keyword: '',
    source: 'manual',
    status: Status.Ignored,
    note: '与本工作室无关，重名而已。',
    createUid: 1,
    auditUid: 1,
    auditTime: '2026-09-28T06:10:00.000Z',
    createTime: '2026-09-27T15:20:00.000Z',
  },
];

let linkSeq = LINKS.reduce((max, row) => Math.max(max, row.id), 0);

function linkById(id: number): CrawlerLinkView {
  const row = LINKS.find((l) => l.id === id);
  if (!row) fail(404, 'NOT_FOUND', '登记记录不存在');
  return row;
}

/** 整组路由的闸门：错误码位与 crawler.service.ts 的 uidOf 逐字一致 */
function requireSuper(actor: Actor): MemberActor {
  if (actor.kind !== 'member') fail(403, 'ADMIN_REQUIRED', '仅正式成员可登记站外来源');
  if (actor.level < UserLevel.SuperAdmin) fail(403, 'LEVEL_FORBIDDEN', '爬虫仅超级管理员可用');
  return actor;
}

function assertStatus(value: unknown): CrawlerLinkStatus {
  const n = Number(value);
  if (![0, 1, 2, 3, 4].includes(n)) fail(400, 'VALIDATION_FAILED', 'status 只能是 0 / 1 / 2 / 3 / 4');
  return n as CrawlerLinkStatus;
}

// ---------------- 六个接口 ----------------

export function crawlerSearch(body: Record<string, unknown>, actor: Actor): CrawlerSearchResult {
  const me = requireSuper(actor);
  const keyword = assertKeyword(String(body.keyword ?? ''));
  const limit = clampLimit(body.limit);

  const rotation = rotationOf(keyword);
  const raw: PoolRow[] = [];
  for (let i = 0; i < POOL.length && raw.length < limit; i += 1) {
    const row = POOL[(i + rotation) % POOL.length];
    raw.push({ url: row.url.replace(/\{kw\}/g, keyword), title: row.title.replace(/\{kw\}/g, keyword), snippet: row.snippet });
  }

  const kept: Array<{ row: PoolRow; target: SafeUrl }> = [];
  let dropped = 0;
  for (const row of raw) {
    try {
      kept.push({ row, target: toSafeUrl(row.url) });
    } catch {
      // 检索源偶尔带回内网或畸形地址：跳过这一条，而不是让整次检索失败
      dropped += 1;
    }
  }

  const hits: CrawlerSearchHitView[] = kept.map(({ row, target }) => {
    const existing = LINKS.find((l) => l.url === target.url);
    return {
      url: target.url,
      title: row.title,
      snippet: row.snippet,
      domain: target.domain,
      platform: platformOf(target.domain),
      registered: !!existing,
      linkId: existing?.id ?? null,
    };
  });

  writeLog(me, 'crawler_searched', 'crawler', null, `${keyword} 命中 ${hits.length} 条，丢弃 ${dropped} 条`);
  return { keyword, limit, fetched: raw.length, dropped, hits };
}

/** 只读回标题与首段文本，不下载任何文件字节 */
export function crawlerProbe(body: Record<string, unknown>, actor: Actor): CrawlerProbeResult {
  const me = requireSuper(actor);
  const raw = String(body.url ?? '').trim();
  if (raw.length > MAX_URL_LENGTH) fail(400, 'URL_TOO_LONG', `地址最长 ${MAX_URL_LENGTH} 字符`);
  const target = toSafeUrl(raw);
  const meta = fakePageMeta(target);
  const existing = LINKS.find((l) => l.url === target.url);
  writeLog(me, 'crawler_probed', 'crawler', null, target.url.slice(0, 300));
  return {
    url: target.url,
    domain: target.domain,
    platform: platformOf(target.domain),
    title: meta.title.slice(0, 255),
    description: meta.description.slice(0, 500),
    registered: !!existing,
    linkId: existing?.id ?? null,
  };
}

export function crawlerList(query: Record<string, unknown> | undefined, actor: Actor): Page<CrawlerLinkView> {
  requireSuper(actor);
  const status = query?.status === undefined || query.status === '' ? undefined : assertStatus(query.status);
  const platform = str(query?.platform) as CrawlerPlatform | undefined;
  if (platform && !CRAWLER_PLATFORMS.includes(platform)) fail(400, 'VALIDATION_FAILED', 'platform 不合法');
  const q = (str(query?.q) ?? '').toLowerCase();

  const rows = LINKS.filter(
    (row) =>
      (status === undefined || row.status === status) &&
      (!platform || row.platform === platform) &&
      (!q || `${row.title} ${row.url} ${row.domain}`.toLowerCase().includes(q)),
  ).sort((a, b) => b.createTime.localeCompare(a.createTime));

  return paged(rows.map((row) => ({ ...row })), int(query?.page, 1), Math.min(int(query?.pageSize, 20), 100));
}

export function crawlerCreate(body: Record<string, unknown>, actor: Actor): CrawlerLinkView {
  const me = requireReauth(requireSuper(actor));
  const url = String(body.url ?? '').trim();
  if (url.length > MAX_URL_LENGTH) fail(400, 'URL_TOO_LONG', `地址最长 ${MAX_URL_LENGTH} 字符`);
  const target = toSafeUrl(url);

  const existing = LINKS.find((l) => l.url === target.url);
  if (existing) fail(409, 'LINK_EXISTS', '该链接已登记', { id: existing.id, status: existing.status });

  const keyword = String(body.keyword ?? '').trim().slice(0, 100);
  const row: CrawlerLinkView = {
    id: (linkSeq += 1),
    url: target.url,
    title: String(body.title ?? '').trim().slice(0, 255),
    snippet: String(body.snippet ?? '').trim().slice(0, 500),
    domain: target.domain,
    platform: platformOf(target.domain),
    keyword,
    // 带关键词的一律归「检索」，与后端同一口径：这一位只说明条目是怎么来的，不影响任何权限
    source: keyword ? 'search' : 'manual',
    status: Status.Pending,
    note: '',
    createUid: me.uid,
    auditUid: null,
    auditTime: null,
    createTime: new Date().toISOString(),
  };
  LINKS.push(row);
  writeLog(me, 'crawler_link_created', 'crawler', row.id, row.url.slice(0, 300));
  return { ...row };
}

export function crawlerUpdate(id: number, body: Record<string, unknown>, actor: Actor): CrawlerLinkView {
  const me = requireReauth(requireSuper(actor));
  const row = linkById(id);
  const before = row.status;
  row.status = assertStatus(body.status);
  if (body.note !== undefined) row.note = String(body.note ?? '').trim().slice(0, 500);
  row.auditUid = me.uid;
  row.auditTime = new Date().toISOString();
  writeLog(me, 'crawler_link_status', 'crawler', row.id, `${before} → ${row.status}`);
  return { ...row };
}

export function crawlerRemove(id: number, actor: Actor): { id: number; removed: true } {
  requireReauth(requireSuper(actor));
  const row = linkById(id);
  LINKS.splice(LINKS.indexOf(row), 1);
  writeLog(actor, 'crawler_link_removed', 'crawler', id, row.url.slice(0, 300));
  return { id, removed: true };
}
