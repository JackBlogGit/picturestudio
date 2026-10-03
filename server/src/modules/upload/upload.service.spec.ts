import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AppError } from '../../common/http/app-error';
import { UserLevel } from '../../common/enums/user-level.enum';
import { Visibility } from '../../common/enums/visibility.enum';
import { ResourceRef, Actor, ActorKind, ResourceType } from '../../common/permission/types';
import { FileKindService } from '../../common/storage/file-kind.service';
import {
  chunkKey,
  DIR_CHUNK,
  DIR_DERIVE,
  newUploadId,
  stagingKey,
} from '../../common/storage/storage-path';
import { StorageService } from '../../common/storage/storage.service';
import {
  Album,
  AlbumStatus,
  Image,
  TempAccount,
  UploadResourceType,
  UploadSession,
  User,
} from '../../entities';
import { AuditService, RequestContext } from '../audit/audit.service';
import { AlbumService } from '../album/album.service';
import { DerivativeService } from '../image/derivative.service';
import { SettingsService } from '../settings/settings.service';
import { ResourceLoader } from '../../common/permission/resource-loader';
import {
  chunkPlan,
  formatChunks,
  MAX_CHUNKS,
  parseChunks,
  SESSION_TTL_MS,
  UploadService,
} from './upload.service';

const CTX: RequestContext = { ip: '10.0.0.9', ua: 'jest' };
const UPLOAD_ID = '3f2b6c1a-9d4e-4a77-8b21-0c5f6d2e1a44';
const CREATED = new Date('2026-09-30T10:00:00Z');
const SHOT = new Date('2026-09-12T14:03:05Z');

function member(level: UserLevel = UserLevel.Member, uid = 100): Actor {
  return { kind: ActorKind.Member, uid, level };
}
const guest: Actor = { kind: ActorKind.Guest };
function temp(partial: Partial<Extract<Actor, { kind: ActorKind.Temp }>> = {}): Actor {
  return {
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
    ...partial,
  };
}

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

function albumRef(album = albumRow()): ResourceRef {
  return {
    type: ResourceType.Album,
    id: album.id,
    visibility: album.visibility,
    ownerId: album.createUid,
    albumId: album.id,
    containerVisibilities: [],
  };
}

const CHUNK_A = Buffer.alloc(300, 7);
const CHUNK_B = Buffer.alloc(200, 9);
const WHOLE = Buffer.concat([CHUNK_A, CHUNK_B]);
const MD5_WHOLE = createHash('md5').update(WHOLE).digest('hex');

function sessionRow(partial: Partial<UploadSession> = {}): UploadSession {
  return {
    id: 5,
    uploadId: UPLOAD_ID,
    resourceType: UploadResourceType.Image,
    albumId: 1,
    folderId: null,
    filename: 'IMG_0233.jpg',
    fileSize: String(WHOLE.length),
    chunkSize: 512,
    totalChunks: 2,
    uploadedChunks: '0,1',
    md5Client: '',
    userType: 'user',
    uid: 100,
    tempId: null,
    status: 0,
    expireTime: new Date(Date.now() + 3_600_000),
    createTime: CREATED,
    updateTime: CREATED,
    ...partial,
  } as UploadSession;
}

/** 内存版存储：让 concat / exists / move 这些真实语义参与测试，而不是把整条链路都 mock 掉 */
class FakeStorage {
  readonly files = new Map<string, Buffer>();
  readonly moved: Array<[string, string]> = [];
  readonly removed: string[] = [];

  seedChunks(uploadId = UPLOAD_ID): void {
    this.files.set(chunkKey(uploadId, 0), CHUNK_A);
    this.files.set(chunkKey(uploadId, 1), CHUNK_B);
  }

  staged(uploadId = UPLOAD_ID): boolean {
    return this.files.has(stagingKey(uploadId, 'merged.bin'));
  }

  chunkLeft(uploadId = UPLOAD_ID): boolean {
    return [...this.files.keys()].some((k) => k.startsWith(`${DIR_CHUNK}/${uploadId}/`));
  }

  deriveLeft(uploadId = UPLOAD_ID): boolean {
    return [...this.files.keys()].some((k) => k.startsWith(`${DIR_DERIVE}/${uploadId}/`));
  }

  async write(rel: string, data: Buffer): Promise<number> {
    this.files.set(rel, Buffer.from(data));
    return data.length;
  }

  async buffer(rel: string): Promise<Buffer> {
    const found = this.files.get(rel);
    if (!found) throw new Error(`ENOENT ${rel}`);
    return found;
  }

  async exists(rel: string): Promise<boolean> {
    return this.files.has(rel);
  }

  async concat(target: string, sources: string[], sink?: (chunk: Buffer) => void): Promise<number> {
    const parts: Buffer[] = [];
    for (const src of sources) {
      const found = this.files.get(src);
      if (!found) throw new Error(`ENOENT ${src}`);
      parts.push(found);
      sink?.(found);
    }
    const merged = Buffer.concat(parts);
    this.files.set(target, merged);
    return merged.length;
  }

  async move(from: string, to: string): Promise<void> {
    const found = this.files.get(from);
    if (!found) throw new Error(`ENOENT ${from}`);
    this.files.delete(from);
    this.files.set(to, found);
    this.moved.push([from, to]);
  }

  async remove(...rels: Array<string | null | undefined>): Promise<void> {
    for (const rel of rels) {
      if (!rel) continue;
      this.removed.push(rel);
      this.files.delete(rel);
    }
  }

  async removeTree(dir: string): Promise<void> {
    for (const key of [...this.files.keys()]) {
      if (key === dir || key.startsWith(`${dir}/`)) {
        this.files.delete(key);
        this.removed.push(key);
      }
    }
  }
}

interface Options {
  album?: Album | null;
  ref?: ResourceRef | null;
  session?: UploadSession | null;
  /** 归属账号的配额行，null 表示行不存在 */
  account?: { usedSpace: string; spaceQuota: string } | null;
  settings?: Record<string, number>;
  dup?: { id: number; albumId: number; originalPath: string } | null;
  /** true 时魔数校验判定为非法类型 */
  badKind?: boolean;
  deriveFails?: boolean;
}

interface Harness {
  service: UploadService;
  storage: FakeStorage;
  album: Album;
  savedSessions: UploadSession[];
  updateSession: jest.Mock;
  findOneSession: jest.Mock;
  accountLookups: unknown[];
  accountUpdates: Array<Record<string, unknown>>;
  imageDrafts: Array<Record<string, unknown>>;
  imageUpdates: Array<[{ id: number }, Record<string, unknown>]>;
  getRepository: jest.Mock;
  transaction: jest.Mock;
  auditEvents: Array<Record<string, unknown>>;
  assertAllowed: jest.Mock;
}

function build(options: Options = {}): Harness {
  const album = options.album === null ? albumRow() : (options.album ?? albumRow());
  const ref = options.ref === undefined ? albumRef(album) : options.ref;
  const session = options.session === undefined ? sessionRow() : options.session;
  const account = options.account === undefined ? { usedSpace: '1000', spaceQuota: '0' } : options.account;
  const config: Record<string, number> = {
    'upload.max_image_size': 50 * 1024 * 1024,
    'upload.chunk_size': 5 * 1024 * 1024,
    ...options.settings,
  };

  const storage = new FakeStorage();
  const savedSessions: UploadSession[] = [];
  const createSession = jest.fn((input: Partial<UploadSession>) => ({ id: 5, ...input }) as UploadSession);
  const saveSession = jest.fn(async (row: UploadSession) => {
    savedSessions.push(row);
    return row;
  });
  const updateSession = jest.fn(async () => ({ affected: 1 }));
  const findSessions = jest.fn(async () => (session ? [session] : []));
  const findOneSession = jest.fn(async () => session);
  const sessions = {
    findOne: findOneSession,
    save: saveSession,
    create: createSession,
    update: updateSession,
    find: findSessions,
  };

  const dup = options.dup === undefined ? null : options.dup;
  const imageUpdates: Array<[{ id: number }, Record<string, unknown>]> = [];
  const images = {
    findOne: jest.fn(async () => dup),
    update: jest.fn(async (where: { id: number }, patch: Record<string, unknown>) => {
      imageUpdates.push([where, patch]);
      return { affected: 1 };
    }),
  };

  const accountLookups: unknown[] = [];
  const accountUpdates: Array<Record<string, unknown>> = [];
  const accountRepo = {
    findOne: jest.fn(async (query: unknown) => {
      accountLookups.push(query);
      return account === null ? null : { id: 100, ...account };
    }),
    update: jest.fn(async (_where: unknown, data: Record<string, unknown>) => {
      accountUpdates.push(data);
      return { affected: 1 };
    }),
  };
  const imageDrafts: Array<Record<string, unknown>> = [];
  const imageRepo = {
    create: jest.fn((input: Record<string, unknown>) => {
      imageDrafts.push(input);
      return input;
    }),
    save: jest.fn(async (row: Record<string, unknown>) => ({
      ...row,
      id: 42,
      createTime: CREATED,
      updateTime: CREATED,
    })),
  };
  const getRepository = jest.fn((entity: unknown) =>
    entity === Image ? imageRepo : accountRepo,
  );
  const em = { getRepository };
  const transaction = jest.fn(async (cb: (manager: unknown) => Promise<unknown>) => cb(em));
  const dataSource = {
    transaction,
    manager: em,
  } as unknown as DataSource;

  const settings = {
    getNumber: jest.fn((key: string, fallback: number) => config[key] ?? fallback),
  } as unknown as SettingsService;

  const assertAllowed = jest.fn(async () => {
    if (options.badKind) throw new AppError(400, 'TYPE_NOT_ALLOWED', '文件真实类型不在图片白名单内');
    return { ext: 'jpg', mime: 'image/jpeg' };
  });

  const probe = jest.fn(async (source: Buffer) => {
    if (options.deriveFails) throw new Error('libvips 不可用');
    return {
      info: { width: 4000, height: 3000, shotTime: SHOT, fromEmbeddedPreview: false },
      renderable: source,
    };
  });
  const render = jest.fn(async () => ({
    preview: Buffer.from('preview-bytes'),
    thumb: Buffer.from('thumb-bytes'),
    watermarked: 1 as const,
  }));

  // AlbumService 的锁定规则已由 album.service.spec 覆盖，这里只保留同一条 409
  const getById = jest.fn(async () => {
    if (options.album === null) {
      throw new AppError(404, 'NOT_FOUND', '相册不存在或无权查看');
    }
    return album;
  });
  const albums = {
    getById,
    assertEditable: jest.fn((row: Album) => {
      if (row.status === AlbumStatus.Locked) {
        throw new AppError(409, 'ALBUM_LOCKED', '相册已锁定，禁止上传与修改');
      }
    }),
  } as unknown as AlbumService;

  const load = jest.fn(async () => ref);
  const auditEvents: Array<Record<string, unknown>> = [];
  const audit = {
    record: jest.fn(async (_actor: unknown, _ctx: unknown, input: Record<string, unknown>) => {
      auditEvents.push(input);
    }),
  } as unknown as AuditService;

  const service = new UploadService(
    sessions as never,
    images as never,
    dataSource,
    storage as unknown as StorageService,
    { assertAllowed } as unknown as FileKindService,
    { probe, render } as unknown as DerivativeService,
    settings,
    { load } as unknown as ResourceLoader,
    albums,
    audit,
  );

  return {
    service,
    storage,
    album,
    savedSessions,
    updateSession,
    findOneSession,
    accountLookups,
    accountUpdates,
    imageDrafts,
    imageUpdates,
    getRepository,
    transaction,
    auditEvents,
    assertAllowed,
  };
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

const createDto = (partial: Partial<{ albumId: number; filename: string; fileSize: number; md5Client: string }> = {}) =>
  ({ albumId: 1, filename: 'IMG_0233.jpg', fileSize: WHOLE.length, ...partial }) as never;

describe('分片计划与进度列编解码', () => {
  it('默认 5MB 片长：12MB 切成 3 片', () => {
    expect(chunkPlan(12 * 1024 * 1024, 5 * 1024 * 1024)).toEqual({
      chunkSize: 5 * 1024 * 1024,
      totalChunks: 3,
    });
  });

  it('大文件自动放大片长，片数始终不超过预算', () => {
    const plan = chunkPlan(2_147_483_648, 5 * 1024 * 1024);
    expect(plan.totalChunks).toBeLessThanOrEqual(MAX_CHUNKS);
    expect(plan.chunkSize).toBe(Math.ceil(2_147_483_648 / MAX_CHUNKS));
  });

  it('小文件不细碎化：片长下限 256KB，1KB 只有 1 片', () => {
    expect(chunkPlan(1024, 5 * 1024 * 1024)).toEqual({ chunkSize: 5 * 1024 * 1024, totalChunks: 1 });
    expect(chunkPlan(300 * 1024, 64 * 1024).chunkSize).toBe(256 * 1024);
  });

  it('uploaded_chunks 脏值按未上传处理，空串不算第 0 片，写入前去重并排序', () => {
    expect(parseChunks('2,0,abc,,5')).toEqual([2, 0, 5]);
    expect(parseChunks(',0')).toEqual([0]);
    expect(parseChunks('')).toEqual([]);
    expect(formatChunks([3, 1, 3, 0, -2, 1.5])).toBe('0,1,3');
  });
});

describe('create：会话建立前的闸门', () => {
  it('成员建会话：分片参数、24 小时过期、空进度一起入库并记审计', async () => {
    const h = build();
    const view = await h.service.create(createDto({ md5Client: MD5_WHOLE.toUpperCase() }), member(), CTX);

    const row = h.savedSessions[0];
    expect(row.uploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.albumId).toBe(1);
    expect(row.fileSize).toBe(String(WHOLE.length));
    expect(row.totalChunks).toBe(1);
    expect(row.uploadedChunks).toBe('');
    expect(row.md5Client).toBe(MD5_WHOLE);
    expect(row.resourceType).toBe(UploadResourceType.Image);
    expect(view.uploaded).toEqual([]);
    expect(view.missing).toEqual([0]);
    expect(new Date(row.expireTime).getTime() - Date.now()).toBeGreaterThan(SESSION_TTL_MS - 60_000);
    expect(h.auditEvents[0]).toMatchObject({ action: 'upload_session_create', targetId: 5 });
  });

  it('客户端文件名只入库，不参与任何路径', async () => {
    const h = build();
    await h.service.create(createDto({ filename: '../../etc/passwd.jpg' }), member(), CTX);
    expect(h.savedSessions[0].filename).toBe('../../etc/passwd.jpg');
    expect(h.storage.files.size).toBe(0);
  });

  it('游客：公开相册也只给 403，不给写入口', async () => {
    const h = build({ album: albumRow({ visibility: Visibility.Public }), ref: albumRef(albumRow({ visibility: Visibility.Public })) });
    const err = await errorOf(h.service.create(createDto(), guest, CTX));
    expect([err.getStatus(), err.code]).toEqual([403, 'GUEST_FORBIDDEN']);
    expect(h.savedSessions).toHaveLength(0);
  });

  it('临时账号：白名单外的相册统一 404，不泄露存在性', async () => {
    const h = build();
    const err = await errorOf(h.service.create(createDto(), temp({ albumIds: [99] }), CTX));
    expect([err.getStatus(), err.code]).toEqual([404, 'NOT_IN_WHITELIST']);
  });

  it('临时账号：上传按身份硬拦，三项开关全开也 403（D27）', async () => {
    const h = build();
    const err = await errorOf(
      h.service.create(createDto(), temp({ flags: { preview: true, download: true, editTag: true } }), CTX),
    );
    expect([err.getStatus(), err.code]).toEqual([403, 'TEMP_UPLOAD_FORBIDDEN']);
    expect(h.savedSessions).toHaveLength(0);
  });

  it('锁定相册禁止上传：409', async () => {
    const h = build({ album: albumRow({ status: AlbumStatus.Locked }) });
    const err = await errorOf(h.service.create(createDto(), member(), CTX));
    expect([err.getStatus(), err.code]).toEqual([409, 'ALBUM_LOCKED']);
    expect(h.savedSessions).toHaveLength(0);
  });

  it('相册查不到时不落会话', async () => {
    const h = build({ album: null });
    const err = await errorOf(h.service.create(createDto(), member(), CTX));
    expect(err.getStatus()).toBe(404);
    expect(h.savedSessions).toHaveLength(0);
  });

  it('loader 取不到资源引用时按不存在处理', async () => {
    const h = build({ ref: null });
    const err = await errorOf(h.service.create(createDto(), member(), CTX));
    expect([err.getStatus(), err.code]).toEqual([404, 'NOT_FOUND']);
  });

  it('声明体积超过站点上限：413', async () => {
    const h = build({ settings: { 'upload.max_image_size': 1024 } });
    const err = await errorOf(h.service.create(createDto({ fileSize: 4096 }), member(), CTX));
    expect([err.getStatus(), err.code]).toEqual([413, 'FILE_TOO_BIG']);
  });

  it('配额预检：装不下的文件在建会话阶段就拒绝', async () => {
    const h = build({ account: { usedSpace: '900', spaceQuota: '1000' } });
    const err = await errorOf(h.service.create(createDto({ fileSize: 200 }), member(), CTX));
    expect(err.getStatus()).toBe(413);
    expect(err.code).toBe('QUOTA_EXCEEDED');
    expect(err.data).toMatchObject({ used: 900, quota: 1000, need: 200 });
    expect(err.message).toBe('空间不足，已用 900/1000 字节');
    expect(h.savedSessions).toHaveLength(0);
  });

  it('配额为 0 表示不限量', async () => {
    const h = build({ account: { usedSpace: '999999999', spaceQuota: '0' } });
    await expect(h.service.create(createDto(), member(), CTX)).resolves.toBeTruthy();
  });
});

describe('会话归属与状态机', () => {
  it('别人（以及游客）的会话一律 404', async () => {
    const h = build();
    const err = await errorOf(h.service.status(UPLOAD_ID, member(UserLevel.SuperAdmin, 555)));
    expect([err.getStatus(), err.code]).toEqual([404, 'UPLOAD_NOT_FOUND']);
    await expect(h.service.status(UPLOAD_ID, guest)).rejects.toBeInstanceOf(AppError);
  });

  it('非法 uploadId 连库都不查', async () => {
    const h = build();
    const err = await errorOf(h.service.status('../../etc', member()));
    expect([err.getStatus(), err.code]).toEqual([404, 'UPLOAD_NOT_FOUND']);
    expect(h.findOneSession).not.toHaveBeenCalled();
  });

  it('过期 410 / 已完成 409 / 已作废 409', async () => {
    const expired = build({ session: sessionRow({ expireTime: new Date(Date.now() - 1000) }) });
    expect((await errorOf(expired.service.status(UPLOAD_ID, member()))).code).toBe('UPLOAD_EXPIRED');
    expect((await errorOf(expired.service.status(UPLOAD_ID, member()))).getStatus()).toBe(410);

    const done = build({ session: sessionRow({ status: 1 }) });
    expect((await errorOf(done.service.complete(UPLOAD_ID, {}, member(), CTX))).code).toBe('UPLOAD_COMPLETED');

    const aborted = build({ session: sessionRow({ status: 2 }) });
    expect((await errorOf(aborted.service.putChunk(UPLOAD_ID, 0, CHUNK_A, member()))).code).toBe('UPLOAD_ABORTED');
  });

  it('临时账号只能操作自己的会话，主人身份也不行', async () => {
    const h = build({ session: sessionRow({ userType: 'temp', uid: null, tempId: 8 }) });
    const err = await errorOf(h.service.status(UPLOAD_ID, temp({ tempId: 7 })));
    expect([err.getStatus(), err.code]).toEqual([404, 'UPLOAD_NOT_FOUND']);
  });

  it('断点续传以磁盘为准：进度列说传完了也不算', async () => {
    const h = build({ session: sessionRow({ uploadedChunks: '0,1' }) });
    const view = await h.service.status(UPLOAD_ID, member());
    expect(view.missing).toEqual([0, 1]);
    expect(view.uploaded).toEqual([]);
  });
});

describe('putChunk：分片落盘', () => {
  it('写入分片目录并回写进度列', async () => {
    const h = build({ session: sessionRow({ uploadedChunks: '' }) });
    h.storage.files.set(chunkKey(UPLOAD_ID, 1), CHUNK_B);

    const res = await h.service.putChunk(UPLOAD_ID, 0, CHUNK_A, member());
    expect(h.storage.files.get(chunkKey(UPLOAD_ID, 0))).toEqual(CHUNK_A);
    expect(res).toEqual({ uploaded: 2, total: 2, missing: [] });
    expect(h.updateSession).toHaveBeenCalledWith({ id: 5 }, { uploadedChunks: '0' });
  });

  it('重复上传同一片不会把进度列写爆', async () => {
    const h = build({ session: sessionRow({ uploadedChunks: '0' }) });
    await h.service.putChunk(UPLOAD_ID, 0, CHUNK_A, member());
    expect(h.updateSession.mock.calls[0][1].uploadedChunks).toBe('0');
  });

  it('下标越界 / 空分片 / 超过片长上限', async () => {
    const h = build();
    expect((await errorOf(h.service.putChunk(UPLOAD_ID, 2, CHUNK_A, member()))).code).toBe('CHUNK_INDEX_INVALID');
    expect((await errorOf(h.service.putChunk(UPLOAD_ID, 0, Buffer.alloc(0), member()))).code).toBe('EMPTY_CHUNK');
    const tiny = build({ session: sessionRow({ chunkSize: 64 }) });
    const err = await errorOf(tiny.service.putChunk(UPLOAD_ID, 0, CHUNK_A, member()));
    expect([err.getStatus(), err.code]).toEqual([413, 'CHUNK_TOO_BIG']);
  });
});

describe('complete：合并 → 校验 → 查重 → 落库', () => {
  it('缺片时 409 并回传缺失下标，原图一行都不写', async () => {
    const h = build();
    h.storage.files.set(chunkKey(UPLOAD_ID, 0), CHUNK_A);
    const err = await errorOf(h.service.complete(UPLOAD_ID, {}, member(), CTX));
    expect([err.getStatus(), err.code]).toEqual([409, 'MISSING_CHUNKS']);
    expect(err.data).toEqual({ missing: [1] });
    expect(h.imageDrafts).toHaveLength(0);
    expect(h.storage.deriveLeft()).toBe(false);
  });

  it('合并体积与声明不符 → 400，临时产物清干净', async () => {
    const h = build({ session: sessionRow({ fileSize: String(WHOLE.length + 1) }) });
    h.storage.seedChunks();
    const err = await errorOf(h.service.complete(UPLOAD_ID, {}, member(), CTX));
    expect([err.getStatus(), err.code]).toEqual([400, 'SIZE_MISMATCH']);
    expect(h.storage.staged()).toBe(false);
    expect(h.imageDrafts).toHaveLength(0);
  });

  it('MD5 不符 → 400（判定传输损坏），格式非法 → 400', async () => {
    const h = build();
    h.storage.seedChunks();
    const err = await errorOf(h.service.complete(UPLOAD_ID, { md5Client: '0'.repeat(32) }, member(), CTX));
    expect([err.getStatus(), err.code]).toEqual([400, 'MD5_MISMATCH']);
    expect(h.storage.staged()).toBe(false);

    const bad = build();
    bad.storage.seedChunks();
    expect((await errorOf(bad.service.complete(UPLOAD_ID, { md5Client: 'zz' }, member(), CTX))).code).toBe('MD5_FORMAT');
  });

  it('魔数判定不通过时碎片一并丢弃，不给重试留垃圾', async () => {
    const h = build({ badKind: true });
    h.storage.seedChunks();
    const err = await errorOf(h.service.complete(UPLOAD_ID, {}, member(), CTX));
    expect([err.getStatus(), err.code]).toEqual([400, 'TYPE_NOT_ALLOWED']);
    expect(h.storage.chunkLeft()).toBe(false);
    expect(h.storage.staged()).toBe(false);
    expect(h.assertAllowed).toHaveBeenCalledWith('image', WHOLE, 'IMG_0233.jpg');
  });

  it('查重命中：409 带已存图片预览链接，分片保留给「仍要上传」', async () => {
    const h = build({ dup: { id: 77, albumId: 1, originalPath: 'originals/2026/09/fixed.jpg' } });
    h.storage.seedChunks();
    const err = await errorOf(h.service.complete(UPLOAD_ID, { md5Client: MD5_WHOLE }, member(), CTX));
    expect([err.getStatus(), err.code]).toEqual([409, 'DUPLICATE_IMAGE']);
    expect(err.data).toEqual({ imageId: 77, albumId: 1, preview: '/api/v1/images/77/preview' });
    expect(h.storage.chunkLeft()).toBe(true);
    expect(h.storage.staged()).toBe(false);
    expect(h.imageDrafts).toHaveLength(0);
  });

  it('秒传强制重传：复用同一路径，磁盘不产生第二份原图', async () => {
    const path = 'originals/2026/09/fixed.jpg';
    const h = build({ dup: { id: 77, albumId: 1, originalPath: path } });
    h.storage.seedChunks();
    h.storage.files.set(path, WHOLE);

    await h.service.complete(UPLOAD_ID, { md5Client: MD5_WHOLE, force: true }, member(), CTX);
    expect(h.imageDrafts[0].originalPath).toBe(path);
    expect(h.storage.moved).toHaveLength(0);
    expect(h.storage.files.get(path)).toEqual(WHOLE);
  });

  it('原图按 UUID 落到 originals/YYYY/MM，派生图落到 image_id 固定路径', async () => {
    const h = build();
    h.storage.seedChunks();
    const view = await h.service.complete(UPLOAD_ID, { md5Client: MD5_WHOLE }, member(), CTX);

    const draft = h.imageDrafts[0];
    expect(draft.originalPath).toMatch(/^originals\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/);
    expect(draft.md5).toBe(MD5_WHOLE);
    expect(draft.fileSize).toBe(String(WHOLE.length));
    expect(draft.visibility).toBe(Visibility.Member);
    expect(draft.uploadUid).toBe(100);
    expect(draft.uploadTempId).toBeNull();
    expect(h.storage.files.get(draft.originalPath as string)).toEqual(WHOLE);
    expect(view.links.preview).toBe('/api/v1/images/42/preview');
    expect(view).not.toHaveProperty('originalPath');
    expect(view.width).toBe(4000);
    expect(view.shotTime).toEqual(SHOT);
    expect(view.watermarked).toBe(1);
  });

  it('新图档位继承相册，绝不上浮', async () => {
    const h = build({ album: albumRow({ visibility: Visibility.Public }) });
    h.storage.seedChunks();
    await h.service.complete(UPLOAD_ID, {}, member(), CTX);
    expect(h.imageDrafts[0].visibility).toBe(Visibility.Public);
  });

  it('配额与图片记录同事务、行锁、并累加 used_space', async () => {
    const h = build({ account: { usedSpace: '1000', spaceQuota: '5000' } });
    h.storage.seedChunks();
    await h.service.complete(UPLOAD_ID, {}, member(), CTX);
    expect(h.transaction).toHaveBeenCalled();
    expect(h.getRepository).toHaveBeenCalledWith(Image);
    expect(h.getRepository).toHaveBeenCalledWith(User);
    expect(h.accountLookups[0]).toMatchObject({ where: { id: 100 }, lock: { mode: 'pessimistic_write' } });
    expect(h.accountUpdates).toEqual([{ usedSpace: String(1000 + WHOLE.length) }]);
  });

  it('临时账号即便已有会话也完不成上传：落库前按身份硬拦，配额不动（D27）', async () => {
    const h = build({ session: sessionRow({ userType: 'temp', uid: null, tempId: 7 }) });
    h.storage.seedChunks();
    const err = await errorOf(h.service.complete(UPLOAD_ID, {}, temp(), CTX));
    expect([err.getStatus(), err.code]).toEqual([403, 'TEMP_UPLOAD_FORBIDDEN']);
    expect(h.accountUpdates).toEqual([]);
    expect(h.imageDrafts).toHaveLength(0);
  });

  it('落库前配额刚好被用满：原图回滚删除，不留孤儿文件', async () => {
    const h = build({ account: { usedSpace: '4900', spaceQuota: '5000' } });
    h.storage.seedChunks();
    const err = await errorOf(h.service.complete(UPLOAD_ID, {}, member(), CTX));
    expect([err.getStatus(), err.code]).toEqual([413, 'QUOTA_EXCEEDED']);
    const removed = h.storage.removed.find((k) => k.startsWith('originals/'));
    expect(removed).toBeDefined();
    expect(h.imageDrafts).toHaveLength(0);
  });

  it('归属账号已被删除：404 且原图回滚', async () => {
    const h = build({ account: null });
    h.storage.seedChunks();
    const err = await errorOf(h.service.complete(UPLOAD_ID, {}, member(), CTX));
    expect([err.getStatus(), err.code]).toEqual([404, 'NOT_FOUND']);
    expect(h.storage.removed.some((k) => k.startsWith('originals/'))).toBe(true);
  });

  it('上传途中相册被锁定：合并前重新鉴权，409 且不写库', async () => {
    const h = build();
    h.storage.seedChunks();
    h.album.status = AlbumStatus.Locked;
    const err = await errorOf(h.service.complete(UPLOAD_ID, {}, member(), CTX));
    expect([err.getStatus(), err.code]).toEqual([409, 'ALBUM_LOCKED']);
    expect(h.imageDrafts).toHaveLength(0);
  });

  it('派生图失败不影响上传成功，只留待后台重做', async () => {
    const h = build({ deriveFails: true });
    h.storage.seedChunks();
    const view = await h.service.complete(UPLOAD_ID, {}, member(), CTX);
    expect(view.id).toBe(42);
    expect(h.imageUpdates).toHaveLength(0);
    expect(h.updateSession).toHaveBeenCalledWith({ id: 5 }, { status: 1 });
  });

  it('完成后会话置 1、碎片清零并记 image_upload 审计', async () => {
    const h = build();
    h.storage.seedChunks();
    await h.service.complete(UPLOAD_ID, {}, member(), CTX);
    expect(h.updateSession).toHaveBeenCalledWith({ id: 5 }, { status: 1 });
    expect(h.storage.chunkLeft()).toBe(false);
    expect(h.storage.deriveLeft()).toBe(false);
    expect(h.auditEvents.at(-1)).toMatchObject({
      action: 'image_upload',
      targetId: 42,
      detail: expect.stringContaining(`md5=${MD5_WHOLE}`),
    });
    expect(h.imageUpdates[0]).toEqual([
      { id: 42 },
      expect.objectContaining({ previewPath: 'derived/preview/42.webp', thumbPath: 'derived/thumb/42.webp' }),
    ]);
  });
});

describe('direct：小图单请求直传', () => {
  it('与分片共用同一套校验与落库', async () => {
    const h = build();
    const view = await h.service.direct({ albumId: 1, filename: 'a.jpg' } as never, CHUNK_A, member(), CTX);
    const saved = h.savedSessions[0];
    expect(saved.totalChunks).toBe(1);
    expect(view.id).toBe(42);
    expect(h.imageDrafts[0].fileSize).toBe(String(CHUNK_A.length));
    expect(h.storage.files.get(chunkKey(saved.uploadId, 0))).toBeUndefined();
  });

  it('超过直传上限时改走分片', async () => {
    const h = build({ settings: { 'upload.chunk_size': 256 } });
    const err = await errorOf(h.service.direct({ albumId: 1, filename: 'a.jpg' } as never, WHOLE, member(), CTX));
    expect([err.getStatus(), err.code]).toEqual([413, 'TOO_BIG_FOR_DIRECT']);
    expect(h.savedSessions).toHaveLength(0);
  });

  it('空请求体 400', async () => {
    const h = build();
    expect((await errorOf(h.service.direct({ albumId: 1, filename: 'a.jpg' } as never, Buffer.alloc(0), member(), CTX))).code).toBe('EMPTY_BODY');
  });
});

describe('abort 与过期清理', () => {
  it('放弃上传只清自己的碎片，会话置 2', async () => {
    const h = build();
    h.storage.seedChunks();
    h.storage.files.set(chunkKey(newUploadId(), 0), CHUNK_A);
    const foreign = [...h.storage.files.keys()].find((k) => k !== chunkKey(UPLOAD_ID, 0) && k !== chunkKey(UPLOAD_ID, 1));

    await h.service.abort(UPLOAD_ID, member(), CTX);
    expect(h.storage.chunkLeft()).toBe(false);
    expect(h.storage.files.get(foreign as string)).toEqual(CHUNK_A);
    expect(h.updateSession).toHaveBeenCalledWith({ id: 5 }, { status: 2 });
    expect(h.auditEvents[0].action).toBe('upload_abort');
  });

  it('定时清理按 status=0 且已过期捞取，逐个清碎片', async () => {
    const h = build();
    h.storage.seedChunks();
    await expect(h.service.cleanupExpired(new Date('2026-10-01T00:00:00Z'))).resolves.toBe(1);
    expect(h.storage.chunkLeft()).toBe(false);
    expect(h.updateSession).toHaveBeenCalledWith({ id: 5 }, { status: 2 });
  });

  it('没有过期会话时不写库', async () => {
    const h = build({ session: null });
    await expect(h.service.cleanupExpired(new Date())).resolves.toBe(0);
    expect(h.updateSession).not.toHaveBeenCalled();
  });
});
