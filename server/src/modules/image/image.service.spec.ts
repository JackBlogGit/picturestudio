import { HttpStatus } from '@nestjs/common';
import { Readable } from 'node:stream';
import { AppError } from '../../common/http/app-error';
import { ResourceLoader } from '../../common/permission/resource-loader';
import { Actor, ActorKind, ResourceRef, ResourceType } from '../../common/permission/types';
import { UserLevel } from '../../common/enums/user-level.enum';
import { Visibility } from '../../common/enums/visibility.enum';
import { StorageService } from '../../common/storage/storage.service';
import { Album, AlbumStatus, Image, LogTargetType, Tag, TagType } from '../../entities';
import { AuditService, RequestContext } from '../audit/audit.service';
import { AlbumService } from '../album/album.service';
import { TagService } from '../tag/tag.service';
import { BatchTagsDto, BatchVisibilityDto, ListImageDto, UpdateImageDto } from './dto/image.dto';
import { ImageService } from './image.service';

const CTX: RequestContext = { ip: '10.0.0.9', ua: 'jest' };

function member(level: UserLevel, uid = 100): Actor {
  return { kind: ActorKind.Member, uid, level };
}
const guest: Actor = { kind: ActorKind.Guest };
const temp: Actor = {
  kind: ActorKind.Temp,
  tempId: 7,
  ownerUid: 100,
  expired: false,
  disabled: false,
  flags: { preview: true, download: true, editTag: true },
  quotaBytes: 0,
  usedBytes: 0,
  albumIds: [1],
  folderIds: [],
};
const shareVisitor: Actor = { kind: ActorKind.ShareVisitor, linkId: 3, imageIds: [11], allowDownload: false };

function albumRow(partial: Partial<Album> = {}): Album {
  return {
    id: 1,
    name: '2026-09 本地次元漫展',
    visibility: Visibility.Member,
    status: AlbumStatus.Normal,
    createUid: 100,
    ...partial,
  } as Album;
}

function imageRow(partial: Partial<Image> = {}): Image {
  return {
    id: 11,
    albumId: 1,
    originalPath: 'originals/2026/09/3f2b6c1a.jpg',
    previewPath: 'derived/preview/11.webp',
    thumbPath: 'derived/thumb/11.webp',
    filename: '场照-01.jpg',
    fileSize: '1024',
    width: 1200,
    height: 800,
    md5: 'a'.repeat(32),
    shotTime: null,
    watermarked: 0,
    visibility: Visibility.Member,
    sort: 0,
    uploadUid: 100,
    uploadTempId: null,
    createTime: new Date('2026-09-12T10:00:00Z'),
    ...partial,
  } as Image;
}

function tagRow(id: number, tagType: TagType, tagName: string, partial: Partial<Tag> = {}): Tag {
  return { id, tagType, tagName, alias: [], useCount: 0, mergedInto: null, createUid: 100, ...partial } as Tag;
}

function imageRef(partial: Partial<ResourceRef> = {}): ResourceRef {
  return {
    type: ResourceType.Image,
    id: 11,
    visibility: Visibility.Member,
    ownerId: 100,
    albumId: 1,
    uploadTempId: null,
    containerVisibilities: [Visibility.Member],
    ...partial,
  };
}

const EVENT1 = tagRow(1, TagType.Event, '本地次元漫展');
const EVENT2 = tagRow(2, TagType.Event, 'CP30');
const ROLE1 = tagRow(3, TagType.Role, '八重神子');
const COSER1 = tagRow(4, TagType.Coser, '小夜');
const STATUS1 = tagRow(5, TagType.Status, '待修');

/** 同一份 fake 同时服务分页查询与标签反查，靠终结方法区分是哪一条 */
class FakeQb {
  conditions: string[] = [];
  params: Record<string, unknown> = {};
  joined: string[] = [];
  havingSql = '';
  groupField = '';
  paging: { skip: number; take: number } | null = null;
  terminal: 'page' | 'raw' | '' = '';

  constructor(
    private readonly rows: Image[],
    private readonly total: number,
    private readonly rawIds: (number | string)[] | null,
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

  innerJoin(_entity: unknown, alias: string): this {
    this.joined.push(alias);
    return this;
  }

  select(): this {
    return this;
  }
  groupBy(field: string): this {
    this.groupField = field;
    return this;
  }
  having(sql: string, params: Record<string, unknown> = {}): this {
    this.havingSql = sql;
    Object.assign(this.params, params);
    return this;
  }
  orderBy(): this {
    return this;
  }
  addOrderBy(): this {
    return this;
  }
  skip(skip: number): this {
    this.paging = { skip, take: this.paging?.take ?? 0 };
    return this;
  }
  take(take: number): this {
    this.paging = { skip: this.paging?.skip ?? 0, take };
    return this;
  }

  async getManyAndCount(): Promise<[Image[], number]> {
    this.terminal = 'page';
    return [this.rows, this.total];
  }

  async getRawMany(): Promise<Array<{ id: number | string }>> {
    this.terminal = 'raw';
    return (this.rawIds ?? []).map((id) => ({ id }));
  }

  get sql(): string {
    return this.conditions.join(' ');
  }
}

interface BuildOptions {
  image?: Image | null;
  rows?: Image[];
  total?: number;
  rawIds?: (number | string)[] | null;
  tags?: Tag[];
  tagLinks?: Array<{ imageId: number; tag: Tag }>;
  album?: Album | null;
  albumsExtra?: Array<[number, Album]>;
  ref?: (id: number) => ResourceRef | null;
  readError?: unknown;
  readSize?: number;
}

interface Harness {
  service: ImageService;
  qbs: FakeQb[];
  pageQb: FakeQb | undefined;
  filterQb: FakeQb | undefined;
  findOne: jest.Mock;
  save: jest.Mock;
  updateRepo: jest.Mock;
  albumGetById: jest.Mock;
  pick: jest.Mock;
  attach: jest.Mock;
  detach: jest.Mock;
  recount: jest.Mock;
  tagsOf: jest.Mock;
  load: jest.Mock;
  read: jest.Mock;
  audit: { record: jest.Mock };
}

function build(options: BuildOptions = {}): Harness {
  const qbs: FakeQb[] = [];
  const rows = options.rows ?? [imageRow()];
  const findOne = jest.fn(async () => (options.image === undefined ? imageRow() : options.image));
  const save = jest.fn(async (row: Image) => row);
  const updateRepo = jest.fn(async () => ({ affected: 1 }));
  const imagesRepo = {
    findOne,
    save,
    update: updateRepo,
    createQueryBuilder: jest.fn(() => {
      const qb = new FakeQb(rows, options.total ?? rows.length, options.rawIds === undefined ? [] : options.rawIds);
      qbs.push(qb);
      return qb;
    }),
  };

  const read = jest.fn(async () => {
    if (options.readError) throw options.readError;
    return { stream: Readable.from([Buffer.from('webp-bytes')]), size: options.readSize ?? 10 };
  });
  const storage = { read } as unknown as StorageService;

  const albumMap = new Map<number, Album | null>();
  albumMap.set(1, options.album === undefined ? albumRow() : options.album);
  for (const [id, album] of options.albumsExtra ?? []) albumMap.set(id, album);
  const albumGetById = jest.fn(async (id: number) => {
    const album = albumMap.get(id);
    if (!album) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', '相册不存在或无权查看');
    return album;
  });
  const albums = {
    getById: albumGetById,
    assertEditable: jest.fn((album: Album) => {
      if (album.status === AlbumStatus.Locked) {
        throw new AppError(HttpStatus.CONFLICT, 'ALBUM_LOCKED', '相册已锁定，禁止上传与修改');
      }
    }),
  } as unknown as AlbumService;

  const pick = jest.fn(async (ids: number[]) => (options.tags ?? []).filter((t) => ids.includes(t.id)));
  const attach = jest.fn(async () => 1);
  const detach = jest.fn(async () => 1);
  const recount = jest.fn(async () => 0);
  const tagsOf = jest.fn(async (imageIds: number[]) =>
    (options.tagLinks ?? []).filter((l) => imageIds.includes(l.imageId)),
  );
  const tags = { pick, attach, detach, recount, tagsOf } as unknown as TagService;

  const resolveRef = options.ref ?? ((id: number) => imageRef({ id }));
  const load = jest.fn(async (_type: ResourceType, id: number) => resolveRef(id));
  const loader = { load } as unknown as ResourceLoader;

  const audit = { record: jest.fn(async () => undefined) };

  const service = new ImageService(
    imagesRepo as never,
    storage,
    loader,
    albums,
    tags,
    audit as unknown as AuditService,
  );

  return {
    service,
    qbs,
    get pageQb() {
      return qbs.find((q) => q.terminal === 'page');
    },
    get filterQb() {
      return qbs.find((q) => q.terminal === 'raw');
    },
    findOne,
    save,
    updateRepo,
    albumGetById,
    pick,
    attach,
    detach,
    recount,
    tagsOf,
    load,
    read,
    audit,
  };
}

const listQuery = (partial: Partial<ListImageDto> = {}): ListImageDto => partial as ListImageDto;
const batchTagsDto = (partial: Partial<BatchTagsDto>): BatchTagsDto =>
  ({ imageIds: [11], ...partial }) as BatchTagsDto;
const batchVisibilityDto = (partial: Partial<BatchVisibilityDto>): BatchVisibilityDto =>
  ({ imageIds: [11], visibility: Visibility.Member, ...partial }) as BatchVisibilityDto;

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  return promise.then(
    () => {
      throw new Error('预期抛出 AppError');
    },
    (err: AppError) => err,
  );
}

describe('组合筛选：类型之间 AND、同类型多值 OR', () => {
  it('没有标签条件时不碰标签表', async () => {
    const h = build();
    await h.service.listInAlbum(1, listQuery(), member(UserLevel.Member));
    expect(h.filterQb).toBeUndefined();
    expect(h.pick).not.toHaveBeenCalled();
    expect(h.pageQb?.sql).not.toContain('m.tagId');
  });

  it('同类型多值合成一个 OR 组，HAVING 组数为 1', async () => {
    const h = build({ tags: [EVENT1, EVENT2], rawIds: [11] });
    await h.service.listInAlbum(1, listQuery({ tags: [1, 2] }), member(UserLevel.Member));
    const qb = h.filterQb;
    expect(qb?.params.tagIds0).toEqual([1, 2]);
    expect(qb?.sql.match(/t\.tagType = :type\d/g)).toHaveLength(1);
    expect(qb?.havingSql).toBe('COUNT(DISTINCT t.tagType) = :groups');
    expect(qb?.params.groups).toBe(1);
    expect(qb?.joined).toEqual(['m', 't']);
  });

  it('跨类型多值各自成组，必须同时命中', async () => {
    const h = build({ tags: [EVENT1, EVENT2, ROLE1], rawIds: [11] });
    await h.service.listInAlbum(1, listQuery({ tags: [1, 2, 3] }), member(UserLevel.Member));
    expect(h.filterQb?.sql.match(/t\.tagType = :type\d/g)).toHaveLength(2);
    expect(h.filterQb?.params.groups).toBe(2);
    expect(h.filterQb?.params.tagIds0).toEqual([1, 2]);
    expect(h.filterQb?.params.tagIds1).toEqual([3]);
  });

  it('标签筛选后仍按图片档位再收一次，命中 id 只作 AND', async () => {
    const h = build({ tags: [EVENT1], rawIds: [11] });
    await h.service.listInAlbum(1, listQuery({ tags: [1] }), guest);
    expect(h.pageQb?.params.ids).toEqual([11]);
    expect(h.pageQb?.params.public).toBe(Visibility.Public);
  });

  it('标签反查为空时直接给空页，不再查分页', async () => {
    const h = build({ tags: [EVENT1], rawIds: [] });
    const result = await h.service.listInAlbum(1, listQuery({ tags: [1] }), member(UserLevel.Member));
    expect(result).toMatchObject({ total: 0, list: [] });
    expect(h.qbs).toHaveLength(1);
  });

  it('未知标签 400，status 传非状态标签也 400', async () => {
    const missing = build({ tags: [EVENT1], rawIds: [11] });
    const err = await errorOf(missing.service.listInAlbum(1, listQuery({ tags: [1, 99] }), member(UserLevel.Member)));
    expect(err.code).toBe('TAG_NOT_FOUND');
    expect(err.message).toContain('99');

    const wrongType = build({ tags: [ROLE1], rawIds: [11] });
    const err2 = await errorOf(wrongType.service.listInAlbum(1, listQuery({ status: [3] }), member(UserLevel.Member)));
    expect(err2.code).toBe('STATUS_TYPE_MISMATCH');
    expect(err2.getStatus()).toBe(400);
  });

  it('status 筛选只对成员开放', async () => {
    const h = build({ tags: [STATUS1], rawIds: [11] });
    const err = await errorOf(h.service.listInAlbum(1, listQuery({ status: [5] }), guest));
    expect(err.code).toBe('STATUS_FILTER_FORBIDDEN');
    expect(err.getStatus()).toBe(403);

    const h2 = build({ tags: [STATUS1], rawIds: [11] });
    const err2 = await errorOf(h2.service.listInAlbum(1, listQuery({ status: [5] }), temp));
    expect(err2.code).toBe('STATUS_FILTER_FORBIDDEN');
  });

  it('分页脏值收敛，翻页用 skip/take', async () => {
    const h = build({ total: 137 });
    const result = await h.service.listInAlbum(1, listQuery({ page: 3, pageSize: 10 }), member(UserLevel.Admin));
    expect(h.pageQb?.paging).toEqual({ skip: 20, take: 10 });
    expect(result).toMatchObject({ page: 3, pageSize: 10, total: 137 });

    const dirty = build({ total: 1 });
    await dirty.service.listInAlbum(1, listQuery({ page: -5, pageSize: 99999 }), member(UserLevel.Admin));
    expect(dirty.pageQb?.paging).toEqual({ skip: 0, take: 100 });
  });
});

describe('档位裁剪与 decide() 同源', () => {
  it('游客只见 public', async () => {
    const h = build();
    await h.service.listInAlbum(1, listQuery(), guest);
    expect(h.pageQb?.sql).toContain('i.visibility = :public');
    expect(h.pageQb?.params.public).toBe(Visibility.Public);
  });

  it('成员可见档位 IN，外加本人 private 例外', async () => {
    const h = build();
    await h.service.listInAlbum(1, listQuery(), member(UserLevel.Member, 100));
    expect(h.pageQb?.params.allowed).toEqual([Visibility.Public, Visibility.Member]);
    expect(h.pageQb?.params.uid).toBe(100);
    expect(h.pageQb?.sql).toContain('i.visibility = :private AND i.uploadUid = :uid');
  });

  it('L4 不再追加档位条件', async () => {
    const h = build();
    await h.service.listInAlbum(1, listQuery(), member(UserLevel.SuperAdmin));
    expect(h.pageQb?.sql).not.toContain('i.visibility');
  });

  it('临时账号按白名单放行，不再按图片档位二次收紧', async () => {
    const h = build();
    await h.service.listInAlbum(1, listQuery(), temp);
    expect(h.pageQb?.sql).not.toContain('i.visibility');
  });

  it('分享访客走不到相册列表这条路径，恒空', async () => {
    const h = build();
    const result = await h.service.listInAlbum(1, listQuery(), shareVisitor);
    expect(result).toMatchObject({ total: 0, list: [] });
    expect(h.qbs).toEqual([]);
  });
});

describe('下发字段裁剪', () => {
  it('游客只拿到漫展与角色标签', async () => {
    const links = [
      { imageId: 11, tag: EVENT1 },
      { imageId: 11, tag: ROLE1 },
      { imageId: 11, tag: COSER1 },
      { imageId: 11, tag: STATUS1 },
    ];
    const h = build({ tagLinks: links });
    const result = await h.service.listInAlbum(1, listQuery(), guest);
    expect(result.list[0].tags.map((t) => t.id)).toEqual([1, 3]);
  });

  it('临时账号拿得到 coser 但拿不到 status', async () => {
    const h = build({ tagLinks: [{ imageId: 11, tag: COSER1 }, { imageId: 11, tag: STATUS1 }] });
    const result = await h.service.listInAlbum(1, listQuery(), temp);
    expect(result.list[0].tags.map((t) => t.id)).toEqual([4]);
  });

  it('成员全量可见', async () => {
    const h = build({ tagLinks: [{ imageId: 11, tag: COSER1 }, { imageId: 11, tag: STATUS1 }] });
    const result = await h.service.listInAlbum(1, listQuery(), member(UserLevel.Admin));
    expect(result.list[0].tags.map((t) => t.id)).toEqual([4, 5]);
  });

  it('响应体里没有磁盘路径，原图链接只发给成员', async () => {
    const h = build();
    const body = JSON.stringify(await h.service.listInAlbum(1, listQuery(), guest));
    expect(body).not.toContain('originals/');
    expect(body).not.toContain('derived/');
    expect(body).not.toContain('originalPath');
    expect(JSON.parse(body).list[0].links.original).toBeNull();

    const h2 = build();
    const admin = await h2.service.listInAlbum(1, listQuery(), member(UserLevel.Admin));
    expect(admin.list[0].links).toEqual({
      preview: '/api/v1/images/11/preview',
      original: '/api/v1/images/11/original',
    });
  });

  it('游客拿不到上传账号，成员与临时账号仍可判断仅本人上传', async () => {
    const h = build();
    const anon = await h.service.listInAlbum(1, listQuery(), guest);
    expect(anon.list[0].uploadUid).toBeNull();
    expect(anon.list[0].uploadTempId).toBeNull();

    const h2 = build();
    expect((await h2.service.listInAlbum(1, listQuery(), member(UserLevel.Member))).list[0].uploadUid).toBe(100);

    const h3 = build();
    expect((await h3.service.listInAlbum(1, listQuery(), temp)).list[0].uploadUid).toBe(100);
  });

  it('图片不存在时 404，不区分无权', async () => {
    const h = build({ image: null });
    const err = await errorOf(h.service.getById(404));
    expect(err.getStatus()).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
  });
});

describe('预览与原图字节出口', () => {
  it('派生图还没生成时给 409，而不是空流', async () => {
    const h = build({ image: imageRow({ previewPath: '' }) });
    const err = await errorOf(h.service.preview(11));
    expect(err.code).toBe('PREVIEW_NOT_READY');
    expect(err.getStatus()).toBe(409);
    expect(h.read).not.toHaveBeenCalled();
  });

  it('预览以 image/webp 下发，长度取自磁盘', async () => {
    const h = build({ readSize: 4096 });
    const file = await h.service.preview(11);
    expect(h.read).toHaveBeenCalledWith('derived/preview/11.webp');
    expect(file.getHeaders()).toMatchObject({ type: 'image/webp', length: 4096 });
    expect(Buffer.from(await readAll(file.getStream()))).toEqual(Buffer.from('webp-bytes'));
  });

  it('原图按附件下发，中文名走 RFC 5987 双写', async () => {
    const h = build({ image: imageRow({ filename: '场照-01.jpg' }) });
    const file = await h.service.original(11);
    const headers = file.getHeaders();
    expect(headers.type).toBe('application/octet-stream');
    expect(headers.disposition).toContain('attachment');
    expect(headers.disposition).toContain('filename="__-01.jpg"');
    expect(headers.disposition).toContain("filename*=UTF-8''%E5%9C%BA%E7%85%A7-01.jpg");
    expect(h.read).toHaveBeenCalledWith('originals/2026/09/3f2b6c1a.jpg');
  });

  it('库里有记录但磁盘文件没了，给 409 而不是 500', async () => {
    const enoent = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    const h = build({ readError: enoent });
    const err = await errorOf(h.service.preview(11));
    expect(err.code).toBe('FILE_MISSING');
    expect(err.getStatus()).toBe(409);
  });

  it('非 ENOENT 的读取错误原样抛出，不伪装成业务异常', async () => {
    const eperm = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const h = build({ readError: eperm });
    await expect(h.service.preview(11)).rejects.toBe(eperm);
  });
});

async function readAll(stream: Readable): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('单图编辑', () => {
  it('没有实际变化时不写库也不记审计', async () => {
    const h = build({ image: imageRow({ sort: 0 }) });
    const result = await h.service.update(11, { sort: 0 } as UpdateImageDto, member(UserLevel.Admin), CTX);
    expect(result.sort).toBe(0);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.audit.record).not.toHaveBeenCalled();
  });

  it('改档位要过 3.2 继承上限', async () => {
    const h = build({
      image: imageRow({ visibility: Visibility.Admin }),
      album: albumRow({ visibility: Visibility.Private }),
    });
    const err = await errorOf(
      h.service.update(11, { visibility: Visibility.Public } as UpdateImageDto, member(UserLevel.SuperAdmin), CTX),
    );
    expect(err.code).toBe('INHERITANCE_VIOLATION');
    expect(err.getStatus()).toBe(409);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('L1 不能把图片设为公开', async () => {
    const h = build({ image: imageRow({ visibility: Visibility.Member }) });
    const err = await errorOf(
      h.service.update(11, { visibility: Visibility.Public } as UpdateImageDto, member(UserLevel.Trainee), CTX),
    );
    expect(err.code).toBe('SET_PUBLIC_FORBIDDEN');
    expect(err.getStatus()).toBe(403);
  });

  it('锁定相册禁止改元数据', async () => {
    const h = build({ album: albumRow({ status: AlbumStatus.Locked }) });
    const err = await errorOf(h.service.update(11, { sort: 5 } as UpdateImageDto, member(UserLevel.SuperAdmin), CTX));
    expect(err.code).toBe('ALBUM_LOCKED');
  });

  it('L2 改他人图片被拒', async () => {
    const h = build({ ref: () => imageRef({ ownerId: 200 }) });
    const err = await errorOf(h.service.update(11, { sort: 5 } as UpdateImageDto, member(UserLevel.Member), CTX));
    expect(err.code).toBe('NOT_OWNER');
    expect(err.getStatus()).toBe(403);
  });

  it('拍摄时间可写可清空，审计里只记变更字段名', async () => {
    const h = build();
    await h.service.update(11, { shotTime: '2026-09-12T14:30:00' } as UpdateImageDto, member(UserLevel.Admin), CTX);
    expect(h.save.mock.calls[0][0].shotTime).toEqual(new Date('2026-09-12T14:30:00'));

    const h2 = build({ image: imageRow({ shotTime: new Date('2026-09-12T14:30:00') }) });
    await h2.service.update(11, { shotTime: null } as UpdateImageDto, member(UserLevel.Admin), CTX);
    expect(h2.save.mock.calls[0][0].shotTime).toBeNull();
    expect(h2.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      CTX,
      expect.objectContaining({ action: 'image_update', targetType: LogTargetType.Image, detail: 'shotTime' }),
    );
  });

  it('档位变更把新旧值写进审计，便于追溯', async () => {
    const h = build({ image: imageRow({ visibility: Visibility.Member }) });
    await h.service.update(11, { visibility: Visibility.Admin } as UpdateImageDto, member(UserLevel.Admin), CTX);
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      CTX,
      expect.objectContaining({ detail: `visibility:${Visibility.Member}→${Visibility.Admin}` }),
    );
  });
});

describe('批量打标：逐条判定，不静默跳过', () => {
  it('add 与 remove 都为空时拒绝', async () => {
    const h = build();
    const err = await errorOf(h.service.batchTags(batchTagsDto({}), member(UserLevel.Admin), CTX));
    expect(err.code).toBe('NOTHING_TO_DO');
    expect(err.getStatus()).toBe(400);
  });

  it('L1 不能使用批量操作', async () => {
    const h = build();
    const err = await errorOf(h.service.batchTags(batchTagsDto({ add: [1] }), member(UserLevel.Trainee), CTX));
    expect(err.code).toBe('BATCH_FORBIDDEN');
    expect(err.getStatus()).toBe(403);
    expect(h.attach).not.toHaveBeenCalled();
  });

  it('标签不存在 / 已合并 / 状态标签越权都在写库前拦住', async () => {
    const missing = build({ tags: [EVENT1] });
    const e1 = await errorOf(missing.service.batchTags(batchTagsDto({ add: [1, 99] }), member(UserLevel.Admin), CTX));
    expect(e1.code).toBe('TAG_NOT_FOUND');

    const merged = build({ tags: [tagRow(1, TagType.Event, '旧名', { mergedInto: 2 })] });
    const e2 = await errorOf(merged.service.batchTags(batchTagsDto({ add: [1] }), member(UserLevel.Admin), CTX));
    expect(e2.code).toBe('TAG_MERGED');
    expect(e2.message).toContain('旧名');

    const statusTag = build({ tags: [STATUS1] });
    const e3 = await errorOf(statusTag.service.batchTags(batchTagsDto({ add: [5] }), temp, CTX));
    expect(e3.code).toBe('STATUS_TAG_FORBIDDEN');
    expect(e3.getStatus()).toBe(403);
  });

  it('无权项进清单，其余照常写入', async () => {
    const h = build({
      tags: [EVENT1, COSER1],
      ref: (id) => (id === 11 ? imageRef({ id }) : id === 12 ? imageRef({ id, ownerId: 200 }) : null),
    });
    const result = await h.service.batchTags(
      batchTagsDto({ imageIds: [11, 12, 13], add: [1], remove: [4] }),
      member(UserLevel.Member),
      CTX,
    );
    expect(result).toMatchObject({ requested: 3, updated: 1 });
    expect(result.rejected).toEqual([
      { imageId: 12, status: 403, code: 'NOT_OWNER', message: '只能操作本人上传的资源' },
      { imageId: 13, status: 404, code: 'NOT_FOUND', message: '图片不存在或无权查看' },
    ]);
    expect(h.attach).toHaveBeenCalledTimes(1);
    expect(h.attach).toHaveBeenCalledWith(11, [1]);
    expect(h.detach).toHaveBeenCalledWith(11, [4]);
  });

  it('锁定相册的图片进清单而不是中断整批', async () => {
    const h = build({ tags: [EVENT1], album: albumRow({ status: AlbumStatus.Locked }) });
    const result = await h.service.batchTags(batchTagsDto({ add: [1] }), member(UserLevel.Admin), CTX);
    expect(result).toMatchObject({ requested: 1, updated: 0 });
    expect(result.rejected[0]).toMatchObject({ imageId: 11, status: 409, code: 'ALBUM_LOCKED' });
    expect(h.attach).not.toHaveBeenCalled();
  });

  it('同一相册的多张图只查一次相册', async () => {
    const h = build({
      tags: [EVENT1],
      ref: (id) => imageRef({ id }),
    });
    await h.service.batchTags(batchTagsDto({ imageIds: [11, 12], add: [1] }), member(UserLevel.Admin), CTX);
    expect(h.albumGetById).toHaveBeenCalledTimes(1);
    expect(h.attach).toHaveBeenCalledTimes(2);
  });

  it('全部被拒时不重算标签频次', async () => {
    const h = build({ tags: [EVENT1], ref: () => null });
    const result = await h.service.batchTags(batchTagsDto({ add: [1] }), member(UserLevel.Admin), CTX);
    expect(result.updated).toBe(0);
    expect(h.recount).not.toHaveBeenCalled();
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      CTX,
      expect.objectContaining({ action: 'image_batch_tags', detail: 'images=1, ok=0, rejected=1, add=1, remove=' }),
    );
  });

  it('只对真正写过的标签重算频次', async () => {
    const h = build({ tags: [EVENT1, COSER1] });
    await h.service.batchTags(batchTagsDto({ imageIds: [11], add: [1], remove: [4] }), member(UserLevel.Admin), CTX);
    expect(h.recount).toHaveBeenCalledWith([1, 4]);
  });
});

describe('批量改档位', () => {
  it('L1 直接拒绝整批', async () => {
    const h = build();
    const err = await errorOf(
      h.service.batchVisibility(batchVisibilityDto({}), member(UserLevel.Trainee), CTX),
    );
    expect(err.code).toBe('BATCH_FORBIDDEN');
  });

  it('继承不合规项回清单，合规矩照常落库', async () => {
    const h = build({
      albumsExtra: [[2, albumRow({ id: 2, visibility: Visibility.Private })]],
      ref: (id) => (id === 11 ? imageRef({ id }) : imageRef({ id, albumId: 2 })),
    });
    const result = await h.service.batchVisibility(
      batchVisibilityDto({ imageIds: [11, 12], visibility: Visibility.Member }),
      member(UserLevel.Admin),
      CTX,
    );
    expect(result).toMatchObject({ requested: 2, updated: 1 });
    expect(result.rejected[0]).toMatchObject({ imageId: 12, status: 409, code: 'INHERITANCE_VIOLATION' });
    expect(h.updateRepo).toHaveBeenCalledTimes(1);
    expect(h.updateRepo).toHaveBeenCalledWith({ id: 11 }, { visibility: Visibility.Member });
  });

  it('锁定相册与不存在的图片各自回清单，不写库', async () => {
    const h = build({
      albumsExtra: [[2, albumRow({ id: 2, status: AlbumStatus.Locked })]],
      ref: (id) => (id === 11 ? imageRef({ id, albumId: 2 }) : null),
    });
    const result = await h.service.batchVisibility(
      batchVisibilityDto({ imageIds: [11, 12], visibility: Visibility.Admin }),
      member(UserLevel.Admin),
      CTX,
    );
    expect(result.updated).toBe(0);
    expect(result.rejected.map((r) => r.code)).toEqual(['ALBUM_LOCKED', 'NOT_FOUND']);
    expect(h.updateRepo).not.toHaveBeenCalled();
  });

  it('无权图片一律按 404 处理，不用 403 泄露存在性', async () => {
    const h = build({ ref: () => imageRef({ visibility: Visibility.Private, ownerId: 200, containerVisibilities: [Visibility.Private] }) });
    const result = await h.service.batchVisibility(
      batchVisibilityDto({ visibility: Visibility.Member }),
      member(UserLevel.Member),
      CTX,
    );
    expect(result.rejected[0]).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('目标档位与变更条数写进审计', async () => {
    const h = build();
    await h.service.batchVisibility(batchVisibilityDto({ visibility: Visibility.Admin }), member(UserLevel.Admin), CTX);
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      CTX,
      expect.objectContaining({
        action: 'image_batch_visibility',
        detail: `images=1, ok=1, rejected=0, target=${Visibility.Admin}`,
      }),
    );
  });
});
