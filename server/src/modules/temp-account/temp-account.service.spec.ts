import { TempAccount, User } from '../../entities';
import { UserLevel } from '../../common/enums/user-level.enum';
import { AppError } from '../../common/http/app-error';
import { Actor, ActorKind } from '../../common/permission/types';
import { ACCOUNT_NO_REGEX } from '../../common/temp-account/account-no';
import { SettingsService } from '../settings/settings.service';
import { AuthService } from '../auth/auth.service';
import { AuditService, RequestContext } from '../audit/audit.service';
import { CreateTempAccountDto, ListTempAccountDto } from './dto/temp-account.dto';
import { MAX_DAYS_FOR_ADMIN, TempAccountService, applyCreateLimits } from './temp-account.service';

const CTX: RequestContext = { ip: '10.0.0.9', ua: 'jest' };
const SELF = 100;
const OTHER = 200;
const DEFAULT_QUOTA = 10 * 1024 ** 3;
const DAY_MS = 86_400_000;

function member(level: UserLevel, uid = SELF): Actor {
  return { kind: ActorKind.Member, uid, level };
}

const tempActor: Actor = {
  kind: ActorKind.Temp,
  tempId: 7,
  ownerUid: SELF,
  expired: false,
  disabled: false,
  flags: { preview: true, download: false, uploadImg: true, uploadFile: false, editTag: false },
  quotaBytes: 0,
  usedBytes: 0,
  albumIds: [],
  folderIds: [],
};

function tempRow(over: Partial<TempAccount> = {}): TempAccount {
  return {
    id: 7,
    accountNo: 'YK8FZ3XC',
    loginName: 'coser-yuki',
    displayName: '雪乃',
    phone: '13812345678',
    shootingNote: 'CP29 返图',
    expireTime: new Date(Date.now() + 7 * DAY_MS),
    allowPreview: 1,
    allowDownload: 0,
    allowUploadImg: 1,
    allowUploadFile: 0,
    allowEditTag: 0,
    spaceQuota: String(DEFAULT_QUOTA),
    usedSpace: '0',
    disabled: 0,
    ownerUid: SELF,
    accessToken: null,
    preStage: 0,
    postStage: 0,
    preDoneTime: null,
    postDoneTime: null,
    createTime: new Date('2026-10-01T09:00:00Z'),
    ...over,
  } as TempAccount;
}

class FakeQb {
  conditions: string[] = [];
  params: Record<string, unknown> = {};
  orderings: string[] = [];

  where(sql: string, params: Record<string, unknown> = {}): this {
    this.conditions.push(`WHERE ${sql}`);
    Object.assign(this.params, params);
    return this;
  }

  andWhere(sql: string, params: Record<string, unknown> = {}): this {
    this.conditions.push(`AND ${sql}`);
    Object.assign(this.params, params);
    return this;
  }

  orderBy(column: string): this {
    this.orderings.push(column);
    return this;
  }

  addOrderBy(): this {
    return this;
  }

  skip(): this {
    return this;
  }

  take(): this {
    return this;
  }

  constructor(private readonly rows: TempAccount[] = [], private readonly total = rows.length) {}

  async getManyAndCount(): Promise<[TempAccount[], number]> {
    return [this.rows, this.total];
  }
}

interface Opts {
  rows?: TempAccount[];
  total?: number;
  albums?: Array<{ id: number; createUid: number }>;
  folders?: Array<{ id: number; createUid: number }>;
  files?: Array<{ id: number }>;
  /** save 前 N 次抛撞库，用来验帐户ID 重试（用例 22） */
  dupTimes?: number;
}

function build(opts: Opts = {}) {
  const qb = new FakeQb(opts.rows ?? [], opts.total ?? (opts.rows ?? []).length);
  const saves: TempAccount[] = [];
  let dupLeft = opts.dupTimes ?? 0;
  const save = jest.fn(async (row: TempAccount) => {
    if (dupLeft > 0) {
      dupLeft -= 1;
      throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
    }
    const stored = { ...row, id: 7 } as TempAccount;
    saves.push(stored);
    return stored;
  });
  const create = jest.fn((input: Partial<TempAccount>) => input as TempAccount);
  const findOne = jest.fn(async (_where: unknown): Promise<TempAccount | null> => null);
  const update = jest.fn(async (_where: unknown, _patch: unknown) => ({ affected: 1 }));

  const tempsRepo = { createQueryBuilder: jest.fn(() => qb), save, create, findOne, update };
  const albumGrants = {
    insert: jest.fn(async (_rows: unknown) => ({ identifiers: [] })),
    find: jest.fn(async (_where: unknown) => [] as Array<{ tempId: number; albumId: number }>),
  };
  const folderGrants = {
    insert: jest.fn(async (_rows: unknown) => ({ identifiers: [] })),
    find: jest.fn(async (_where: unknown) => [] as Array<{ tempId: number; folderId: number }>),
  };
  const albums = { find: jest.fn(async (_where: unknown) => opts.albums ?? []) };
  const folders = { find: jest.fn(async (_where: unknown) => opts.folders ?? []) };
  const files = { find: jest.fn(async (_where: unknown) => opts.files ?? []), update };
  const users = {
    find: jest.fn(async (_where: unknown) => [{ id: SELF, username: 'piksu', nickname: '皮克' } as User]),
  };
  const settings = {
    getNumber: jest.fn((key: string, fallback: number) =>
      key === 'temp.default_quota' ? DEFAULT_QUOTA : fallback,
    ),
  };
  const auth = { hashPassword: jest.fn(async (plain: string) => `bcrypt(${plain})`) };
  const audit = {
    record: jest.fn(async (_actor: unknown, _ctx: unknown, _input: unknown) => undefined),
  };

  const service = new TempAccountService(
    tempsRepo as never,
    albumGrants as never,
    folderGrants as never,
    albums as never,
    folders as never,
    files as never,
    users as never,
    settings as unknown as SettingsService,
    auth as unknown as AuthService,
    audit as unknown as AuditService,
  );
  return { service, qb, saves, save, findOne, update, albumGrants, folderGrants, files, audit, settings };
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  return promise.then(
    () => {
      throw new Error('预期抛出 AppError');
    },
    (err: AppError) => err,
  );
}

function dto(over: Partial<CreateTempAccountDto> = {}): CreateTempAccountDto {
  return {
    displayName: '雪乃',
    loginName: 'coser-yuki',
    password: 'Coser_2026',
    days: 7,
    ...over,
  } as CreateTempAccountDto;
}

const CAPS = { maxDaysForL1L2: 7, defaultQuota: DEFAULT_QUOTA };

describe('D9 降权表（PRD 6.2 / 15 章用例 21）', () => {
  it('L1 用 L3 的入参创建：三项开关强制归零、配额取站点默认、时长上限 7 天，并逐项登记覆盖', () => {
    const out = applyCreateLimits(
      UserLevel.Trainee,
      {
        allowPreview: 1,
        allowDownload: 1,
        allowUploadImg: 1,
        allowUploadFile: 1,
        allowEditTag: 1,
        spaceQuota: 999 * 1024 ** 3,
      },
      CAPS,
    );
    expect(out.flags).toEqual({
      allowPreview: 1,
      allowDownload: 0,
      allowUploadImg: 1,
      allowUploadFile: 0,
      allowEditTag: 0,
    });
    expect(out.spaceQuota).toBe(DEFAULT_QUOTA);
    expect(out.maxDays).toBe(7);
    expect(out.overridden).toEqual(expect.arrayContaining(['allowDownload', 'allowUploadFile', 'allowEditTag', 'spaceQuota']));
  });

  it('L1/L2 未声明开关时默认只开预览与传图', () => {
    const out = applyCreateLimits(UserLevel.Member, {}, CAPS);
    expect(out.flags.allowPreview).toBe(1);
    expect(out.flags.allowUploadImg).toBe(1);
    expect(out.flags.allowDownload).toBe(0);
    expect(out.overridden).toEqual([]);
  });

  it('L3/L4 五项自由组合、配额自定义，默认全关', () => {
    const out = applyCreateLimits(
      UserLevel.Admin,
      { allowDownload: 1, allowEditTag: 1, spaceQuota: 1024 },
      CAPS,
    );
    expect(out.flags.allowDownload).toBe(1);
    expect(out.flags.allowEditTag).toBe(1);
    expect(out.flags.allowPreview).toBe(0);
    expect(out.spaceQuota).toBe(1024);
    expect(out.maxDays).toBe(MAX_DAYS_FOR_ADMIN);
    expect(out.overridden).toEqual([]);
  });

  it('L1 显式关掉预览是被允许的：默认值不等于强制开启', () => {
    const out = applyCreateLimits(UserLevel.Trainee, { allowPreview: 0 }, CAPS);
    expect(out.flags.allowPreview).toBe(0);
  });
});

describe('POST /temp-accounts', () => {
  it('密码与专属链接都没有 → 400「至少配一种」，且不落库', async () => {
    const f = build();
    const err = await errorOf(f.service.create(dto({ password: undefined }), member(2), CTX));
    expect([err.getStatus(), err.code]).toEqual([400, 'ACCESS_METHOD_REQUIRED']);
    expect(f.save).not.toHaveBeenCalled();
  });

  it('wantLink 生成一次性链接令牌，随创建响应返回', async () => {
    const f = build();
    const result = await f.service.create(dto({ password: undefined, wantLink: true }), member(2), CTX);
    expect(result.accessToken).toMatch(/^[0-9a-f]{32}$/);
    expect(result.hasLink).toBe(true);
    expect(result.password).toBeUndefined();
  });

  it('密码随创建响应回显一次，并落 bcrypt 密文', async () => {
    const f = build();
    const result = await f.service.create(dto(), member(2), CTX);
    expect(result.password).toBe('Coser_2026');
    expect(f.saves[0].password).toBe('bcrypt(Coser_2026)');
  });

  it('L1 传他人相册与自己的相册：只留自己的，并登记 albumIds 被覆盖', async () => {
    const f = build({ albums: [{ id: 10, createUid: SELF }, { id: 11, createUid: OTHER }] });
    const result = await f.service.create(
      dto({ albumIds: [10, 11, 12] }),
      member(1),
      CTX,
    );
    expect(result.albumIds).toEqual([10]);
    expect(result.overridden).toContain('albumIds');
    expect(f.albumGrants.insert.mock.calls[0][0]).toEqual([{ tempId: 7, albumId: 10 }]);
  });

  it('L3 可把任意相册放进白名单', async () => {
    const f = build({ albums: [{ id: 11, createUid: OTHER }] });
    const result = await f.service.create(dto({ albumIds: [11] }), member(3), CTX);
    expect(result.albumIds).toEqual([11]);
    expect(result.overridden).not.toContain('albumIds');
  });

  it('L1 选 30 天：截断为 7 天并登记 expireTime 被覆盖', async () => {
    const f = build();
    const before = Date.now();
    const result = await f.service.create(dto({ days: 30 }), member(1), CTX);
    const granted = new Date(result.expireTime).getTime() - before;
    expect(granted).toBeLessThanOrEqual(7 * DAY_MS + 5_000);
    expect(granted).toBeGreaterThan(6 * DAY_MS);
    expect(result.overridden).toContain('expireTime');
  });

  it('自定义起止同样受上限约束：L1 超 7 天即截到天花板', async () => {
    const f = build();
    const far = new Date(Date.now() + 60 * DAY_MS).toISOString();
    const result = await f.service.create(dto({ days: undefined, validUntil: far }), member(1), CTX);
    expect(new Date(result.expireTime).getTime()).toBeLessThanOrEqual(Date.now() + 7 * DAY_MS + 5_000);
    expect(result.overridden).toContain('expireTime');
  });

  it('截止时间在过去 → 400', async () => {
    const f = build();
    const past = new Date(Date.now() - DAY_MS).toISOString();
    const err = await errorOf(
      f.service.create(dto({ days: undefined, validUntil: past }), member(3), CTX),
    );
    expect([err.getStatus(), err.code]).toEqual([400, 'EXPIRE_IN_PAST']);
  });

  it('阶段一律从 0 开始，不接收前端入参（PRD 6.2）', async () => {
    const f = build();
    const injected = Object.assign(dto(), { preStage: 1, postStage: 1, preDoneTime: new Date() });
    const result = await f.service.create(injected, member(4), CTX);
    expect([result.preStage, result.postStage]).toEqual([0, 0]);
    expect([f.saves[0].preStage, f.saves[0].postStage, f.saves[0].preDoneTime]).toEqual([0, 0, null]);
  });

  it('用例 22：帐户ID 撞库就换一个再试，最终入库的是合法格式且未重复', async () => {
    const f = build({ dupTimes: 2 });
    const result = await f.service.create(dto(), member(2), CTX);
    expect(f.save).toHaveBeenCalledTimes(3);
    expect(ACCOUNT_NO_REGEX.test(result.accountNo)).toBe(true);
    const tried = f.save.mock.calls.map((c) => (c[0] as TempAccount).accountNo);
    expect(new Set(tried).size).toBe(3);
  });

  it('用例 22：连撞 5 次不再硬试，回 500 而不是静默死循环', async () => {
    const f = build({ dupTimes: 5 });
    const err = await errorOf(f.service.create(dto(), member(2), CTX));
    expect([err.getStatus(), err.code]).toEqual([500, 'ACCOUNT_NO_EXHAUSTED']);
    expect(f.save).toHaveBeenCalledTimes(5);
  });

  it('参考图只挂自己的文件，越界的计入 preRefs 覆盖', async () => {
    const f = build({ files: [{ id: 31 }] });
    const result = await f.service.create(dto({ preRefs: [31, 32] }), member(2), CTX);
    expect(f.files.update.mock.calls[0][0]).toEqual({ id: expect.any(Object) });
    expect(result.overridden).toContain('preRefs');
  });

  it('没传参考图就不碰 files 表', async () => {
    const f = build();
    await f.service.create(dto(), member(2), CTX);
    expect(f.files.update).not.toHaveBeenCalled();
  });

  it('临时账号与成员之外不能创建', async () => {
    const f = build();
    const err = await errorOf(f.service.create(dto(), tempActor, CTX));
    expect(err.getStatus()).toBe(403);
  });

  it('审计只记帐户ID 与覆盖项：手机号、密码、链接令牌都不进 logs（12 章）', async () => {
    const f = build();
    await f.service.create(dto({ phone: '13812345678', wantLink: true }), member(2), CTX);
    const detail = String((f.audit.record.mock.calls[0][2] as { detail: string }).detail);
    const payload = JSON.stringify(f.audit.record.mock.calls[0]);
    expect(detail).toMatch(/account_no=YK/);
    expect(payload).not.toContain('13812345678');
    expect(payload).not.toContain('Coser_2026');
  });
});

describe('GET /temp-accounts', () => {
  it('L1/L2 的查询带 owner 条件，L3/L4 不带', async () => {
    const low = build({ rows: [tempRow()] });
    await low.service.list(member(1), {});
    expect(low.qb.conditions).toContain('WHERE t.ownerUid = :uid');

    const high = build({ rows: [tempRow({ ownerUid: OTHER })] });
    await high.service.list(member(3), {});
    expect(high.qb.conditions).not.toContain('WHERE t.ownerUid = :uid');
  });

  it('用例 23：非 owner 且非 L3/L4 时列表里 grep 不到 11 位完整号码', async () => {
    const f = build({ rows: [tempRow()] });
    const page = await f.service.list(member(UserLevel.Member, OTHER), {} as ListTempAccountDto);
    const json = JSON.stringify(page);
    expect(json).not.toMatch(/1[3-9]\d{9}/);
    expect(page.list[0].phone).toBe('138****5678');
  });

  it('owner 本人与 L3/L4 可见完整号码', async () => {
    const own = build({ rows: [tempRow()] });
    const asOwner = await own.service.list(member(2, SELF), {});
    expect(asOwner.list[0].phone).toBe('13812345678');

    const admin = build({ rows: [tempRow()] });
    const asAdmin = await admin.service.list(member(3, OTHER), {});
    expect(asAdmin.list[0].phone).toBe('13812345678');

    const top = build({ rows: [tempRow()] });
    expect((await top.service.list(member(4, OTHER), {})).list[0].phone).toBe('13812345678');
  });

  it('列表响应绝不含密码与链接令牌列', async () => {
    const f = build({ rows: [tempRow({ password: 'bcrypt(secret)' as never, accessToken: 'tok' as never })] });
    const json = JSON.stringify(await f.service.list(member(4), {}));
    expect(json).not.toContain('bcrypt');
    expect(json).not.toContain('tok"');
  });

  it('可按 disabled 过滤，已注销项仍对 owner 可见（6.2「状态显示为已销毁」）', async () => {
    const f = build({ rows: [tempRow({ disabled: 1 })] });
    const page = await f.service.list(member(4), { disabled: 1 });
    expect(f.qb.params.disabled).toBe(1);
    expect(page.list[0].disabled).toBe(1);
  });
});

describe('GET /temp-accounts/schema 与 next-account-no', () => {
  it('L1 只拿到 ≤7 天的档位，L4 拿到完整 5 档', async () => {
    const f = build();
    expect(f.service.schema(member(1))).toMatchObject({ canManage: false, maxDays: 7, daysOptions: [1, 3, 7] });
    expect(f.service.schema(member(4))).toMatchObject({ canManage: true, maxDays: 30, daysOptions: [1, 3, 7, 15, 30] });
  });

  it('schema 下发默认配额与参考图上限，前端不硬编码', () => {
    const f = build();
    expect(f.service.schema(member(2))).toMatchObject({ defaultQuota: DEFAULT_QUOTA, maxPreRefs: 9 });
  });

  it('游客与临时账号看不到表单元数据', () => {
    const f = build();
    expect(() => f.service.schema({ kind: ActorKind.Guest })).toThrow(AppError);
    expect(() => f.service.schema(tempActor)).toThrow(AppError);
  });

  it('候选 ID 不落库：撞库就换下一个', async () => {
    const f = build();
    const first = await f.service.nextAccountNo(member(2));
    expect(ACCOUNT_NO_REGEX.test(first.accountNo)).toBe(true);
    expect(f.save).not.toHaveBeenCalled();
  });

  it('连续撞库 5 次后报错而不是无限重试', async () => {
    const f = build();
    f.findOne.mockImplementation(async () => tempRow());
    const err = await errorOf(f.service.nextAccountNo(member(2)));
    expect([err.getStatus(), err.code]).toEqual([500, 'ACCOUNT_NO_EXHAUSTED']);
    expect(f.findOne).toHaveBeenCalledTimes(5);
  });
});
