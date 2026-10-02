import { AppError } from '../../common/http/app-error';
import { CrawlerPlatform } from '../../entities';
import {
  assertKeyword,
  hashUrl,
  platformOf,
  registrableDomain,
  toSafeUrl,
} from './url-policy';

/** 断言错误码用：AppError 的 code 才是接口契约，message 会被改文案 */
function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
}

describe('toSafeUrl 协议与形态闸门', () => {
  it('空值、超长、非 http(s) 一律拒', () => {
    expect(codeOf(() => toSafeUrl(''))).toBe('INVALID_URL');
    expect(codeOf(() => toSafeUrl('   '))).toBe('INVALID_URL');
    expect(codeOf(() => toSafeUrl('not a url'))).toBe('INVALID_URL');
    expect(codeOf(() => toSafeUrl('javascript:alert(1)'))).toBe('INVALID_URL');
    expect(codeOf(() => toSafeUrl('file:///etc/passwd'))).toBe('INVALID_URL');
    expect(codeOf(() => toSafeUrl(`https://a.com/${'x'.repeat(1200)}`))).toBe('URL_TOO_LONG');
  });

  it('带凭据的地址拒掉：凭据会跟着链接一起写进登记表与日志', () => {
    expect(codeOf(() => toSafeUrl('https://admin:pw@example.com/p/1'))).toBe('INVALID_URL');
  });

  it('非常规端口拒：管理员手敲 127.0.0.1:3000 就变成服务端打内网', () => {
    expect(codeOf(() => toSafeUrl('https://example.com:8443/x'))).toBe('PORT_FORBIDDEN');
    expect(toSafeUrl('https://example.com:80/ok').url).toBe('https://example.com:80/ok');
    expect(toSafeUrl('http://example.com:443/ok').url).toBe('http://example.com:443/ok');
  });
});

describe('toSafeUrl 内网与保留网段（SSRF 闸门）', () => {
  const blocked = [
    'http://localhost/admin',
    'http://LOCALHOST:3000/x',
    'http://127.0.0.1/x',
    'http://127.1/x',
    'http://0.x/a',
    'http://10.1.2.3/a',
    'http://172.16.0.1/a',
    'http://172.31.255.255/a',
    'http://192.168.1.1/a',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/a',
    'http://198.18.0.1/a',
    'http://192.0.2.1/a',
    'http://203.0.113.5/a',
    'http://224.0.0.1/a',
    'http://[::1]/a',
    'http://[fe80::1]/a',
    'http://[fd00::1234]/a',
    'http://[::ffff:127.0.0.1]/a',
    'http://[::ffff:7f00:1]/a',
    'http://[::ffff:a9fe:a9fe]/a',
    'http://intranet.local/a',
    'http://nacos.internal/a',
    'http://printserver/a',
  ];

  for (const url of blocked) {
    it(`拒绝 ${url}`, () => {
      const code = codeOf(() => toSafeUrl(url));
      expect(code === 'INTERNAL_URL_FORBIDDEN' || code === 'INVALID_URL').toBe(true);
    });
  }

  it('公网 IP 字面量与正常域名放行', () => {
    expect(toSafeUrl('http://8.8.8.8/x').url).toBe('http://8.8.8.8/x');
    expect(toSafeUrl('https://example.com/').domain).toBe('example.com');
  });

  it('172.15 与 172.32 不在私网段内，不能被误杀', () => {
    expect(codeOf(() => toSafeUrl('http://172.15.0.1/a'))).toBeNull();
    expect(codeOf(() => toSafeUrl('http://172.32.0.1/a'))).toBeNull();
  });
});

describe('toSafeUrl 规范化（去重键的来路）', () => {
  it('摘掉 fragment 与跟踪参数，保留有内容的查询', () => {
    const out = toSafeUrl(
      'https://Weibo.COM/status/123?utm_source=share&spm=a_b_1&mid=999#repost',
    );
    expect(out.url).toBe('https://weibo.com/status/123?mid=999');
  });

  it('去掉路径末尾多余的斜杠，根路径保留', () => {
    expect(toSafeUrl('https://example.com/album/1/').url).toBe('https://example.com/album/1');
    expect(toSafeUrl('https://example.com').url).toBe('https://example.com/');
  });

  it('同一篇内容的两种分享地址规范化后哈希相同', () => {
    const a = toSafeUrl('https://www.bilibili.com/video/BV1xx/?share_source=copy_web#t=120');
    const b = toSafeUrl('https://WWW.bilibili.com/video/BV1xx');
    expect(hashUrl(a.url)).toBe(hashUrl(b.url));
  });

  it('参数大小写也要认：UTM_SOURCE 同样被摘', () => {
    expect(toSafeUrl('https://x.com/a?UTM_SOURCE=weibo').url).toBe('https://x.com/a');
  });
});

describe('registrableDomain 与 platformOf', () => {
  it('二级公共后缀取三段，普通域名取两段', () => {
    expect(registrableDomain('www.weibo.com')).toBe('weibo.com');
    expect(registrableDomain('m.weibo.cn')).toBe('weibo.cn');
    expect(registrableDomain('news.sina.com.cn')).toBe('sina.com.cn');
    expect(registrableDomain('space.bilibili.com')).toBe('bilibili.com');
    expect(registrableDomain('www.blog.co.uk')).toBe('blog.co.uk');
    expect(registrableDomain('8.8.8.8')).toBe('8.8.8.8');
  });

  it('平台归类覆盖五个常见站点，认不出来归 other', () => {
    expect(platformOf('weibo.com')).toBe(CrawlerPlatform.Weibo);
    expect(platformOf('weibo.cn')).toBe(CrawlerPlatform.Weibo);
    expect(platformOf('bilibili.com')).toBe(CrawlerPlatform.Bilibili);
    expect(platformOf('b23.tv')).toBe(CrawlerPlatform.Bilibili);
    expect(platformOf('xiaohongshu.com')).toBe(CrawlerPlatform.Xiaohongshu);
    expect(platformOf('xhslink.com')).toBe(CrawlerPlatform.Xiaohongshu);
    expect(platformOf('douyin.com')).toBe(CrawlerPlatform.Douyin);
    expect(platformOf('x.com')).toBe(CrawlerPlatform.Twitter);
    expect(platformOf('pixiv.net')).toBe(CrawlerPlatform.Other);
  });

  it('相似后缀不算命中：notweibo.com 归 other 而不是微博', () => {
    expect(platformOf('notweibo.com')).toBe(CrawlerPlatform.Other);
  });
});

describe('assertKeyword', () => {
  it('去空格后要求 2~50 字符', () => {
    expect(assertKeyword('  CP30 返图  ')).toBe('CP30 返图');
    expect(codeOf(() => assertKeyword('图'))).toBe('KEYWORD_TOO_SHORT');
    expect(codeOf(() => assertKeyword('字'.repeat(51)))).toBe('KEYWORD_TOO_LONG');
  });
});
