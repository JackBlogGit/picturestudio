import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserLevel } from '../enums/user-level.enum';

export const ACCESS_TOKEN_TTL_SEC = 'ACCESS_TOKEN_TTL_SEC';

export interface TokenPayload {
  /** 'u:<id>' 正式成员 / 'tp:<id>' 临时账号 */
  sub: string;
  kind: 'user' | 'temp';
  level?: UserLevel;
  jti: string;
}

@Injectable()
export class TokenService {
  /** 进程内黑名单：多实例部署时必须换成 Redis 实现，否则登出只在单个 worker 生效 */
  private readonly revoked = new Map<string, number>();

  constructor(
    private readonly jwt: JwtService,
    @Inject(ACCESS_TOKEN_TTL_SEC) private readonly accessTtlSec: number,
  ) {}

  signUser(uid: number, level: UserLevel): Promise<string> {
    return this.sign({ sub: `u:${uid}`, kind: 'user', level });
  }

  signTemp(tempId: number): Promise<string> {
    return this.sign({ sub: `tp:${tempId}`, kind: 'temp' });
  }

  verify(raw: string): TokenPayload {
    return this.jwt.verify<TokenPayload>(raw);
  }

  /** 撤销只需存活到原 token 自然过期，因此保留时长直接取访问令牌 TTL */
  revoke(jti: string): void {
    this.revoked.set(jti, Date.now() + this.accessTtlSec * 1000);
  }

  isRevoked(jti: string | undefined): boolean {
    if (!jti) return false;
    const until = this.revoked.get(jti);
    if (!until) return false;
    if (until <= Date.now()) {
      this.revoked.delete(jti);
      return false;
    }
    return true;
  }

  private sign(payload: Omit<TokenPayload, 'jti'>): Promise<string> {
    return this.jwt.signAsync(
      { ...payload, jti: randomBytes(12).toString('hex') },
      { expiresIn: this.accessTtlSec },
    );
  }
}
