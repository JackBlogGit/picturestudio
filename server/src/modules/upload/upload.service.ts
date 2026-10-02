import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager, LessThan, Repository } from 'typeorm';
import { AppError } from '../../common/http/app-error';
import { unwrapDecision } from '../../common/permission/actor-guards';
import { decide } from '../../common/permission/permission-policy';
import { ResourceLoader } from '../../common/permission/resource-loader';
import { Action, Actor, ActorKind, ResourceType } from '../../common/permission/types';
import { FileKindService } from '../../common/storage/file-kind.service';
import {
  chunkKey,
  derivedKey,
  DIR_CHUNK,
  isUploadId,
  newUploadId,
  originalKey,
  stagingKey,
} from '../../common/storage/storage-path';
import { StorageService } from '../../common/storage/storage.service';
import {
  Album,
  Image,
  LogTargetType,
  TempAccount,
  UploadResourceType,
  UploadSession,
  User,
} from '../../entities';
import { AuditService, RequestContext } from '../audit/audit.service';
import { AlbumService } from '../album/album.service';
import { imageView, ImageView, previewUrl } from '../image/image-shape';
import { DerivativeService } from '../image/derivative.service';
import { SettingsService } from '../settings/settings.service';
import { CompleteUploadDto, CreateUploadDto, DirectUploadDto, MD5_HEX } from './dto/upload.dto';

/** PRD 5.3：会话 24 小时过期，未合并碎片由定时任务清理 */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const HEAD_BYTES = 65_536;
/** uploaded_chunks 是 varchar(2000)，把分片数摁在 300 以内就永远写不爆 */
export const MAX_CHUNKS = 300;
const MIN_CHUNK = 256 * 1024;
export const MAX_CHUNK = 16 * 1024 * 1024;

export interface UploadSessionView {
  uploadId: string;
  albumId: number;
  filename: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
  uploaded: number[];
  missing: number[];
  expireTime: Date;
}

interface QuotaSubject {
  kind: 'user' | 'temp';
  id: number;
}

interface OwnerRef {
  kind: 'user' | 'temp';
  uid: number;
  tempId: number | null;
}

/** uploaded_chunks 存逗号分隔下标；脏值一律忽略，宁可当成没传过 */
export function parseChunks(raw: string): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '')
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v) && v >= 0);
}

export function formatChunks(indexes: Iterable<number>): string {
  return [...new Set([...indexes].filter((v) => Number.isInteger(v) && v >= 0))]
    .sort((a, b) => a - b)
    .join(',');
}

/**
 * 分片大小可被站点配置调整，但片数超预算时自动放大片长，而不是拒绝大文件。
 * 片长被夹在 256KB~16MB 之间，而 fileSize 在 DTO 层已限制到 2GB（< 16MB × 300），
 * 因此这里算出的片数天然不会突破 MAX_CHUNKS。
 */
export function chunkPlan(fileSize: number, declared: number): { chunkSize: number; totalChunks: number } {
  const needed = Math.ceil(fileSize / MAX_CHUNKS);
  const chunkSize = Math.min(MAX_CHUNK, Math.max(MIN_CHUNK, Math.trunc(declared) || MIN_CHUNK, needed));
  return { chunkSize, totalChunks: Math.ceil(fileSize / chunkSize) };
}

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor(
    @InjectRepository(UploadSession) private readonly sessions: Repository<UploadSession>,
    @InjectRepository(Image) private readonly images: Repository<Image>,
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly fileKind: FileKindService,
    private readonly derivatives: DerivativeService,
    private readonly settings: SettingsService,
    private readonly loader: ResourceLoader,
    private readonly albums: AlbumService,
    private readonly audit: AuditService,
  ) {}

  /** 建会话：先过资源级鉴权与相册锁定，再查体积与配额 */
  async create(dto: CreateUploadDto, actor: Actor, ctx: RequestContext): Promise<UploadSessionView> {
    const session = await this.openSession(dto, actor);
    await this.audit.record(actor, ctx, {
      action: 'upload_session_create',
      targetId: session.id,
      detail: `uploadId=${session.uploadId}, album=${session.albumId}, size=${session.fileSize}, chunks=${session.totalChunks}, chunkSize=${session.chunkSize}`,
    });
    return this.view(session, [], new RangeList(session.totalChunks).all());
  }

  /** 断点续传：凭 uploadId 拿回缺失分片下标（以磁盘为准，不信任进度列） */
  async status(uploadId: string, actor: Actor): Promise<UploadSessionView> {
    const session = await this.loadOwned(uploadId, actor);
    const missing = await this.missingChunks(session);
    return this.view(session, this.range(session.totalChunks).minus(missing), missing);
  }

  async putChunk(
    uploadId: string,
    index: number,
    body: Buffer,
    actor: Actor,
  ): Promise<{ uploaded: number; total: number; missing: number[] }> {
    const session = await this.loadOwned(uploadId, actor);
    if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'CHUNK_INDEX_INVALID',
        `分片下标应在 0~${session.totalChunks - 1} 之间`,
      );
    }
    if (!body?.length) throw new AppError(HttpStatus.BAD_REQUEST, 'EMPTY_CHUNK', '分片内容为空');
    if (body.length > session.chunkSize) {
      throw new AppError(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'CHUNK_TOO_BIG',
        `单片不得超过 ${session.chunkSize} 字节，请重新分片`,
      );
    }
    await this.storage.write(chunkKey(session.uploadId, index), body);
    session.uploadedChunks = formatChunks([...parseChunks(session.uploadedChunks), index]);
    await this.sessions.update({ id: session.id }, { uploadedChunks: session.uploadedChunks });
    const missing = await this.missingChunks(session);
    return { uploaded: session.totalChunks - missing.length, total: session.totalChunks, missing };
  }

  /** 合并 → 校验 → 查重 → 配额事务落库 → 生成派生图 */
  async complete(
    uploadId: string,
    dto: CompleteUploadDto,
    actor: Actor,
    ctx: RequestContext,
  ): Promise<ImageView> {
    const session = await this.loadOwned(uploadId, actor);
    return this.finalize(session, dto, actor, ctx);
  }

  /** 小图直传（PRD 4.3 <5MB 单请求）：与分片走同一套校验与落库，只是分片一次到位 */
  async direct(dto: DirectUploadDto, body: Buffer, actor: Actor, ctx: RequestContext): Promise<ImageView> {
    if (!body?.length) throw new AppError(HttpStatus.BAD_REQUEST, 'EMPTY_BODY', '请求体为空');
    const limit = this.settings.getNumber('upload.chunk_size', 5 * 1024 * 1024);
    if (body.length > limit) {
      throw new AppError(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'TOO_BIG_FOR_DIRECT',
        `直传上限 ${limit} 字节，请改用分片上传`,
      );
    }
    const session = await this.openSession(
      { albumId: dto.albumId, filename: dto.filename, fileSize: body.length, md5Client: dto.md5Client },
      actor,
    );
    await this.storage.write(chunkKey(session.uploadId, 0), body);
    return this.finalize(session, { md5Client: dto.md5Client, force: dto.force }, actor, ctx);
  }

  async abort(uploadId: string, actor: Actor, ctx: RequestContext): Promise<void> {
    const session = await this.loadOwned(uploadId, actor);
    await this.dropTemp(session);
    await this.sessions.update({ id: session.id }, { status: 2 });
    await this.audit.record(actor, ctx, {
      action: 'upload_abort',
      targetId: session.id,
      detail: `uploadId=${session.uploadId}, album=${session.albumId}`,
    });
  }

  /** 过期会话的碎片清理，供定时任务调用 */
  async cleanupExpired(now: Date = new Date()): Promise<number> {
    const stale = await this.sessions.find({ where: { status: 0, expireTime: LessThan(now) }, take: 200 });
    for (const session of stale) {
      await this.dropTemp(session);
      await this.sessions.update({ id: session.id }, { status: 2 });
    }
    if (stale.length) this.logger.log(`清理过期上传会话 ${stale.length} 个`);
    return stale.length;
  }

  private async openSession(dto: CreateUploadDto, actor: Actor): Promise<UploadSession> {
    const album = await this.authorizeTarget(dto.albumId, actor);
    const size = Math.trunc(dto.fileSize);
    const max = this.settings.getNumber('upload.max_image_size', 50 * 1024 * 1024);
    if (size > max) {
      throw new AppError(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'FILE_TOO_BIG',
        `单张图片最大 ${max} 字节，当前声明 ${size} 字节`,
      );
    }
    const { chunkSize, totalChunks } = chunkPlan(
      size,
      this.settings.getNumber('upload.chunk_size', 5 * 1024 * 1024),
    );
    await this.assertQuota(actor, size);

    const md5Client = (dto.md5Client ?? '').toLowerCase();
    const owner = this.ownerOf(actor);
    return this.sessions.save(
      this.sessions.create({
        uploadId: newUploadId(),
        resourceType: UploadResourceType.Image,
        albumId: album.id,
        folderId: null,
        filename: dto.filename.trim().slice(0, 255),
        fileSize: String(size),
        chunkSize,
        totalChunks,
        uploadedChunks: '',
        md5Client: MD5_HEX.test(md5Client) ? md5Client : '',
        userType: owner.kind,
        uid: owner.kind === 'user' ? owner.uid : null,
        tempId: owner.kind === 'temp' ? owner.tempId : null,
        status: 0,
        expireTime: new Date(Date.now() + SESSION_TTL_MS),
      }),
    );
  }

  private async finalize(
    session: UploadSession,
    dto: CompleteUploadDto,
    actor: Actor,
    ctx: RequestContext,
  ): Promise<ImageView> {
    const album = await this.authorizeTarget(Number(session.albumId), actor);
    const missing = await this.missingChunks(session);
    if (missing.length) {
      throw new AppError(
        HttpStatus.CONFLICT,
        'MISSING_CHUNKS',
        `还差 ${missing.length} 个分片未上传`,
        { missing: missing.slice(0, 100) },
      );
    }

    const staging = stagingKey(session.uploadId, 'merged.bin');
    const order = this.range(session.totalChunks).all();
    const hash = createHash('md5');
    const head: Buffer[] = [];
    let headLen = 0;
    const size = await this.storage.concat(
      staging,
      order.map((i) => chunkKey(session.uploadId, i)),
      (chunk) => {
        hash.update(chunk);
        if (headLen < HEAD_BYTES) {
          const part = chunk.subarray(0, HEAD_BYTES - headLen);
          head.push(Buffer.from(part));
          headLen += part.length;
        }
      },
    );
    const md5 = hash.digest('hex');
    const declared = (dto.md5Client ?? session.md5Client ?? '').toLowerCase();

    if (declared && !MD5_HEX.test(declared)) {
      await this.storage.remove(staging);
      throw new AppError(HttpStatus.BAD_REQUEST, 'MD5_FORMAT', 'md5Client 必须是 32 位十六进制');
    }
    if (size !== Number(session.fileSize)) {
      await this.storage.remove(staging);
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'SIZE_MISMATCH',
        `声明 ${session.fileSize} 字节，实收 ${size} 字节，请重传`,
      );
    }
    if (declared && declared !== md5) {
      await this.storage.remove(staging);
      throw new AppError(HttpStatus.BAD_REQUEST, 'MD5_MISMATCH', '文件校验失败，内容在传输中损坏，请重传');
    }

    let kind: { ext: string; mime: string };
    try {
      kind = await this.fileKind.assertAllowed('image', Buffer.concat(head), session.filename);
    } catch (err) {
      // 类型不合格重传也没用，碎片直接丢掉
      await this.storage.remove(staging);
      await this.storage.removeTree(`${DIR_CHUNK}/${session.uploadId}`);
      throw err;
    }

    const owner = this.ownerOf(actor);
    const dup = await this.images.findOne({
      where: { md5, uploadUid: owner.uid },
      select: { id: true, originalPath: true, albumId: true },
    });
    if (dup && !dto.force) {
      // 分片保留：客户端点「仍要上传」时无需重传
      await this.storage.remove(staging);
      throw new AppError(HttpStatus.CONFLICT, 'DUPLICATE_IMAGE', '该图片你已上传过', {
        imageId: dup.id,
        albumId: dup.albumId,
        preview: previewUrl(dup.id),
      });
    }

    /** 秒传复用同一路径（PRD 4.3）：磁盘只有一份原图，删除时必须先确认没有别的行引用 */
    let originalPath: string;
    if (dup) {
      originalPath = dup.originalPath;
      await this.storage.remove(staging);
    } else {
      originalPath = originalKey(kind.ext);
      try {
        await this.storage.move(staging, originalPath);
      } catch (err) {
        throw new AppError(
          HttpStatus.INTERNAL_SERVER_ERROR,
          'STORAGE_WRITE_FAILED',
          `原图落盘失败：${(err as Error).message}`,
        );
      }
    }

    let image: Image;
    try {
      image = await this.persistWithQuota(album, owner, originalPath, md5, size, session.filename);
    } catch (err) {
      if (!dup) await this.storage.remove(originalPath);
      throw err;
    }

    await this.attachDerivatives(image);
    await this.dropTemp(session);
    await this.sessions.update({ id: session.id }, { status: 1 });
    await this.audit.record(actor, ctx, {
      action: 'image_upload',
      targetType: LogTargetType.Image,
      targetId: image.id,
      detail: `${session.filename}, size=${size}, md5=${md5}, type=${kind.ext}, album=${album.id}${dup ? ', force=1' : ''}`,
    });
    return imageView(image, actor, { original: actor.kind === ActorKind.Member });
  }

  /** 配额与图片记录必须同事务，否则 used_space 会与真实占用漂移（PRD 5.6） */
  private async persistWithQuota(
    album: Album,
    owner: OwnerRef,
    originalPath: string,
    md5: string,
    size: number,
    filename: string,
  ): Promise<Image> {
    const subject: QuotaSubject =
      owner.kind === 'user'
        ? { kind: 'user', id: owner.uid }
        : { kind: 'temp', id: (owner.tempId as number) };
    return this.dataSource.transaction(async (em) => {
      await this.bumpQuota(em, subject, size, true);
      const repo = em.getRepository(Image);
      return repo.save(
        repo.create({
          albumId: album.id,
          originalPath,
          previewPath: '',
          thumbPath: '',
          filename,
          fileSize: String(size),
          md5,
          width: 0,
          height: 0,
          shotTime: null,
          watermarked: 0,
          // 新图直接继承相册档位，绝不上浮（PRD 3.2）
          visibility: album.visibility,
          sort: 0,
          uploadUid: owner.uid,
          uploadTempId: owner.kind === 'temp' ? owner.tempId : null,
        }),
      );
    });
  }

  private async bumpQuota(em: EntityManager, subject: QuotaSubject, size: number, lock: boolean): Promise<void> {
    const repo: Repository<User | TempAccount> = em.getRepository<User | TempAccount>(
      subject.kind === 'user' ? User : TempAccount,
    );
    const row = await repo.findOne({
      where: { id: subject.id },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (!row) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', '归属账号不存在或已被删除');
    const used = Number(row.usedSpace ?? 0);
    const quota = Number(row.spaceQuota ?? 0);
    if (quota > 0 && used + size > quota) {
      throw new AppError(HttpStatus.PAYLOAD_TOO_LARGE, 'QUOTA_EXCEEDED', `空间不足，已用 ${used}/${quota} 字节`, {
        used,
        quota,
        need: size,
      });
    }
    if (lock) await repo.update({ id: subject.id }, { usedSpace: String(used + size) });
  }

  private async assertQuota(actor: Actor, size: number): Promise<void> {
    const owner = this.ownerOf(actor);
    const subject: QuotaSubject =
      owner.kind === 'user'
        ? { kind: 'user', id: owner.uid }
        : { kind: 'temp', id: (owner.tempId as number) };
    await this.bumpQuota(this.dataSource.manager, subject, size, false);
  }

  private async attachDerivatives(image: Image): Promise<void> {
    try {
      const source = await this.storage.buffer(image.originalPath);
      const { info, renderable } = await this.derivatives.probe(source);
      const out = await this.derivatives.render(renderable);
      const previewPath = derivedKey(image.id, 'preview');
      const thumbPath = derivedKey(image.id, 'thumb');
      await this.storage.write(previewPath, out.preview);
      await this.storage.write(thumbPath, out.thumb);
      const patch: Partial<Image> = {
        width: info.width,
        height: info.height,
        shotTime: info.shotTime,
        watermarked: out.watermarked,
        previewPath,
        thumbPath,
      };
      await this.images.update({ id: image.id }, patch);
      Object.assign(image, patch);
    } catch (err) {
      // 派生图失败不能把已落库的原图判为上传失败；预览接口会 404，后台可重做
      this.logger.warn(`image=${image.id} 派生图生成失败：${(err as Error).message}`);
    }
  }

  /** 上传目标相册：可见性 + 等级 + 锁定态三关，判定与守卫同源 */
  private async authorizeTarget(albumId: number, actor: Actor): Promise<Album> {
    if (!Number.isInteger(albumId) || albumId <= 0) {
      throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', '相册不存在或无权查看');
    }
    const album = await this.albums.getById(albumId);
    const ref = await this.loader.load(ResourceType.Album, albumId);
    if (!ref) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', '相册不存在或无权查看');
    unwrapDecision(decide(Action.Upload, actor, ref));
    this.albums.assertEditable(album);
    return album;
  }

  private async loadOwned(uploadId: string, actor: Actor): Promise<UploadSession> {
    if (!isUploadId(uploadId)) {
      throw new AppError(HttpStatus.NOT_FOUND, 'UPLOAD_NOT_FOUND', '上传会话不存在或已过期');
    }
    const session = await this.sessions.findOne({ where: { uploadId } });
    // 无权与不存在统一 404，别让人拿会话号探测别人的上传进度（PRD 12.5）
    if (!session || !this.owns(session, actor)) {
      throw new AppError(HttpStatus.NOT_FOUND, 'UPLOAD_NOT_FOUND', '上传会话不存在或已过期');
    }
    if (session.status === 1) throw new AppError(HttpStatus.CONFLICT, 'UPLOAD_COMPLETED', '该上传会话已完成');
    if (session.status === 2) throw new AppError(HttpStatus.CONFLICT, 'UPLOAD_ABORTED', '该上传会话已作废');
    if (new Date(session.expireTime).getTime() < Date.now()) {
      throw new AppError(HttpStatus.GONE, 'UPLOAD_EXPIRED', '上传会话已过期，请重新发起');
    }
    return session;
  }

  private owns(session: UploadSession, actor: Actor): boolean {
    if (actor.kind === ActorKind.Member) {
      return session.userType === 'user' && session.uid === actor.uid;
    }
    if (actor.kind === ActorKind.Temp) {
      return session.userType === 'temp' && session.tempId === actor.tempId;
    }
    return false;
  }

  private ownerOf(actor: Actor): OwnerRef {
    if (actor.kind === ActorKind.Member) return { kind: 'user', uid: actor.uid, tempId: null };
    // 临时账号上传的资源自动归属工作室（PRD 6.2），配额算在临时账号自己头上
    if (actor.kind === ActorKind.Temp) return { kind: 'temp', uid: actor.ownerUid, tempId: actor.tempId };
    throw new AppError(HttpStatus.FORBIDDEN, 'UPLOAD_FORBIDDEN', '该身份不能上传');
  }

  private async missingChunks(session: UploadSession): Promise<number[]> {
    if (!isUploadId(session.uploadId)) return this.range(session.totalChunks).all();
    const flags = await Promise.all(
      this.range(session.totalChunks).all().map(async (i) => ({
        i,
        ok: await this.storage.exists(chunkKey(session.uploadId, i)),
      })),
    );
    return flags.filter((f) => !f.ok).map((f) => f.i);
  }

  private async dropTemp(session: UploadSession): Promise<void> {
    if (!isUploadId(session.uploadId)) return;
    await this.storage.remove(stagingKey(session.uploadId, 'merged.bin'));
    await this.storage.removeTree(`${DIR_CHUNK}/${session.uploadId}`);
  }

  private view(session: UploadSession, uploaded: number[], missing: number[]): UploadSessionView {
    return {
      uploadId: session.uploadId,
      albumId: Number(session.albumId),
      filename: session.filename,
      size: Number(session.fileSize),
      chunkSize: session.chunkSize,
      totalChunks: session.totalChunks,
      uploaded: uploaded.sort((a, b) => a - b),
      missing,
      expireTime: session.expireTime,
    };
  }

  private range(total: number): RangeList {
    return new RangeList(total);
  }
}

/** 分片下标集合的小工具，避免到处写 Array.from */
class RangeList {
  constructor(private readonly total: number) {}

  all(): number[] {
    return [...Array(Math.max(this.total, 0)).keys()];
  }

  minus(exclude: number[]): number[] {
    const drop = new Set(exclude);
    return this.all().filter((i) => !drop.has(i));
  }
}
