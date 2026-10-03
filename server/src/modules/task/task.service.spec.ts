import { TempAccount, User } from '../../entities';
import { UserLevel } from '../../common/enums/user-level.enum';
import { AppError } from '../../common/http/app-error';
import { Actor, ActorKind } from '../../common/permission/types';
import { TASK_STAGE_FILTER_VALUES } from '../../common/permission/task-policy';
import { AuditService, RequestContext } from '../audit/audit.service';
import { ListTaskDto, UpdateTaskStageDto } from './dto/task.dto';
import { TaskService } from './task.service';

const CTX: RequestContext = { ip: '10.0.0.9', ua: 'jest' };
const SELF = 100;
const OTHER = 200;

function member(level: UserLevel, uid = SELF): Actor {
  return { kind: ActorKind.Member, uid, level };
}

const guest: Actor = { kind: ActorKind.Guest };

function tempActor(tempId = 7): Actor {
  return {
    kind: ActorKind.Temp,
    tempId,
    ownerUid: SELF,
    expired: false,
    disabled: false,
    flags: { preview: true, download: false, editTag: false },
    quotaBytes: 0,
    usedBytes: 0,
    albumIds: [],
    folderIds: [],
  };
}

function ticketRow(partial: Partial<TempAccount> = {}): TempAccount {
  return {
    id: 7,
    accountNo: 'YK8FZ3XC',
    loginName: 'coser-yuki',
    displayName: '雪乃',
    phone: '13812345678',
    shootingNote: 'CP29 三日场返图',
    expireTime: new Date('2026-10-08T12:00:00Z'),
    disabled: 0,
    ownerUid: SELF,
    preStage: 0,
    postStage: 0,
    preDoneTime: null,
    postDoneTime: null,
    createTime: new Date('2026-10-01T09:00:00Z'),
    ...partial,
  } as TempAccount;
}

/** 只记录 SQL 片段与参数，真正执行的是 MySQL——这里验的是「生成的条件对不对」 */
class FakeQb {
  conditions: string[] = [];
  params: Record<string, unknown> = {};
  selections: string[] = [];
  selectExprs: string[] = [];
  orderings: Array<[string, string]> = [];
  paged: { skip?: number; take?: number } = {};
  raw: Record<string, string | number> | null = null;

  constructor(
    private readonly rows: TempAccount[] = [],
    private readonly total = rows.length,
  ) {}

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

  select(expr: string, alias?: string): this {
    this.selectExprs.push(expr);
    if (alias) this.selections.push(alias);
    return this;
  }

  addSelect(expr: string, alias?: string): this {
    this.selectExprs.push(expr);
    if (alias) this.selections.push(alias);
    return this;
  }

  orderBy(column: string, dir: string): this {
    this.orderings.push([column, dir]);
    return this;
  }

  addOrderBy(column: string, dir: string): this {
    this.orderings.push([column, dir]);
    return this;
  }

  skip(n: number): this {
    this.paged.skip = n;
    return this;
  }

  take(n: number): this {
    this.paged.take = n;
    return this;
  }

  async getManyAndCount(): Promise<[TempAccount[], number]> {
    return [this.rows, this.total];
  }

  async getRawOne<T>(): Promise<T | null> {
    return this.raw as T | null;
  }
}

interface Fakes {
  service: TaskService;
  qb: FakeQb;
  findOne: jest.Mock;
  update: jest.Mock;
  audit: { record: jest.Mock };
}

function build(
  rows: TempAccount[] = [],
  total = rows.length,
  one: TempAccount | null = null,
  raw: Record<string, string | number> | null = null,
  owners: User[] = [{ id: SELF, username: 'piksu', nickname: '皮克' } as User],
): Fakes {
  const qb = new FakeQb(rows, total);
  qb.raw = raw;
  const findOne = jest.fn(async () => one);
  const update = jest.fn(async () => ({ affected: 1 }));
  const audit = { record: jest.fn(async () => undefined) };

  const tempsRepo = {
    findOne,
    update,
    createQueryBuilder: jest.fn(() => qb),
  };
  const usersRepo = { find: jest.fn(async () => owners) };
  const service = new TaskService(tempsRepo as never, usersRepo as never, audit as never);
  return { service, qb, findOne, update, audit };
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

describe('M2.5 列表的身份裁剪（PRD 17.3 / 17.4）', () => {
  it('L1/L2 只查自己 owner 的工单', async () => {
    for (const level of [UserLevel.Trainee, UserLevel.Member]) {
      const f = build([ticketRow()]);
      const page = await f.service.list(member(level), {});
      expect(f.qb.params.uid).toBe(SELF);
      expect(f.qb.conditions).toContain('AND t.ownerUid = :uid');
      expect(page.total).toBe(1);
    }
  });

  it('L3/L4 不加 owner 条件，看全站', async () => {
    for (const level of [UserLevel.Admin, UserLevel.SuperAdmin]) {
      const f = build([ticketRow()]);
      await f.service.list(member(level), {});
      expect(f.qb.conditions).not.toContain('AND t.ownerUid = :uid');
      expect(f.qb.params.uid).toBeUndefined();
    }
  });

  it('临时账号只见自己那一张', async () => {
    const f = build([ticketRow()]);
    await f.service.list(tempActor(7), {});
    expect(f.qb.conditions).toContain('AND t.id = :tempId');
    expect(f.qb.params.tempId).toBe(7);
  });

  it('游客 401，不透出任何工单', async () => {
    const f = build();
    const err = await errorOf(f.service.list(guest, {}));
    expect([err.getStatus(), err.code]).toEqual([401, 'LOGIN_REQUIRED']);
  });

  it('默认排除已注销工单（17.3）', async () => {
    const f = build([ticketRow()]);
    await f.service.list(member(4), {});
    expect(f.qb.conditions).toContain('WHERE t.disabled = 0');
  });
});

describe('M2.5 五个筛选值的 SQL 条件与 17.3 逐一对得上', () => {
  const EXPECTED: Record<string, string> = {
    pre_pending: 't.preStage = 0',
    post_pending: 't.preStage = 1 AND t.postStage = 0',
    pre_done: 't.preStage = 1',
    post_done: 't.postStage = 1',
    all_done: 't.preStage = 1 AND t.postStage = 1',
  };

  it.each(TASK_STAGE_FILTER_VALUES)('%s', async (stage) => {
    const f = build([ticketRow()]);
    await f.service.list(member(4), { stage } as ListTaskDto);
    expect(f.qb.conditions).toContain(`AND ${EXPECTED[stage]}`);
  });

  it('不传 stage 时不加阶段条件，即「总数」口径', async () => {
    const f = build([ticketRow()]);
    await f.service.list(member(4), {});
    expect(f.qb.conditions.join(' ')).not.toContain('preStage');
  });

  it('徽标计数与列表共用同一套条件，且别名为 total + 5 个筛选值', async () => {
    const f = build([], 0, null, { total: 12, pre_pending: 5, post_pending: 3, pre_done: 7, post_done: 2, all_done: 2 });
    const stats = await f.service.statistics(member(4));
    expect(f.qb.selections).toEqual(['total', ...TASK_STAGE_FILTER_VALUES]);
    for (const stage of TASK_STAGE_FILTER_VALUES) {
      expect(f.qb.selectExprs.some((c) => c.includes(`CASE WHEN ${EXPECTED[stage]}`))).toBe(true);
    }
    expect(stats).toEqual({
      total: 12,
      pre_pending: 5,
      post_pending: 3,
      pre_done: 7,
      post_done: 2,
      all_done: 2,
    });
  });

  it('游客访问统计同样 401（10.6：不可见 /tasks）', async () => {
    const f = build();
    await expect(f.service.statistics(guest)).rejects.toBeInstanceOf(AppError);
  });
});

describe('M2.5 搜索与排序', () => {
  it('q 走前缀匹配并转义 LIKE 通配符', async () => {
    const f = build([ticketRow()]);
    await f.service.list(member(4), { q: 'YK8%' } as ListTaskDto);
    expect(f.qb.params.kw).toBe('YK8!%%');
    expect(f.qb.conditions.join(' ')).toContain("t.accountNo LIKE :kw ESCAPE '!'");
  });

  it('q 短于 2 字符不发查询', async () => {
    const f = build([ticketRow()]);
    await f.service.list(member(4), { q: 'Y' } as ListTaskDto);
    expect(f.qb.params.kw).toBeUndefined();
  });

  it('by/sort 映射到实体属性，默认 create_time desc', async () => {
    const byDefault = build([ticketRow()]);
    await byDefault.service.list(member(4), {});
    expect(byDefault.qb.orderings[0]).toEqual(['t.createTime', 'DESC']);

    const byPost = build([ticketRow()]);
    await byPost.service.list(member(4), { by: 'post_done_time', sort: 'asc' } as ListTaskDto);
    expect(byPost.qb.orderings[0]).toEqual(['t.postDoneTime', 'ASC']);
  });

  it('分页档位透传给 skip/take', async () => {
    const f = build([ticketRow()], 50);
    const page = await f.service.list(member(4), { page: 2, pageSize: 50 } as ListTaskDto);
    expect([f.qb.paged.skip, f.qb.paged.take]).toEqual([50, 50]);
    expect([page.page, page.pageSize, page.total]).toEqual([2, 50, 50]);
  });
});

describe('M2.5 手机号脱敏（PRD 6.2 PII）', () => {
  it('owner 本人与 L3/L4 见完整号码', async () => {
    const owner = build([ticketRow()]);
    const asOwner = await owner.service.list(member(2, SELF), {});
    expect(asOwner.list[0].phone).toBe('13812345678');

    const admin = build([ticketRow({ ownerUid: OTHER })]);
    const asAdmin = await admin.service.list(member(3, OTHER), {});
    expect(asAdmin.list[0].phone).toBe('13812345678');
  });

  it('其余身份一律 138****5678', async () => {
    const f = build([ticketRow()]);
    const page = await f.service.list(tempActor(), {});
    expect(page.list[0].phone).toBe('138****5678');
  });

  it('号码为空时返回 null 而不是 ****', async () => {
    const f = build([ticketRow({ phone: null })]);
    const page = await f.service.list(member(4), {});
    expect(page.list[0].phone).toBeNull();
  });
});

describe('PATCH /tasks/:tempId/stage（PRD 17.2 / 17.4）', () => {
  function stageDto(partial: Partial<UpdateTaskStageDto> = {}): UpdateTaskStageDto {
    return { stage: 'pre', status: 1, ...partial } as UpdateTaskStageDto;
  }

  it('推进前期完成：服务端盖 preDoneTime，写 task_stage_updated', async () => {
    const f = build([], 0, ticketRow());
    const view = await f.service.updateStage(7, stageDto(), member(1), CTX);
    expect(f.update.mock.calls[0][1]).toEqual({ preStage: 1, preDoneTime: expect.any(Date) });
    expect(view.preStage).toBe(1);
    expect(view.preDoneTime).toBeInstanceOf(Date);
    expect(f.audit.record.mock.calls[0][2].action).toBe('task_stage_updated');
  });

  it('跳跃推进（pre=0 直接标 post=1）回 409 STAGE_ORDER_VIOLATION', async () => {
    const f = build([], 0, ticketRow());
    const err = await errorOf(f.service.updateStage(7, stageDto({ stage: 'post' }), member(1), CTX));
    expect([err.getStatus(), err.code]).toEqual([409, 'STAGE_ORDER_VIOLATION']);
    expect(f.update).not.toHaveBeenCalled();
  });

  it('后期已完成后推进：盖 postDoneTime', async () => {
    const f = build([], 0, ticketRow({ preStage: 1 }));
    const view = await f.service.updateStage(7, stageDto({ stage: 'post' }), member(2), CTX);
    expect(view.postStage).toBe(1);
    expect(view.postDoneTime).toBeInstanceOf(Date);
  });

  it('回退清空对应完成时间并写 task_stage_reopened', async () => {
    const f = build([], 0, ticketRow({ preStage: 1, preDoneTime: new Date() }));
    const view = await f.service.updateStage(7, stageDto({ status: 0, reason: '客户重拍，需重筛' }), member(3), CTX);
    expect(f.update.mock.calls[0][1]).toEqual({ preStage: 0, preDoneTime: null });
    expect(view.preDoneTime).toBeNull();
    const logged = f.audit.record.mock.calls[0][2];
    expect(logged.action).toBe('task_stage_reopened');
    expect(logged.detail).toContain('客户重拍');
  });

  it('回退必须带 reason', async () => {
    const f = build([], 0, ticketRow({ preStage: 1 }));
    const err = await errorOf(f.service.updateStage(7, stageDto({ status: 0 }), member(3), CTX));
    expect([err.getStatus(), err.code]).toEqual([400, 'REASON_REQUIRED']);
  });

  it('L1/L2 回退阶段回 403，与 PRD 17.4 的 ❌ 一致', async () => {
    for (const level of [UserLevel.Trainee, UserLevel.Member]) {
      const f = build([], 0, ticketRow({ preStage: 1 }));
      const err = await errorOf(
        f.service.updateStage(7, stageDto({ status: 0, reason: 'x' }), member(level), CTX),
      );
      expect([err.getStatus(), err.code]).toEqual([403, 'LEVEL_FORBIDDEN']);
    }
  });

  it('跨 owner 修改回 404，不暴露工单存在', async () => {
    const f = build([], 0, ticketRow({ ownerUid: OTHER }));
    const err = await errorOf(f.service.updateStage(7, stageDto(), member(1), CTX));
    expect([err.getStatus(), err.code]).toEqual([404, 'NOT_FOUND']);
  });

  it('临时账号只读：改阶段回 403 TASK_STAGE_READONLY', async () => {
    const f = build([], 0, ticketRow());
    const err = await errorOf(f.service.updateStage(7, stageDto(), tempActor(), CTX));
    expect([err.getStatus(), err.code]).toEqual([403, 'TASK_STAGE_READONLY']);
    expect(f.update).not.toHaveBeenCalled();
  });

  it('已注销工单阶段冻结：409 TASK_REVOKED', async () => {
    const f = build([], 0, ticketRow({ disabled: 1 }));
    const err = await errorOf(f.service.updateStage(7, stageDto(), member(4), CTX));
    expect([err.getStatus(), err.code]).toEqual([409, 'TASK_REVOKED']);
  });

  it('重复提交同值不写库、不记日志（幂等）', async () => {
    const f = build([], 0, ticketRow({ preStage: 1, preDoneTime: new Date() }));
    const view = await f.service.updateStage(7, stageDto(), member(1), CTX);
    expect(f.update).not.toHaveBeenCalled();
    expect(f.audit.record).not.toHaveBeenCalled();
    expect(view.preStage).toBe(1);
  });

  it('工单不存在 404', async () => {
    const f = build([], 0, null);
    const err = await errorOf(f.service.updateStage(7, stageDto(), member(4), CTX));
    expect([err.getStatus(), err.code]).toEqual([404, 'NOT_FOUND']);
  });
});

describe('POST /tasks/:tempId/revoke（D11）', () => {
  it('置 disabled=1，阶段值与资源保留，写 task_revoked', async () => {
    const f = build([], 0, ticketRow({ preStage: 1, postStage: 1 }));
    const view = await f.service.revoke(7, member(3), CTX);
    expect(f.update.mock.calls[0][1]).toEqual({ disabled: 1 });
    expect(view.disabled).toBe(1);
    expect(view.preStage).toBe(1);
    expect(f.audit.record.mock.calls[0][2].action).toBe('task_revoked');
  });

  it('L1 可注销自己名下工单，他人的回 404', async () => {
    const own = build([], 0, ticketRow());
    await expect(own.service.revoke(7, member(1), CTX)).resolves.toBeTruthy();

    const others = build([], 0, ticketRow({ ownerUid: OTHER }));
    const err = await errorOf(others.service.revoke(7, member(1), CTX));
    expect([err.getStatus(), err.code]).toEqual([404, 'NOT_FOUND']);
  });

  it('重复注销不再写库', async () => {
    const f = build([], 0, ticketRow({ disabled: 1 }));
    const view = await f.service.revoke(7, member(4), CTX);
    expect(f.update).not.toHaveBeenCalled();
    expect(view.disabled).toBe(1);
  });

  it('游客 401', async () => {
    const f = build([], 0, ticketRow());
    const err = await errorOf(f.service.revoke(7, guest, CTX));
    expect([err.getStatus(), err.code]).toEqual([401, 'LOGIN_REQUIRED']);
  });
});
