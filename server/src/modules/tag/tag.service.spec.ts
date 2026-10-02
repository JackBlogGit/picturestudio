import { DataSource, FindOperator } from 'typeorm';
import { ImageTagMap, LogTargetType, Tag, TagType } from '../../entities';
import { UserLevel } from '../../common/enums/user-level.enum';
import { Actor, ActorKind } from '../../common/permission/types';
import { AppError } from '../../common/http/app-error';
import { AuditService, RequestContext } from '../audit/audit.service';
import {
  likeParam,
  matchExact,
  normalizeTagName,
  splitAlias,
  TagService,
} from './tag.service';

const CTX: RequestContext = { ip: '10.0.0.1', ua: 'jest' };

function member(level: UserLevel, uid = 100): Actor {
  return { kind: ActorKind.Member, uid, level };
}
const temp = (tempId = 7): Actor => ({
  kind: ActorKind.Temp,
  tempId,
  ownerUid: 100,
  expired: false,
  disabled: false,
  flags: { preview: true, download: false, uploadImg: true, uploadFile: false, editTag: true },
  quotaBytes: 0,
  usedBytes: 0,
  albumIds: [],
  folderIds: [],
});
const guest: Actor = { kind: ActorKind.Guest };

/** getStatus() 在 HttpException 原型上，toMatchObject 取不到，只能接住实例再断言 */
async function capturedError(promise: Promise<unknown>): Promise<AppError> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  return promise.then(
    () => {
      throw new Error('预期抛出 AppError');
    },
    (err: AppError) => err,
  );
}

function tagRow(partial: Partial<Tag> & { id: number; tagName: string }): Tag {
  return {
    tagType: TagType.Coser,
    alias: '',
    mergedInto: null,
    useCount: 0,
    createUid: null,
    ...partial,
  } as Tag;
}

/** 只记录条件片段，便于断言「是否追加了 status 屏蔽」 */
class FakeQb {
  conditions: string[] = [];
  params: Record<string, unknown> = {};
  rows: unknown[];
  raw: Array<Record<string, unknown>>;

  constructor(rows: unknown[] = [], raw: Array<Record<string, unknown>> = []) {
    this.rows = rows;
    this.raw = raw;
  }

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

  orderBy(): this { return this; }
  addOrderBy(): this { return this; }
  take(): this { return this; }
  skip(): this { return this; }
  select(): this { return this; }
  addSelect(): this { return this; }
  innerJoin(): this { return this; }
  update(): this { return this; }
  set(value: Record<string, unknown>): this {
    this.params = { ...this.params, ...value };
    return this;
  }

  async getMany(): Promise<unknown[]> { return this.rows; }
  async getRawMany(): Promise<Array<Record<string, unknown>>> { return this.raw; }
  async execute(): Promise<{ affected: number }> { return { affected: 1 }; }
}

interface Fakes {
  service: TagService;
  tagQb: FakeQb;
  tags: { find: jest.Mock; findOne: jest.Mock; save: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock; createQueryBuilder: jest.Mock };
  maps: { find: jest.Mock; count: jest.Mock; insert: jest.Mock; delete: jest.Mock; createQueryBuilder: jest.Mock };
  em: { tagUpdate: jest.Mock; mapUpdate: FakeQb; qb: jest.Mock };
  tx: jest.Mock;
  audit: { record: jest.Mock };
}

function build(tagsRows: Tag[] = [], opts: { dupes?: number[]; mapCount?: number } = {}): Fakes {
  const saved: Tag[] = [...tagsRows];
  const byId = (id: number): Tag | null => saved.find((t) => Number(t.id) === Number(id)) ?? null;
  const tagQb = new FakeQb(tagsRows);

  const tags = {
    find: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      if (where?.mergedInto instanceof FindOperator) return tagsRows.filter((t) => t.mergedInto === null);
      if ('id' in where) {
        const ids = (where.id as FindOperator<number[]>)?.value ?? [];
        return tagsRows.filter((t) => ids.includes(t.id));
      }
      return tagsRows.filter((t) => t.tagType === where.tagType && (where.tagName === undefined || t.tagName === where.tagName));
    }),
    findOne: jest.fn(async ({ where }: { where: { id?: number } }) => byId(Number(where.id))),
    save: jest.fn(async (row: Tag) => {
      if (!row.id) {
        const next = Math.max(0, ...saved.map((t) => Number(t.id))) + 1;
        const created = { ...row, id: next } as Tag;
        saved.push(created);
        return created;
      }
      const existing = saved.find((t) => t.id === row.id);
      if (existing) Object.assign(existing, row);
      else saved.push(row);
      return row;
    }),
    create: jest.fn((input: Partial<Tag>) => input as Tag),
    update: jest.fn(async (id: number, patch: Partial<Tag>) => ({ affected: 1 })),
    delete: jest.fn(async () => ({ affected: 1 })),
    createQueryBuilder: jest.fn(() => tagQb),
  };

  const maps = {
    find: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const tagIds = (where.tagId as FindOperator<number[]> | undefined)?.value;
      if (where.imageId !== undefined) {
        return (tagIds ?? []).map((tagId) => ({ imageId: where.imageId, tagId })) as ImageTagMap[];
      }
      return [1, 2, 3]
        .slice(0, opts.mapCount ?? 0)
        .map((imageId) => ({ imageId, tagId: where.tagId })) as ImageTagMap[];
    }),
    count: jest.fn(async () => opts.mapCount ?? 0),
    insert: jest.fn(async (rows: unknown) => ({ identifiers: [].concat(rows as never[]).map(() => ({})) })),
    delete: jest.fn(async () => ({ affected: 1 })),
    createQueryBuilder: jest.fn(() => new FakeQb([], (opts.dupes ?? []).map((imageId) => ({ imageId })))),
  };

  const mapUpdate = new FakeQb();
  const em = {
    tagUpdate: jest.fn(async () => undefined),
    mapUpdate,
    qb: jest.fn(() => mapUpdate),
  };
  const tx = jest.fn(async (cb: (manager: unknown) => Promise<unknown>) =>
    cb({
      getRepository: (entity: unknown) => (entity === Tag ? { ...tags, update: em.tagUpdate } : maps),
      createQueryBuilder: em.qb,
    }),
  );
  const audit = { record: jest.fn(async () => undefined) };
  const dataSource = { transaction: tx, createQueryBuilder: jest.fn() } as unknown as DataSource;

  const service = new TagService(
    tags as never,
    maps as never,
    dataSource,
    audit as unknown as AuditService,
  );
  return { service, tagQb, tags, maps, em, tx, audit };
}

describe('标签纯函数', () => {
  it('别名按多种分隔符切分并去空白', () => {
    expect(splitAlias(' 柚子, 小柚子、ゆず |yuzu/柚 ')).toEqual(['柚子', '小柚子', 'ゆず', 'yuzu', '柚']);
    expect(splitAlias('')).toEqual([]);
  });

  it('标签名精确命中优先于别名，且大小写不敏感', () => {
    const rows = [
      tagRow({ id: 1, tagName: '小柚子' }),
      tagRow({ id: 2, tagName: '柚子', alias: 'Yuzu,柚子酱' }),
    ];
    expect(matchExact(rows, '柚子')?.id).toBe(2);
    expect(matchExact(rows, 'yuzu')?.id).toBe(2);
    expect(matchExact(rows, '柚子酱')?.id).toBe(2);
    expect(matchExact(rows, '子')).toBeUndefined();
  });

  it('LIKE 通配符与转义符都要转义，否则 % 能全表扫', () => {
    expect(likeParam('20%_a\\b')).toBe('%20\\%\\_a\\\\b%');
  });

  it('标签名去空白并拦下超长/空值', () => {
    expect(normalizeTagName('  原神-雷电将军  ')).toBe('原神-雷电将军');
    expect(() => normalizeTagName('   ')).toThrow(AppError);
    expect(() => normalizeTagName('x'.repeat(101))).toThrow(/100/);
  });

  it('status 标签只对正式成员可见', () => {
    const rows = [
      { tagType: TagType.Coser, tagName: '柚子' },
      { tagType: TagType.Status, tagName: '待修' },
    ];
    expect(new TagService(null as never, null as never, null as never, null as never).filterTags(member(UserLevel.Trainee), rows)).toHaveLength(2);
    expect(new TagService(null as never, null as never, null as never, null as never).filterTags(temp(), rows)).toEqual([rows[0]]);
    expect(new TagService(null as never, null as never, null as never, null as never).filterTags(guest, rows)).toEqual([rows[0]]);
  });
});

describe('suggest 自动补全', () => {
  it('命中 tagName 或 alias，且排除已合并标签', async () => {
    const f = build();
    await f.service.suggest(member(UserLevel.Member), undefined, '柚子');
    const qb = f.tags.createQueryBuilder();
    expect(qb.conditions.join(' ')).toContain('t.mergedInto IS NULL');
    expect(qb.conditions.join(' ')).toContain('t.alias LIKE');
  });

  it('临时账号与游客看不到 status 类型', async () => {
    const f = build();
    await f.service.suggest(temp(), undefined, '待');
    expect(f.tags.createQueryBuilder().params.hidden).toBe(TagType.Status);
  });

  it('成员可以补全 status', async () => {
    const f = build();
    await f.service.suggest(member(UserLevel.Admin), TagType.Status, '待');
    const qb = f.tags.createQueryBuilder();
    expect(qb.params.hidden).toBeUndefined();
    expect(qb.params.type).toBe(TagType.Status);
  });

  it('空关键词直接返回空数组，不查库', async () => {
    const f = build();
    await expect(f.service.suggest(member(UserLevel.Member), undefined, '  ')).resolves.toEqual([]);
    expect(f.tags.createQueryBuilder).not.toHaveBeenCalled();
  });
});

describe('resolveOrCreate 输入即建', () => {
  const existing = [tagRow({ id: 11, tagName: '柚子', alias: '小柚子' })];

  it('命中已有标签则复用，不新建', async () => {
    const f = build(existing);
    const tag = await f.service.resolveOrCreate(TagType.Coser, '柚子', member(UserLevel.Member));
    expect(tag.id).toBe(11);
    expect(f.tags.save).not.toHaveBeenCalled();
  });

  it('命中别名同样复用', async () => {
    const f = build(existing);
    const tag = await f.service.resolveOrCreate(TagType.Coser, '小柚子', member(UserLevel.Member));
    expect(tag.id).toBe(11);
  });

  it('未命中则创建，并记录创建人', async () => {
    const f = build(existing);
    const tag = await f.service.resolveOrCreate(TagType.Coser, '新角色', member(UserLevel.Member, 42));
    expect(f.tags.save).toHaveBeenCalledTimes(1);
    expect(f.tags.create).toHaveBeenCalledWith(
      expect.objectContaining({ tagType: TagType.Coser, tagName: '新角色', createUid: 42 }),
    );
    expect(tag.tagName).toBe('新角色');
  });

  it('L1 见习成员不能新建标签', async () => {
    const f = build(existing);
    const err = await capturedError(
      f.service.resolveOrCreate(TagType.Coser, '新的', member(UserLevel.Trainee)),
    );
    expect(err.code).toBe('LEVEL_FORBIDDEN');
    expect(err.getStatus()).toBe(403);
  });

  it('status 标签不允许隐式创建', async () => {
    const f = build(existing);
    await expect(
      f.service.resolveOrCreate(TagType.Status, '不存在的状态', member(UserLevel.SuperAdmin)),
    ).rejects.toMatchObject({ code: 'STATUS_TAG_NOT_FOUND' });
  });

  it('status 标签已存在时成员可以直接打', async () => {
    const f = build([tagRow({ id: 90, tagType: TagType.Status, tagName: '待修' })]);
    const tag = await f.service.resolveOrCreate(TagType.Status, '待修', member(UserLevel.Trainee));
    expect(tag.id).toBe(90);
  });

  it('并发撞唯一键时复用对方刚建的标签', async () => {
    const f = build([]);
    const raced = tagRow({ id: 12, tagName: '柚子2' });
    let lookups = 0;
    f.tags.find.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      lookups += 1;
      if (lookups <= 2) return [];
      return where.tagName === '柚子2' ? [raced] : [];
    });
    f.tags.save.mockRejectedValueOnce(Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' }));
    const tag = await f.service.resolveOrCreate(TagType.Coser, '柚子2', member(UserLevel.Member));
    expect(tag.id).toBe(12);
  });

  it('已合并的标签自动指向目标', async () => {
    const rows = [tagRow({ id: 1, tagName: '旧名', mergedInto: 2 }), tagRow({ id: 2, tagName: '新名' })];
    const f = build(rows);
    f.tags.find.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      if (where.tagName === '旧名') return [rows[0]];
      return [];
    });
    const tag = await f.service.resolveOrCreate(TagType.Coser, '旧名', member(UserLevel.Member));
    expect(tag.id).toBe(2);
  });
});

describe('create / rename', () => {
  it('重名直接 409，不写库', async () => {
    const f = build([tagRow({ id: 11, tagName: '柚子' })]);
    const err = await capturedError(
      f.service.create({ type: TagType.Coser, name: '柚子' }, member(UserLevel.Member), CTX),
    );
    expect(err.code).toBe('TAG_EXISTS');
    expect(err.getStatus()).toBe(409);
    expect(f.tags.save).not.toHaveBeenCalled();
  });

  it('别名入库前统一成半角逗号分隔', async () => {
    const f = build([]);
    await f.service.create(
      { type: TagType.Role, name: '原神-雷电将军', alias: '雷电、将军，raiden' },
      member(UserLevel.Member),
      CTX,
    );
    expect(f.tags.create).toHaveBeenCalledWith(expect.objectContaining({ alias: '雷电,将军,raiden' }));
    expect(f.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      CTX,
      expect.objectContaining({ action: 'tag_create', targetType: LogTargetType.Tag }),
    );
  });

  it('L2 不能新建 status 标签，L3 可以', async () => {
    const f = build([]);
    await expect(
      f.service.create({ type: TagType.Status, name: '待选' }, member(UserLevel.Member), CTX),
    ).rejects.toMatchObject({ code: 'LEVEL_FORBIDDEN' });
    await f.service.create({ type: TagType.Status, name: '待选' }, member(UserLevel.Admin), CTX);
    expect(f.tags.save).toHaveBeenCalledTimes(1);
  });

  it('改名撞已有标签返回 409，并提示改用合并', async () => {
    const rows = [tagRow({ id: 1, tagName: '柚子' }), tagRow({ id: 2, tagName: '柚子酱' })];
    const f = build(rows);
    await expect(
      f.service.rename(1, '柚子酱', undefined, member(UserLevel.Member), CTX),
    ).rejects.toMatchObject({ code: 'TAG_EXISTS' });
  });

  it('改名不改标签自身时不查冲突', async () => {
    const rows = [tagRow({ id: 1, tagName: '柚子', alias: 'x' })];
    const f = build(rows);
    const tag = await f.service.rename(1, '柚子', 'y', member(UserLevel.Admin), CTX);
    expect(tag.alias).toBe('y');
    expect(f.audit.record).toHaveBeenCalledWith(expect.anything(), CTX, expect.objectContaining({ action: 'tag_rename' }));
  });

  it('内置 status 标签只能改文案不能删', async () => {
    const f = build([tagRow({ id: 5, tagType: TagType.Status, tagName: '待修' })]);
    await f.service.rename(5, '待处理', undefined, member(UserLevel.Admin), CTX);
    expect(f.tags.save).toHaveBeenCalled();
    await expect(f.service.remove(5, member(UserLevel.Admin), CTX)).rejects.toMatchObject({
      code: 'BUILTIN_STATUS_TAG',
    });
  });

  it('L2 无权删除标签', async () => {
    const f = build([tagRow({ id: 6, tagType: TagType.Coser, tagName: '柚子' })]);
    await expect(f.service.remove(6, member(UserLevel.Member), CTX)).rejects.toMatchObject({
      code: 'LEVEL_FORBIDDEN',
    });
    expect(f.tags.delete).not.toHaveBeenCalled();
  });
});

describe('merge 标签合并', () => {
  const rows = [tagRow({ id: 1, tagName: '旧' }), tagRow({ id: 2, tagName: '新' })];

  it('合并到自己是 400', async () => {
    const f = build(rows);
    await expect(f.service.merge(1, 1, member(UserLevel.Admin), CTX)).rejects.toMatchObject({ code: 'SELF_MERGE' });
  });

  it('反向合并（目标已并入源）成环，拒绝', async () => {
    const cyclic = [tagRow({ id: 1, tagName: '旧', mergedInto: 2 }), tagRow({ id: 2, tagName: '新', mergedInto: 1 })];
    const f = build(cyclic);
    await expect(f.service.merge(2, 1, member(UserLevel.Admin), CTX)).rejects.toMatchObject({
      code: 'CYCLIC_MERGE',
    });
  });

  it('跨类型合并拒绝', async () => {
    const mixed = [tagRow({ id: 1, tagType: TagType.Coser, tagName: 'a' }), tagRow({ id: 2, tagType: TagType.Role, tagName: 'b' })];
    const f = build(mixed);
    await expect(f.service.merge(1, 2, member(UserLevel.Admin), CTX)).rejects.toMatchObject({ code: 'TYPE_MISMATCH' });
  });

  it('先删重复关联再迁移，源标签停用而非物理删除', async () => {
    const f = build(rows, { dupes: [1] });
    f.maps.find.mockResolvedValueOnce([{ imageId: 1 }, { imageId: 2 }, { imageId: 3 }]);
    const target = await f.service.merge(1, 2, member(UserLevel.Admin), CTX);

    expect(f.maps.delete).toHaveBeenCalledWith({ tagId: 1, imageId: expect.anything() });
    expect(f.em.mapUpdate.conditions.join(' ')).toContain('tagId = :source');
    expect(f.em.mapUpdate.params.tagId).toBe(2);
    expect(f.em.tagUpdate).toHaveBeenCalledWith(1, { mergedInto: 2 });
    expect(target.id).toBe(2);
    expect(f.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      CTX,
      expect.objectContaining({ action: 'tag_merge', detail: '1(旧) → 2(新)' }),
    );
  });

  it('无重复关联时不触发删除', async () => {
    const f = build(rows);
    f.maps.find.mockResolvedValueOnce([]);
    await f.service.merge(1, 2, member(UserLevel.Admin), CTX);
    expect(f.maps.delete).not.toHaveBeenCalled();
  });

  it('L2 无权合并标签', async () => {
    const f = build(rows);
    await expect(f.service.merge(1, 2, member(UserLevel.Member), CTX)).rejects.toMatchObject({
      code: 'LEVEL_FORBIDDEN',
    });
    expect(f.tx).not.toHaveBeenCalled();
  });
});

describe('recount 频次校准', () => {
  it('不传 ids 时只重算未停用标签，停用标签保留历史频次', async () => {
    const f = build([tagRow({ id: 1, tagName: 'a', useCount: 9, mergedInto: 2 })]);
    f.tags.find.mockResolvedValueOnce([]);
    await f.service.recount();
    expect(f.tags.find).toHaveBeenCalledWith({ where: { mergedInto: expect.anything() } });
    expect(f.tags.update).not.toHaveBeenCalled();
  });

  it('数值变化才写库', async () => {
    const f = build([tagRow({ id: 3, tagName: 'c', useCount: 0 })], { mapCount: 4 });
    f.tags.find.mockResolvedValueOnce([tagRow({ id: 3, tagName: 'c', useCount: 0 })]);
    await expect(f.service.recount([3])).resolves.toBe(1);
    expect(f.tags.update).toHaveBeenCalledWith(3, { useCount: 4 });
  });

  it('数值一致时不产生 UPDATE', async () => {
    const f = build([], { mapCount: 4 });
    f.tags.find.mockResolvedValueOnce([tagRow({ id: 3, tagName: 'c', useCount: 4 })]);
    await expect(f.service.recount([3])).resolves.toBe(0);
    expect(f.tags.update).not.toHaveBeenCalled();
  });
});

describe('attach / detach', () => {
  it('已存在的关联跳过，只插新的', async () => {
    const f = build();
    f.maps.find.mockResolvedValueOnce([{ tagId: 2 }]);
    await expect(f.service.attach(500, [1, 2, 3])).resolves.toBe(2);
    expect(f.maps.insert).toHaveBeenCalledWith([
      { imageId: 500, tagId: 1 },
      { imageId: 500, tagId: 3 },
    ]);
  });

  it('空数组不查库', async () => {
    const f = build();
    await expect(f.service.attach(500, [])).resolves.toBe(0);
    await expect(f.service.detach(500, [])).resolves.toBe(0);
    expect(f.maps.find).not.toHaveBeenCalled();
  });
});
