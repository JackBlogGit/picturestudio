import { ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import { TempAccount, User } from '../../entities';
import { AuditService, RequestContext } from '../../modules/audit/audit.service';
import { ActorKind, TempActor } from '../permission/types';
import { UserLevel } from '../enums/user-level.enum';
import { AppError } from '../http/app-error';
import { ActorGuard } from './actor.guard';
import { TokenPayload, TokenService } from './token.service';

const SECRET = 'unit-test-secret-value-not-used-anywhere-else';

interface FakeRequest {
  headers: Record<string, string>;
  ip?: string;
  params: Record<string, string>;
  actor?: unknown;
  auditCtx?: RequestContext;
  tokenPayload?: TokenPayload;
}

function contextFor(raw: string | null): { ctx: ExecutionContext; req: FakeRequest } {
  const req: FakeRequest = {
    headers: raw ? { authorization: `Bearer ${raw}`, 'user-agent': 'jest' } : {},
    ip: '203.0.113.9',
    params: {},
  };
  const ctx = {
    getHandler: () => undefined,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

function userRow(over: Partial<User> = {}): User {
  return {
    id: 100,
    username: 'shooter',
    nickname: '摄影师',
    level: UserLevel.Member,
    status: 1,
    spaceQuota: '0',
    usedSpace: '1024',
    ...over,
  } as unknown as User;
}

function tempRow(over: Partial<TempAccount> = {}): TempAccount {
  return {
    id: 7,
    ownerUid: 3,
    displayName: 'XX漫展外聘-张三',
    expireTime: new Date(Date.now() + 3_600_000),
    disabled: 0,
    allowPreview: 1,
    allowDownload: 0,
    allowEditTag: 0,
    spaceQuota: '5368709120',
    usedSpace: '1048576',
    albumGrants: [{ albumId: 10 }, { albumId: 11 }],
    folderGrants: [{ folderId: 1 }],
    ...over,
  } as unknown as TempAccount;
}

function build(rows: { user?: User | null; temp?: TempAccount | null }, ttlSec = 900) {
  const tokens = new TokenService(
    new JwtService({ secret: SECRET, signOptions: { algorithm: 'HS256' } }),
    ttlSec,
  );
  const users = { findOne: jest.fn(async () => rows.user ?? null) } as unknown as Repository<User>;
  const temps = {
    findOne: jest.fn(async () => rows.temp ?? null),
  } as unknown as Repository<TempAccount>;
  const audit = { record: jest.fn(async () => undefined) } as unknown as AuditService;
  return { tokens, users, temps, audit, guard: new ActorGuard(tokens, users, temps, audit) };
}

async function failure(guard: ActorGuard, ctx: ExecutionContext): Promise<AppError> {
  const err = await guard.canActivate(ctx).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

describe('ActorGuard：身份识别顺序（PRD 7.1）', () => {
  it('无凭证降级为游客，并留好审计上下文', async () => {
    const { guard } = build({});
    const { ctx, req } = contextFor(null);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.actor).toEqual({ kind: ActorKind.Guest });
    expect(req.auditCtx).toEqual({ ip: '203.0.113.9', ua: '' });
  });

  for (const header of [undefined, 'Token abc123', 'Bearer ', 'Basic dXNlcjpwdw==']) {
    it(`Authorization 为 ${header ?? '空'} 时不作为凭证`, async () => {
      const { guard } = build({});
      const { ctx, req } = contextFor(null);
      if (header !== undefined) req.headers.authorization = header;
      await guard.canActivate(ctx);
      expect(req.actor).toEqual({ kind: ActorKind.Guest });
    });
  }

  it('成员令牌按库内等级构建 actor：调级后旧令牌立即失去高等级', async () => {
    const { guard, tokens } = build({ user: userRow({ level: UserLevel.Member }) });
    // 令牌里写着 L4，库内已被超管降为 L2
    const raw = await tokens.signUser(100, UserLevel.SuperAdmin);
    const { ctx, req } = contextFor(raw);
    await guard.canActivate(ctx);
    expect(req.actor).toEqual({ kind: ActorKind.Member, uid: 100, level: UserLevel.Member });
  });

  it('被禁用的成员即使令牌未过期也拿不到身份', async () => {
    const { guard, tokens } = build({ user: userRow({ status: 0 }) });
    const { ctx } = contextFor(await tokens.signUser(100, UserLevel.Admin));
    const err = await failure(guard, ctx);
    expect(err.getStatus()).toBe(401);
    expect(err.code).toBe('ACCOUNT_DISABLED');
  });

  it('账号已不存在同样按 401 处理，不给越权者区分「禁用/删除」的信息', async () => {
    const { guard, tokens } = build({ user: null });
    const { ctx } = contextFor(await tokens.signUser(404, UserLevel.Trainee));
    expect((await failure(guard, ctx)).code).toBe('ACCOUNT_DISABLED');
  });

  it('伪造令牌 401 且写一条 result=0 审计', async () => {
    const { guard, audit } = build({});
    const { ctx } = contextFor('a.b.c');
    const err = await failure(guard, ctx);
    expect(err.getStatus()).toBe(401);
    expect(err.code).toBe('INVALID_TOKEN');
    expect(audit.record).toHaveBeenCalledWith(
      { kind: ActorKind.Guest },
      { ip: '203.0.113.9', ua: 'jest' },
      expect.objectContaining({ action: 'auth_failed', detail: 'invalid_token', result: 0 }),
    );
  });

  it('登出（jti 进黑名单）后的令牌立刻失效', async () => {
    const { guard, tokens } = build({ user: userRow() });
    const raw = await tokens.signUser(100, UserLevel.Member);
    tokens.revoke(tokens.verify(raw).jti);
    expect((await failure(guard, contextFor(raw).ctx)).code).toBe('TOKEN_REVOKED');
  });

  it('令牌自然到期后无法继续使用（PRD 15.10 的 JWT 部分）', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'performance'] });
    try {
      const { guard, tokens } = build({ user: userRow() }, 60);
      const raw = await tokens.signUser(100, UserLevel.Member);
      jest.advanceTimersByTime(61_000);
      expect((await failure(guard, contextFor(raw).ctx)).code).toBe('INVALID_TOKEN');
    } finally {
      jest.useRealTimers();
    }
  });

  it('临时账号：三项开关、白名单与配额全部按库内值映射', async () => {
    const { guard, tokens } = build({ temp: tempRow() });
    const { ctx, req } = contextFor(await tokens.signTemp(7));
    await guard.canActivate(ctx);
    const actor = req.actor as TempActor;
    expect(actor.kind).toBe(ActorKind.Temp);
    expect(actor.tempId).toBe(7);
    expect(actor.ownerUid).toBe(3);
    expect(actor.flags).toEqual({
      preview: true,
      download: false,
      editTag: false,
    });
    expect(actor.albumIds).toEqual([10, 11]);
    expect(actor.folderIds).toEqual([1]);
    expect(actor.quotaBytes).toBe(5368709120);
    expect(actor.usedBytes).toBe(1048576);
    expect(actor.expired).toBe(false);
    expect(actor.disabled).toBe(false);
  });

  it('临时账号到期：401 + 审计，旧 JWT 无法续命', async () => {
    const past = new Date(Date.now() - 1000);
    const { guard, tokens, audit } = build({ temp: tempRow({ expireTime: past }) });
    const { ctx } = contextFor(await tokens.signTemp(7));
    const err = await failure(guard, ctx);
    expect(err.getStatus()).toBe(401);
    expect(err.code).toBe('TEMP_EXPIRED');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: 'temp_expired_access', result: 0 }),
    );
  });

  it('管理员提前销毁（disabled=1）即刻生效', async () => {
    const { guard, tokens } = build({ temp: tempRow({ disabled: 1 }) });
    expect((await failure(guard, contextFor(await tokens.signTemp(7)).ctx)).code).toBe('TEMP_EXPIRED');
  });

  it('临时账号记录被删除 → 401 TEMP_NOT_FOUND', async () => {
    const { guard, tokens } = build({ temp: null });
    expect((await failure(guard, contextFor(await tokens.signTemp(7)).ctx)).code).toBe('TEMP_NOT_FOUND');
  });

  it('把审计上下文透传到请求上，供后续守卫写日志', async () => {
    const { guard, tokens } = build({ user: userRow() });
    const { ctx, req } = contextFor(await tokens.signUser(100, UserLevel.Member));
    await guard.canActivate(ctx);
    expect(req.auditCtx).toEqual({ ip: '203.0.113.9', ua: 'jest' });
    expect(req.tokenPayload?.kind).toBe('user');
  });

  it('按 payload.kind 分流查表：成员令牌不碰 temp_accounts，临时令牌不碰 users', async () => {
    const memberSide = build({ user: userRow(), temp: tempRow() });
    await memberSide.guard.canActivate(contextFor(await memberSide.tokens.signUser(100, UserLevel.Member)).ctx);
    expect(memberSide.users.findOne).toHaveBeenCalledTimes(1);
    expect(memberSide.temps.findOne).not.toHaveBeenCalled();

    const tempSide = build({ user: userRow(), temp: tempRow() });
    await tempSide.guard.canActivate(contextFor(await tempSide.tokens.signTemp(7)).ctx);
    expect(tempSide.temps.findOne).toHaveBeenCalledTimes(1);
    expect(tempSide.users.findOne).not.toHaveBeenCalled();
  });
});
