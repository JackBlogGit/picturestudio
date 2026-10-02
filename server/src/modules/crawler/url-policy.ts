import { createHash } from 'node:crypto';
import { AppError } from '../../common/http/app-error';
import { CrawlerPlatform } from '../../entities/crawler.entities';

/**
 * 爬虫模块的 URL 闸门（PRD D23）。两条硬约束：
 * 1. 只登记站外链接，服务端永远不碰内网——管理员手敲的 URL 也要先过这里；
 * 2. 规范化后再落库，同一篇转载换个跟踪参数不算两条。
 *
 * 这里只做语法层拦截。域名解析到内网地址（DNS rebinding）拦不住，
 * 部署时仍需用出站策略把服务端网段限制在公网。
 */

export interface SafeUrl {
  /** 规范化后的绝对地址 */
  url: string;
  host: string;
  port: number;
  domain: string;
}

/** 与 url 列同宽：超长 URL 直接拒，而不是截断成一个打不开的地址 */
export const MAX_URL_LENGTH = 1000;

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

/** 二级公共后缀：直接取末两段会把 www.com.cn 这类域名切错 */
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

function deny(reason: string, message: string): never {
  throw new AppError(400, reason, message);
}

/** 内网与保留地址：这些网段出现在服务端出站请求里，说明有人在探内部系统 */
function isPrivateIpv4(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // 链路本地 + 云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && b >= 18 && b <= 19) return true; // 基准测试
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // 组播与保留
  return false;
}

function checkIpv6(host: string): void {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  // IPv4 映射地址有两种写法：URL 规格化后是 ::ffff:7f00:1，手敲常见的是 ::ffff:127.0.0.1
  const mappedDotted = /^::ffff:((\d{1,3}\.){3}\d{1,3})$/.exec(bare);
  if (mappedDotted) {
    const parts = mappedDotted[1].split('.').map(Number);
    if (isPrivateIpv4(parts[0], parts[1], parts[2])) {
      deny('INTERNAL_URL_FORBIDDEN', '该地址指向内网或保留网段，服务器不会访问');
    }
    return;
  }
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1], 16);
    const lo = Number.parseInt(mappedHex[2], 16);
    if (isPrivateIpv4((hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff)) {
      deny('INTERNAL_URL_FORBIDDEN', '该地址指向内网或保留网段，服务器不会访问');
    }
    return;
  }
  if (bare === '::1' || bare === '::' || /^fe8/.test(bare) || /^fc/.test(bare) || /^fd/.test(bare)) {
    deny('INTERNAL_URL_FORBIDDEN', '该地址指向内网或保留网段，服务器不会访问');
  }
}

function assertPublicHost(hostname: string): void {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    deny('INTERNAL_URL_FORBIDDEN', '内网域名不予采集');
  }
  if (host.startsWith('[')) {
    checkIpv6(host);
    return;
  }
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(host)) {
    // IPv4 字面量与单标签名都走这里：单标签名只会解析到内部服务
    const m = IPV4.exec(host);
    if (!m) deny('INVALID_URL', '地址的主机名不合法');
    if (isPrivateIpv4(Number(m[1]), Number(m[2]), Number(m[3]))) {
      deny('INTERNAL_URL_FORBIDDEN', '该地址指向内网或保留网段，服务器不会访问');
    }
    return;
  }
  if (!host.includes('.')) deny('INVALID_URL', '地址缺少完整域名');
}

/** 取注册域：weibo.com、bilibili.com、www.xiaohongshu.com 这类，便于列表按站点聚合 */
export function registrableDomain(host: string): string {
  const bare = host.replace(/^\[|\]$/g, '');
  if (IPV4.test(bare)) return bare;
  const labels = bare.split('.');
  if (labels.length <= 2) return bare;
  const tail = labels.slice(-2).join('.');
  if (TWO_LEVEL_SUFFIXES.has(tail)) return labels.slice(-3).join('.');
  return tail;
}

/**
 * 校验 + 规范化：拒掉非 http(s)、带凭据、非常规端口、内网目标，
 * 再摘掉 fragment 与跟踪参数。返回的 url 即去重键与展示值。
 */
export function toSafeUrl(raw: string): SafeUrl {
  const value = String(raw ?? '').trim();
  if (!value) deny('INVALID_URL', '地址不能为空');
  if (value.length > MAX_URL_LENGTH) deny('URL_TOO_LONG', `地址最长 ${MAX_URL_LENGTH} 字符`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    deny('INVALID_URL', '地址格式不正确，请填写完整链接');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    deny('INVALID_URL', '只支持 http / https 链接');
  }
  if (parsed.username || parsed.password) deny('INVALID_URL', '地址不应包含账号凭据');
  assertPublicHost(parsed.hostname);
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    deny('PORT_FORBIDDEN', '只允许默认的 80 / 443 端口');
  }

  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) parsed.searchParams.delete(key);
  }
  parsed.hash = '';
  const query = parsed.searchParams.toString();
  let path = parsed.pathname || '/';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const url = `${parsed.protocol}//${parsed.host}${path}${query ? `?${query}` : ''}`;
  return {
    url,
    host: parsed.hostname.toLowerCase(),
    port: parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80,
    domain: registrableDomain(parsed.hostname),
  };
}

/** 去重键：规范化地址的 sha256 */
export function hashUrl(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex');
}

const PLATFORM_BY_DOMAIN: Array<[RegExp, CrawlerPlatform]> = [
  [/(^|\.)(weibo\.com|weibo\.cn)$/, CrawlerPlatform.Weibo],
  [/(^|\.)(bilibili\.com|b23\.tv)$/, CrawlerPlatform.Bilibili],
  [/(^|\.)(xiaohongshu\.com|xhslink\.com)$/, CrawlerPlatform.Xiaohongshu],
  [/(^|\.)(douyin\.com|iesdouyin\.com)$/, CrawlerPlatform.Douyin],
  [/(^|\.)(twitter\.com|x\.com|t\.co)$/, CrawlerPlatform.Twitter],
];

/** 平台归类只看注册域，认不出来一律归 other，不做黑名单式拦截 */
export function platformOf(domain: string): CrawlerPlatform {
  const host = domain.toLowerCase();
  for (const [pattern, platform] of PLATFORM_BY_DOMAIN) {
    if (pattern.test(host)) return platform;
  }
  return CrawlerPlatform.Other;
}

/** 检索词闸门：过短的词会把整站作品都捞回来，没有归档意义 */
export function assertKeyword(keyword: string): string {
  const value = String(keyword ?? '').trim();
  if (value.length < 2) deny('KEYWORD_TOO_SHORT', '检索词至少 2 个字符');
  if (value.length > 50) deny('KEYWORD_TOO_LONG', '检索词最长 50 个字符');
  return value;
}
