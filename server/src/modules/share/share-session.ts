import { createHmac, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Env } from '../../config/env.config';

export const SHARE_COOKIE = 'pk_share';
export const SHARE_SUBSESSION_TTL_SEC = 2 * 3600;
/** 与成员令牌同密钥但不同用途，跨通道用不了：分享子会话塞进 Authorization 头只会验签失败 */
const SESSION_AUD = 'share-session';
const COOKIE_PAIR = new RegExp(`(?:^|;\\s*)${SHARE_COOKIE}=([^;]+)`);

/**
 * 链接口令的子会话：口令校验通过后签发一条 2 小时的 HttpOnly Cookie，
 * Path 收窄到本条链接的公开路由下，避免一次解锁变成整站的登录态（PRD 10.3）。
 */
@Injectable()
export class ShareSessionService {
  private readonly secret: string;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    const env = config.getOrThrow<Env>('app');
    this.secret = createHmac('sha256', env.jwt.secret).update(SESSION_AUD).digest('hex');
  }

  issue(shareToken: string): Promise<string> {
    return this.jwt.signAsync(
      { sub: shareToken, kind: SESSION_AUD, jti: randomBytes(12).toString('hex') },
      { secret: this.secret, algorithm: 'HS256', expiresIn: SHARE_SUBSESSION_TTL_SEC },
    );
  }

  /** payload 里的 token 必须与路由参数一致，否则一条链接的解锁态能刷开另一条 */
  async isValid(raw: string | undefined, shareToken: string): Promise<boolean> {
    if (!raw) return false;
    try {
      const payload = await this.jwt.verifyAsync<{ sub?: string; kind?: string }>(raw, {
        secret: this.secret,
        algorithms: ['HS256'],
      });
      return payload.kind === SESSION_AUD && payload.sub === shareToken;
    } catch {
      return false;
    }
  }
}

/** 没有 cookie-parser，主链路也不打算加，所以这里手工取唯一一个会话 Cookie */
export function readShareCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const hit = COOKIE_PAIR.exec(header);
  return hit ? decodeURIComponent(hit[1]) : undefined;
}

export function shareCookiePath(shareToken: string): string {
  return `/api/v1/public/share/${encodeURIComponent(shareToken)}`;
}

export function buildShareCookie(value: string, shareToken: string, secure: boolean): string {
  const parts = [
    `${SHARE_COOKIE}=${encodeURIComponent(value)}`,
    `Path=${shareCookiePath(shareToken)}`,
    `Max-Age=${SHARE_SUBSESSION_TTL_SEC}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  // 本地开发是 http，Secure 会让 Cookie 直接被丢弃；生产走 Nginx TLS 终止才带上
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
