import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { TempAccount, User } from '../../entities';
import { AuditService, RequestContext } from '../audit/audit.service';
import { LEVEL_LABEL, UserLevel } from '../../common/enums/user-level.enum';
import { AppError } from '../../common/http/app-error';
import { Actor, ActorKind, TempActor } from '../../common/permission/types';
import { TokenService } from '../../common/auth/token.service';
import { AuthService } from './auth.service';

const SECRET = 'unit-test-secret-value-not-used-anywhere-else';
const PW = 'StartRun_2026';
const CTX: RequestContext = { ip: '198.51.100.7', ua: 'jest' };

/** 测试里用 cost=4 造库内密文，成本只影响速度不影响校验；被测代码自己签发的密文仍是 cost=12 */
async function cheapHash(plain: string): Promise<string> {
  return bcrypt.hash(plain, 4);
}

function userRow(over: Partial<User> = {}): User {
  return {
    id: 100,
    username: 'shooter',
    nickname: '摄影师',
    level: UserLevel.Member,
    status: 1,
    spaceQuota: '0',
    usedSpace: '1048576',
    lastLoginTime: null,
    ...over,
  } as unknown as User;
}

function tempRow(over: Partial<TempAccount> = {}): TempAccount {
  return {
    id: 7,
    accountNo: 'YK8FZ3XC',
    loginName: 'guest-shooter',
    displayName: 'XX漫展外聘-张三',
    ownerUid: 3,
    expireTime: new Date(Date.now() + 3_600_000),
    disabled: 0,
    allowPreview: 1,
    allowDownload: 0,
    allowEditTag: 0,
    spaceQuota: '5368709120',
    usedSpace: '1048576',
    albumGrants: [{ albumId: 10 }],
    folderGrants: [{ folderId: 1 }],
    ...over,
  } as unknown as TempAccount;
}

function chain(row: unknown): { addSelect: () => any; where: () => any; getOne: jest.Mock; wheres: Array<[string, unknown]> } {
  const qb: any = {
    addSelect: () => qb,
    wheres: [] as Array<[string, unknown]>,
    where: (sql: string, params: unknown) => {
      qb.wheres.push([sql, params]);
      return qb;
    },
    getOne: jest.fn(async () => row),
  };
  return qb;
}

function build(rows: { user?: unknown; temp?: unknown } = {}) {
  const usersQb = chain(rows.user ?? null);
  const tempsQb = chain(rows.temp ?? null);
  const users = {
    createQueryBuilder: jest.fn(() => usersQb),
    findOne: jest.fn(async () => rows.user ?? null),
    save: jest.fn(async (e: unknown) => e),
  } as unknown as Repository<User>;
  const temps = {
    createQueryBuilder: jest.fn(() => tempsQb),
    findOne: jest.fn(async () => rows.temp ?? null),
    save: jest.fn(async (e: unknown) => e),
    update: jest.fn(async () => ({ affected: 1 })),
  } as unknown as Repository<TempAccount>;
  const tokens = new TokenService(
    new JwtService({ secret: SECRET, signOptions: { algorithm: 'HS256' } }),
    900,
  );
  const audit = { record: jest.fn(async () => undefined) } as unknown as AuditService;
  return {
    users,
    temps,
    usersQb,
    tempsQb,
    update: temps.update as unknown as jest.Mock,
    tokens,
    audit,
    service: new AuthService(users, temps, tokens, audit),
  };
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

const memberActor = (uid = 100, level = UserLevel.Member): Actor => ({
  kind: ActorKind.Member,
  uid,
  level,
});

const tempActor = (over: Partial<TempActor> = {}): Actor => ({
  kind: ActorKind.Temp,
  tempId: 7,
  ownerUid: 3,
  expired: false,
  disabled: false,
  flags: { preview: true, download: false, editTag: false },
  quotaBytes: 0,
  usedBytes: 0,
  albumIds: [10],
  folderIds: [1],
  ...over,
});

describe('AuthService.login：正式成员', () => {
  it('密码正确即签发可验证的成员令牌，并回写最后登录时间', async () => {
    const hash = await cheapHash(PW);
    const t = build({ user: userRow({ password: hash }) });

    const result = await t.service.login('shooter', PW, CTX);

    expect(result.identity).toEqual({
      kind: 'user',
      uid: 100,
      username: 'shooter',
      nickname: '摄影师',
      level: UserLevel.Member,
    });
    const payload = t.tokens.verify(result.accessToken);
    expect(payload).toMatchObject({ sub: 'u:100', kind: 'user', level: UserLevel.Member });
    expect(t.users.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 100, lastLoginTime: expect.any(Date) }),
    );
    expect(t.audit.record).not.toHaveBeenCalled();
  });

  it('密码错误只回 401，不区分「账号不存在」与「密码错」，并落 result=0 审计', async () => {
    const hash = await cheapHash(PW);
    const t = build({ user: userRow({ password: hash }) });
    const err = await failure(t.service.login('shooter', 'wrong-password', CTX));
    expect(err.getStatus()).toBe(401);
    expect(err.code).toBe('BAD_CREDENTIALS');
    expect(t.audit.record).toHaveBeenCalledWith(
      { kind: ActorKind.Guest },
      CTX,
      expect.objectContaining({ action: 'login_failed', detail: 'bad_password', result: 0 }),
    );
  });

  it('账号被禁用：密码对也不给令牌', async () => {
    const hash = await cheapHash(PW);
    const t = build({ user: userRow({ password: hash, status: 0 }) });
    const err = await failure(t.service.login('shooter', PW, CTX));
    expect(err.getStatus()).toBe(403);
    expect(err.code).toBe('ACCOUNT_DISABLED');
  });

  it('两类账号都查不到 → 401 unknown_account', async () => {
    const t = build();
    const err = await failure(t.service.login('nobody', PW, CTX));
    expect(err.getStatus()).toBe(401);
    expect(t.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ detail: 'unknown_account', result: 0 }),
    );
  });

  it('命名空间撞车时正式成员优先（临时账号需避开正式账号名）', async () => {
    const hash = await cheapHash(PW);
    const t = build({
      user: userRow({ username: 'dup', password: hash }),
      temp: tempRow({ loginName: 'dup', password: hash }),
    });
    const result = await t.service.login('dup', PW, CTX);
    expect(result.identity.kind).toBe('user');
  });
});

describe('AuthService.login：临时账号', () => {
  it('用 login_name + 密码登录，令牌不带 level', async () => {
    const hash = await cheapHash(PW);
    const t = build({ temp: tempRow({ password: hash }) });

    const result = await t.service.login('guest-shooter', PW, CTX);

    expect(result.identity.kind).toBe('temp');
    const payload = t.tokens.verify(result.accessToken);
    expect(payload.kind).toBe('temp');
    expect(payload.sub).toBe('tp:7');
  });

  it('免密临时账号不能用密码登录：免密只对 access_token 链接生效（D4）', async () => {
    const t = build({ temp: tempRow({ password: null }) });
    const err = await failure(t.service.login('guest-shooter', PW, CTX));
    expect(err.getStatus()).toBe(401);
    expect(err.code).toBe('BAD_CREDENTIALS');
  });

  it('到期或被提前销毁的账号无法再登录', async () => {
    const hash = await cheapHash(PW);
    const expired = build({
      temp: tempRow({ password: hash, expireTime: new Date(Date.now() - 1) }),
    });
    expect((await failure(expired.service.login('guest-shooter', PW, CTX))).code).toBe('TEMP_EXPIRED');

    const destroyed = build({ temp: tempRow({ password: hash, disabled: 1 }) });
    expect((await failure(destroyed.service.login('guest-shooter', PW, CTX))).code).toBe('TEMP_EXPIRED');
    expect(destroyed.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: 'temp_expired_access', result: 0 }),
    );
  });

  it('用例 22：查询条件同时容纳 login_name 与帐户ID', async () => {
    const hash = await cheapHash(PW);
    const t = build({ temp: tempRow({ password: hash }) });
    const result = await t.service.login('YK8FZ3XC', PW, CTX);
    expect(result.identity).toMatchObject({ kind: 'temp', tempId: 7 });

    const sql = String(t.tempsQb.wheres[0][0]);
    expect(sql).toContain('t.loginName');
    expect(sql).toContain('t.accountNo');
    expect(t.tempsQb.wheres[0][1]).toEqual({ name: 'YK8FZ3XC' });
  });

  it('用例 22：密码错与帐户ID 不存在回同一个 401，不给枚举线索', async () => {
    const wrongPass = build({ temp: tempRow({ password: await cheapHash(PW) }) });
    const bad = await failure(wrongPass.service.login('YK8FZ3XC', 'wrong-password', CTX));
    const unknown = await failure(build().service.login('YKZZZZZZ', PW, CTX));
    expect(bad.getStatus()).toBe(401);
    expect(unknown.getStatus()).toBe(401);
    expect(bad.code).toBe(unknown.code);
  });
});

describe('AuthService.tempDestroy：D15 自助销毁', () => {
  const tail = '8FZ3XC';

  it('L1–L4 调用一律 403', async () => {
    const t = build();
    const err = await failure(t.service.tempDestroy(memberActor(), tail, 'jti-1', CTX));
    expect([err.getStatus(), err.code]).toEqual([403, 'TEMP_ONLY']);
    expect(t.update).not.toHaveBeenCalled();
  });

  it('未登录 401', async () => {
    const t = build();
    const err = await failure(t.service.tempDestroy({ kind: ActorKind.Guest }, tail, undefined, CTX));
    expect(err.getStatus()).toBe(401);
  });

  it('用例 29：后 6 位不符 → 400，状态不变且留 result=0 审计', async () => {
    const t = build({ temp: tempRow() });
    const err = await failure(t.service.tempDestroy(tempActor(), 'WRONG6', 'jti-1', CTX));
    expect([err.getStatus(), err.code]).toEqual([400, 'CONFIRM_MISMATCH']);
    expect(t.update).not.toHaveBeenCalled();
    expect(t.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: 'temp_self_destroy', result: 0 }),
    );
  });

  it('用例 29：正确提交 → disabled=1、令牌进黑名单、写 temp_self_destroy，资源不动', async () => {
    const t = build({ temp: tempRow() });
    const spy = jest.spyOn(t.tokens, 'revoke');

    await expect(t.service.tempDestroy(tempActor(), tail.toLowerCase(), 'jti-1', CTX)).resolves.toEqual({
      destroyed: true,
    });

    expect(t.update).toHaveBeenCalledWith({ id: 7 }, { disabled: 1 });
    expect(spy).toHaveBeenCalledWith('jti-1');
    expect(t.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: 'temp_self_destroy', targetId: 7 }),
    );
    /** 只传帐户ID：手机号等 PII 不该出现在 logs.detail */
    expect(String((t.audit.record as unknown as jest.Mock).mock.calls[0][2].detail)).not.toContain('138');
  });

  it('已注销账号重复调用不再二次写库，但仍撤销令牌', async () => {
    const t = build({ temp: tempRow({ disabled: 1 }) });
    const spy = jest.spyOn(t.tokens, 'revoke');
    await expect(t.service.tempDestroy(tempActor(), tail, 'jti-2', CTX)).resolves.toEqual({
      destroyed: true,
    });
    expect(t.update).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith('jti-2');
  });

  it('账号行已被清理时 401，而不是 500', async () => {
    const t = build({ temp: null });
    const err = await failure(t.service.tempDestroy(tempActor(), tail, 'jti-1', CTX));
    expect([err.getStatus(), err.code]).toEqual([401, 'TEMP_NOT_FOUND']);
  });
});

describe('AuthService.loginByAccessToken：一次性专属链接', () => {
  it('链接令牌不存在 → 404，不暴露曾否有效', async () => {
    const t = build();
    expect((await failure(t.service.loginByAccessToken('nope', undefined, CTX))).getStatus()).toBe(404);
  });

  it('免密链接直接换取会话', async () => {
    const t = build({ temp: tempRow({ accessToken: 'link-token', password: null }) });
    const result = await t.service.loginByAccessToken('link-token', undefined, CTX);
    expect(result.identity).toMatchObject({ kind: 'temp', tempId: 7 });
  });

  it('链接设了访问密码：缺失与错误都是 401', async () => {
    const hash = await cheapHash(PW);
    const missing = build({ temp: tempRow({ accessToken: 'tk', password: hash }) });
    expect((await failure(missing.service.loginByAccessToken('tk', undefined, CTX))).code).toBe('BAD_CREDENTIALS');

    const wrong = build({ temp: tempRow({ accessToken: 'tk', password: hash }) });
    expect(
      (await failure(wrong.service.loginByAccessToken('tk', 'not-the-password', CTX))).code,
    ).toBe('BAD_CREDENTIALS');
    expect(wrong.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ detail: 'bad_password', result: 0 }),
    );
  });

  it('密码正确但账号已到期 → 仍然 401', async () => {
    const hash = await cheapHash(PW);
    const t = build({
      temp: tempRow({
        accessToken: 'tk',
        password: hash,
        expireTime: new Date(Date.now() - 1),
      }),
    });
    expect((await failure(t.service.loginByAccessToken('tk', PW, CTX))).code).toBe('TEMP_EXPIRED');
  });
});

describe('AuthService.logout / changePassword / profile', () => {
  it('登出把 jti 加入黑名单，令牌当场失效', () => {
    const t = build();
    // 断言 revoke 被调用即可；令牌本身由 TokenService 的用例覆盖
    const spy = jest.spyOn(t.tokens, 'revoke');
    t.service.logout(memberActor(), 'jti-abc');
    expect(spy).toHaveBeenCalledWith('jti-abc');
    t.service.logout(memberActor(), undefined);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('游客不能改密码', async () => {
    const t = build();
    const err = await failure(
      t.service.changePassword({ kind: ActorKind.Guest }, PW, 'BrandNew_2026'),
    );
    expect(err.getStatus()).toBe(401);
  });

  it('新密码不足 8 位 → 400，且不查库', async () => {
    const t = build({ user: userRow() });
    const err = await failure(t.service.changePassword(memberActor(), PW, 'short'));
    expect(err.getStatus()).toBe(400);
    expect(err.code).toBe('WEAK_PASSWORD');
    expect(t.users.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('原密码不对 → 401，密码不回写', async () => {
    const t = build({ user: userRow({ password: await cheapHash(PW) }) });
    const err = await failure(
      t.service.changePassword(memberActor(), 'not-the-password', 'BrandNew_2026'),
    );
    expect(err.getStatus()).toBe(401);
    expect(t.users.save).not.toHaveBeenCalled();
  });

  it('改密成功后落库的是 bcrypt cost=12 密文（PRD 9 强制）', async () => {
    const t = build({ user: userRow({ password: await cheapHash(PW) }) });
    await t.service.changePassword(memberActor(), PW, 'BrandNew_2026');

    const saved = (t.users.save as unknown as jest.Mock).mock.calls[0][0] as User;
    const stored = String(saved.password);
    expect(stored).toMatch(/^\$2[aby]\$12\$/);
    await expect(bcrypt.compare('BrandNew_2026', stored)).resolves.toBe(true);
    await expect(bcrypt.compare(PW, stored)).resolves.toBe(false);
  });

  it('免密临时账号可补设密码，原密码校验跳过', async () => {
    const t = build({ temp: tempRow({ password: null }) });
    await t.service.changePassword(
      tempActor(),
      '',
      'AddedPass_2026',
    );
    const saved = (t.temps.save as unknown as jest.Mock).mock.calls[0][0] as TempAccount;
    await expect(bcrypt.compare('AddedPass_2026', String(saved.password))).resolves.toBe(true);
  });

  it('成员资料带等级名、配额数字与前端能力位', async () => {
    const t = build({ user: userRow({ level: UserLevel.Trainee, spaceQuota: '1073741824' }) });
    const profile = await t.service.profile(memberActor(100, UserLevel.Trainee));
    expect(profile).toEqual({
      kind: 'user',
      uid: 100,
      username: 'shooter',
      nickname: '摄影师',
      level: UserLevel.Trainee,
      levelName: LEVEL_LABEL[UserLevel.Trainee],
      spaceQuota: 1073741824,
      usedSpace: 1048576,
      capabilities: expect.objectContaining({ download: false, shareLink: false, upload: true }),
    });
  });

  it('临时账号资料回显白名单与开关，不回显密码字段', async () => {
    const t = build({ temp: tempRow({ password: await cheapHash(PW) }) });
    const profile = await t.service.profile(
      tempActor(),
    );
    expect(profile).toMatchObject({
      kind: 'temp',
      tempId: 7,
      displayName: 'XX漫展外聘-张三',
      ownerUid: 3,
      allowedAlbumIds: [10],
      allowedFolderIds: [1],
      spaceQuota: 5368709120,
    });
    expect(JSON.stringify(profile)).not.toContain('$2');
  });

  it('游客无资料可取 → 401', async () => {
    const t = build();
    expect((await failure(t.service.profile({ kind: ActorKind.Guest }))).getStatus()).toBe(401);
  });

  it('账号被删除后 profile 也拿不到身份', async () => {
    const t = build({ user: null });
    expect((await failure(t.service.profile(memberActor()))).code).toBe('ACCOUNT_DISABLED');
  });
});
