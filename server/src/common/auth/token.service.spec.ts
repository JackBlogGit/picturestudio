import { JwtService } from '@nestjs/jwt';
import { UserLevel } from '../enums/user-level.enum';
import { TokenService } from './token.service';

const SECRET = 'unit-test-secret-value-not-used-anywhere-else';

function makeService(ttlSec = 900): TokenService {
  return new TokenService(new JwtService({ secret: SECRET, signOptions: { algorithm: 'HS256' } }), ttlSec);
}

describe('TokenService', () => {
  it('签发的成员令牌可回解，sub/kind/level/jti 齐全', () => {
    const svc = makeService();
    return svc.signUser(100, UserLevel.Member).then((raw) => {
      const payload = svc.verify(raw);
      expect(payload).toMatchObject({ sub: 'u:100', kind: 'user', level: UserLevel.Member });
      expect(payload.jti).toHaveLength(24);
    });
  });

  it('临时账号令牌不带 level，sub 前缀可反解出 tempId', () => {
    const svc = makeService();
    return svc.signTemp(7).then((raw) => {
      const payload = svc.verify(raw);
      expect(payload.kind).toBe('temp');
      expect(payload.level).toBeUndefined();
      expect(Number(payload.sub.slice(3))).toBe(7);
    });
  });

  it('有效期由注入的秒数决定，不使用字符串时长', () => {
    const svc = makeService(120);
    return svc.signUser(1, UserLevel.Admin).then((raw) => {
      const { iat = 0, exp = 0 } = svc.verify(raw) as unknown as { iat?: number; exp?: number };
      expect(exp - iat).toBe(120);
    });
  });

  it('两次签名的 jti 不同，登出只撤销被登出的那一个', async () => {
    const svc = makeService();
    const first = svc.verify(await svc.signUser(100, UserLevel.Member));
    const second = svc.verify(await svc.signUser(100, UserLevel.Member));
    expect(first.jti).not.toBe(second.jti);

    svc.revoke(first.jti);
    expect(svc.isRevoked(first.jti)).toBe(true);
    expect(svc.isRevoked(second.jti)).toBe(false);
    expect(svc.isRevoked(undefined)).toBe(false);
  });

  it('撤销记录在令牌自然过期后自动清理，黑名单不会无限增长', () => {
    jest.useFakeTimers();
    try {
      const svc = makeService(60);
      svc.revoke('jti-x');
      expect(svc.isRevoked('jti-x')).toBe(true);
      jest.advanceTimersByTime(61_000);
      expect(svc.isRevoked('jti-x')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('篡改过的令牌验签失败，交由守卫转成 401', () => {
    const svc = makeService();
    return svc.signUser(100, UserLevel.Member).then((raw) => {
      expect(() => svc.verify(`${raw}x`)).toThrow();
    });
  });

  it('密钥不同的服务无法解出对方签发的令牌', async () => {
    const a = makeService();
    const b = new TokenService(new JwtService({ secret: 'another-secret-value-another-secret' }), 900);
    const raw = await a.signUser(100, UserLevel.Member);
    expect(() => b.verify(raw)).toThrow();
  });
});
