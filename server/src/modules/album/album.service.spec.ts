import { DataSource } from 'typeorm';
import { AppError } from '../../common/http/app-error';
import { Actor, ActorKind } from '../../common/permission/types';
import { UserLevel } from '../../common/enums/user-level.enum';
import { Visibility } from '../../common/enums/visibility.enum';
import { StorageService } from '../../common/storage/storage.service';
import { Album, AlbumStatus, LogTargetType } from '../../entities';
import { AuditService, RequestContext } from '../audit/audit.service';
import { AlbumService, visibleVisibilities } from './album.service';

const CTX: RequestContext = { ip: '10.0.0.9', ua: 'jest' };

function member(level: UserLevel, uid = 100): Actor {
  return { kind: ActorKind.Member, uid, level };
}
const guest: Actor = { kind: ActorKind.Guest };
const tempWith = (albumIds: number[]): Actor => ({
  kind: ActorKind.Temp,
  tempId: 7,
  ownerUid: 100,
  expired: false,
  disabled: false,
  flags: { preview: true, download: true, editTag: true },
  quotaBytes: 0,
  usedBytes: 0,
  albumIds,
  folderIds: [],
});
const shareVisitor: Actor = { kind: ActorKind.ShareVisitor, linkId: 3, imageIds: [1], allowDownload: false };

function albumRow(partial: Partial<Album> = {}): Album {
  return {
    id: 1,
    name: '2026-09 本地次元漫展',
    eventName: '本地次元漫展',
    eventDate: '2026-09-12',
    location: '',
    description: '',
    coverImgId: null,
    visibility: Visibility.Member,
    status: AlbumStatus.Normal,
    createUid: 100,
    ...partial,
  } as Album;
}

class FakeQb {
  conditions: string[] = [];
  params: Record<string, unknown> = {};
  rows: Album[];
  total: number;

  constructor(rows: Album[] = [], total = rows.length) {
    this.rows = rows;
    this.total = total;
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
  skip(): this { return this; }
  take(): this { return this; }

  async getManyAndCount(): Promise<[Album[], number]> {
    return [this.rows, this.total];
  }
}

interface Fakes {
  service: AlbumService;
  albumQb: FakeQb;
  findOne: jest.Mock;
  save: jest.Mock;
  deleteRepo: jest.Mock;
  imagesFind: jest.Mock;
  imagesCount: jest.Mock;
  storageRemove: jest.Mock;
  tx: jest.Mock;
  audit: { record: jest.Mock };
}

function build(album: Album | null, rows: Album[] = [], total = rows.length, originalRefs = 0): Fakes {
  const albumQb = new FakeQb(rows, total);
  const findOne = jest.fn(async () => album);
  const save = jest.fn(async (row: Album) => ({ ...row, id: row.id ?? 1 }));
  const create = jest.fn((input: Partial<Album>) => input as Album);
  const deleteRepo = jest.fn(async () => ({ affected: 1 }));
  const imagesFind = jest.fn(async () => [
    { id: 11, originalPath: 'originals/2026/09/a.jpg', previewPath: 'derived/preview/11.webp', thumbPath: 'derived/thumb/11.webp' },
    { id: 12, originalPath: 'originals/2026/09/b.jpg', previewPath: 'derived/preview/12.webp', thumbPath: 'derived/thumb/12.webp' },
  ]);
  const imagesCount = jest.fn(async () => originalRefs);
  const storageRemove = jest.fn(async () => undefined);
  const tx = jest.fn(async (cb: (em: unknown) => Promise<unknown>) => cb({ getRepository: () => ({ delete: deleteRepo }) }));
  const audit = { record: jest.fn(async () => undefined) };

  const albumsRepo = { findOne, save, create, delete: deleteRepo, createQueryBuilder: jest.fn(() => albumQb) };
  const imagesRepo = { find: imagesFind, count: imagesCount };
  const service = new AlbumService(
    albumsRepo as never,
    imagesRepo as never,
    { remove: storageRemove } as unknown as StorageService,
    { transaction: tx } as unknown as DataSource,
    audit as unknown as AuditService,
  );
  return { service, albumQb, findOne, save, deleteRepo, imagesFind, imagesCount, storageRemove, tx, audit };
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

describe('visibleVisibilities 与 decide() 同源', () => {
  it('L1/L2 只见 public+member，L3 到 admin，L4 全含 private', () => {
    expect(visibleVisibilities(UserLevel.Trainee)).toEqual([Visibility.Public, Visibility.Member]);
    expect(visibleVisibilities(UserLevel.Member)).toEqual([Visibility.Public, Visibility.Member]);
    expect(visibleVisibilities(UserLevel.Admin)).toEqual([Visibility.Public, Visibility.Member, Visibility.Admin]);
    expect(visibleVisibilities(UserLevel.SuperAdmin)).toHaveLength(4);
  });
});

describe('相册列表的身份裁剪', () => {
  it('游客只见 public 且不含归档', async () => {
    const f = build(null, [albumRow()]);
    const result = await f.service.list(guest, {} as never);
    expect(f.albumQb.params.public).toBe(Visibility.Public);
    expect(f.albumQb.conditions.join(' ')).toContain('a.status <> :archived');
    expect(result.total).toBe(1);
  });

  it('成员可见范围内 OR 自己的 private', async () => {
    const f = build(null, [albumRow()]);
    await f.service.list(member(UserLevel.Member), { page: 1, pageSize: 20 } as never);
    expect(f.albumQb.params.allowed).toEqual([Visibility.Public, Visibility.Member]);
    expect(f.albumQb.params.uid).toBe(100);
    expect(f.albumQb.conditions.join(' ')).toContain('a.visibility IN');
  });

  it('L3 上限到 admin，不含他人 private', async () => {
    const f = build(null);
    await f.service.list(member(UserLevel.Admin), {} as never);
    expect(f.albumQb.params.allowed).not.toContain(Visibility.Private);
  });

  it('includeArchived 才放开归档相册', async () => {
    const f = build(null);
    await f.service.list(member(UserLevel.Member), { includeArchived: true } as never);
    expect(f.albumQb.conditions.join(' ')).not.toContain('a.status <> :archived');
  });

  it('临时账号只按白名单取相册，白名单为空不查库', async () => {
    const empty = build(null);
    await expect(empty.service.list(tempWith([]), {} as never)).resolves.toMatchObject({ total: 0, list: [] });
    expect(empty.albumQb.conditions).toEqual([]);

    const f = build(null, [albumRow()]);
    await f.service.list(tempWith([1, 2]), {} as never);
    expect(f.albumQb.params.ids).toEqual([1, 2]);
  });

  it('分享访客不允许枚举相册列表', async () => {
    const f = build(null, [albumRow()]);
    await expect(f.service.list(shareVisitor, {} as never)).resolves.toMatchObject({ total: 0 });
    expect(f.albumQb.params.public).toBeUndefined();
  });

  it('关键词里的 % 必须转义，否则能全表扫', async () => {
    const f = build(null);
    await f.service.list(member(UserLevel.Member), { keyword: '20%展' } as never);
    expect(f.albumQb.params.kw).toBe('%20!%展%');
  });
});

describe('创建相册', () => {
  it('默认档位是 member，且写审计', async () => {
    const f = build(null);
    await f.service.create({ name: '  国庆场 ' } as never, member(UserLevel.Member), CTX);
    expect(f.save.mock.calls[0][0]).toMatchObject({
      name: '国庆场',
      visibility: Visibility.Member,
      status: AlbumStatus.Normal,
      createUid: 100,
    });
    expect(f.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      CTX,
      expect.objectContaining({ action: 'album_create', targetType: LogTargetType.Album }),
    );
  });

  it('L1 不能创建公开相册', async () => {
    const f = build(null);
    const err = await errorOf(
      f.service.create({ name: 'x', visibility: Visibility.Public } as never, member(UserLevel.Trainee), CTX),
    );
    expect(err.code).toBe('SET_PUBLIC_FORBIDDEN');
    expect(err.getStatus()).toBe(403);
  });

  it('临时账号与游客不能建相册', async () => {
    const f = build(null);
    const err = await errorOf(f.service.create({ name: 'x' } as never, tempWith([1]), CTX));
    expect(err.code).toBe('MEMBER_ONLY');
    expect(f.save).not.toHaveBeenCalled();
  });
});

describe('修改相册', () => {
  it('锁定态禁止修改', async () => {
    const f = build(albumRow({ status: AlbumStatus.Locked }));
    const err = await errorOf(f.service.update(1, { name: '改名' } as never, member(UserLevel.SuperAdmin), CTX));
    expect(err.code).toBe('ALBUM_LOCKED');
    expect(err.getStatus()).toBe(409);
  });

  it('封面必须属于本相册', async () => {
    const f = build(albumRow());
    const err = await errorOf(f.service.update(1, { coverImgId: 999 } as never, member(UserLevel.Admin), CTX));
    expect(err.code).toBe('COVER_NOT_IN_ALBUM');
    expect(f.imagesCount).toHaveBeenCalledWith({ where: { id: 999, albumId: 1 } });
  });

  it('归档相册仍允许编辑（否则无法解除归档）', async () => {
    const f = build(albumRow({ status: AlbumStatus.Archived }));
    await f.service.update(1, { name: '补个标题' } as never, member(UserLevel.Member), CTX);
    expect(f.save).toHaveBeenCalled();
  });

  it('没有实际变化时不写库也不记审计', async () => {
    const f = build(albumRow({ name: 'A' }));
    const result = await f.service.update(1, { name: 'A' } as never, member(UserLevel.Admin), CTX);
    expect(result.name).toBe('A');
    expect(f.save).not.toHaveBeenCalled();
    expect(f.audit.record).not.toHaveBeenCalled();
  });

  it('放宽档位会写进审计 detail，便于追溯', async () => {
    const f = build(albumRow({ visibility: Visibility.Member }));
    await f.service.update(1, { visibility: Visibility.Public } as never, member(UserLevel.Admin), CTX);
    expect(f.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      CTX,
      expect.objectContaining({ detail: `visibility:${Visibility.Member}→${Visibility.Public}` }),
    );
  });

  it('相册档位放宽不会连带改子图档位（子图由 effectiveVisibility 收敛）', async () => {
    const f = build(albumRow({ visibility: Visibility.Member }));
    await f.service.update(1, { visibility: Visibility.Public } as never, member(UserLevel.Admin), CTX);
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.save.mock.calls[0][0].visibility).toBe(Visibility.Public);
  });
});

describe('归档与锁定', () => {
  it('状态相同直接返回，不产生写库', async () => {
    const f = build(albumRow({ status: AlbumStatus.Locked }));
    await f.service.changeStatus(1, AlbumStatus.Locked, member(UserLevel.Admin), CTX);
    expect(f.save).not.toHaveBeenCalled();
  });

  it('锁定中的相册可以被解锁（changeStatus 不受锁定闸门限制）', async () => {
    const f = build(albumRow({ status: AlbumStatus.Locked }));
    const result = await f.service.changeStatus(1, AlbumStatus.Normal, member(UserLevel.Admin), CTX);
    expect(result.status).toBe(AlbumStatus.Normal);
    expect(f.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      CTX,
      expect.objectContaining({ action: 'album_status', detail: `status=${AlbumStatus.Normal}` }),
    );
  });
});

describe('删除相册', () => {
  it('二次确认名不匹配则拒绝', async () => {
    const f = build(albumRow({ name: '国庆场' }));
    const err = await errorOf(f.service.remove(1, '国庆', member(UserLevel.SuperAdmin), CTX));
    expect(err.code).toBe('CONFIRM_NAME_MISMATCH');
    expect(f.tx).not.toHaveBeenCalled();
  });

  it('先删库再删盘，返回级联删除的图片数', async () => {
    const f = build(albumRow({ name: '国庆场' }));
    const count = await f.service.remove(1, '国庆场', member(UserLevel.SuperAdmin), CTX);
    expect(count).toBe(2);
    expect(f.deleteRepo).toHaveBeenCalledWith({ id: 1 });
    expect(f.imagesCount).toHaveBeenCalledWith({ where: { originalPath: 'originals/2026/09/a.jpg' } });
    expect(f.storageRemove).toHaveBeenNthCalledWith(1, 'originals/2026/09/a.jpg');
    expect(f.storageRemove).toHaveBeenNthCalledWith(2, 'originals/2026/09/b.jpg');
    expect(f.storageRemove).toHaveBeenNthCalledWith(3, 'derived/preview/11.webp', 'derived/thumb/11.webp');
    expect(f.storageRemove).toHaveBeenCalledTimes(4);
    expect(f.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      CTX,
      expect.objectContaining({ action: 'album_delete', detail: '国庆场, images=2' }),
    );
  });

  it('秒传后原图仍被别的相册引用时只删派生图', async () => {
    const f = build(albumRow({ name: '国庆场' }), [], 0, 1);
    await f.service.remove(1, '国庆场', member(UserLevel.SuperAdmin), CTX);
    expect(f.storageRemove.mock.calls.map((c) => c[0])).toEqual([
      'derived/preview/11.webp',
      'derived/preview/12.webp',
    ]);
  });

  it('同相册两张图共用原图时按路径去重，只统计一次引用', async () => {
    const f = build(albumRow({ name: '国庆场' }));
    f.imagesFind.mockResolvedValue([
      { id: 11, originalPath: 'originals/2026/09/a.jpg', previewPath: 'derived/preview/11.webp', thumbPath: '' },
      { id: 12, originalPath: 'originals/2026/09/a.jpg', previewPath: 'derived/preview/12.webp', thumbPath: '' },
    ] as never);
    await f.service.remove(1, '国庆场', member(UserLevel.SuperAdmin), CTX);
    expect(f.imagesCount).toHaveBeenCalledTimes(1);
    expect(f.storageRemove).toHaveBeenCalledTimes(3);
  });

  it('锁定态的相册依然可以删除', async () => {
    const f = build(albumRow({ name: 'X', status: AlbumStatus.Locked }));
    await expect(f.service.remove(1, 'X', member(UserLevel.SuperAdmin), CTX)).resolves.toBe(2);
  });
});

describe('相册读取', () => {
  it('不存在即 404，且不区分无权', async () => {
    const f = build(null);
    const err = await errorOf(f.service.getById(404));
    expect(err.getStatus()).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
  });
});
