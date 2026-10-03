import { HttpStatus, Injectable, StreamableFile } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { AppError } from '../../common/http/app-error';
import { contentDisposition } from '../../common/http/disposition';
import { clampPaging, Page, pagedList } from '../../common/http/pagination';
import { unwrapDecision } from '../../common/permission/actor-guards';
import { canSetVisibility, checkInheritance, decide } from '../../common/permission/permission-policy';
import { ResourceLoader } from '../../common/permission/resource-loader';
import { Action, Actor, ActorKind, ResourceType } from '../../common/permission/types';
import { Visibility } from '../../common/enums/visibility.enum';
import { UserLevel } from '../../common/enums/user-level.enum';
import { StorageService, StoredFile } from '../../common/storage/storage.service';
import { Album, AlbumStage, AlbumStatus, Image, ImageTagMap, LogTargetType, Tag, TagType } from '../../entities';
import { AuditService, RequestContext } from '../audit/audit.service';
import { AlbumService, visibleVisibilities } from '../album/album.service';
import { TagService } from '../tag/tag.service';
import { tagMatchFilter } from '../tag/tag-match';
import { BatchTagsDto, BatchVisibilityDto, ListImageDto, UpdateImageDto } from './dto/image.dto';
import { imageView, ImageView, TagView, visibleTags } from './image-shape';

/** 批量操作逐条判定，不合规项进清单而不是整体回滚（PRD 4.5「不静默跳过」） */
export interface RejectedItem {
  imageId: number;
  status: number;
  code: string;
  message: string;
}

export interface BatchResult {
  requested: number;
  updated: number;
  rejected: RejectedItem[];
}

@Injectable()
export class ImageService {
  constructor(
    @InjectRepository(Image) private readonly images: Repository<Image>,
    private readonly storage: StorageService,
    private readonly loader: ResourceLoader,
    private readonly albums: AlbumService,
    private readonly tags: TagService,
    private readonly audit: AuditService,
  ) {}

  async getById(id: number): Promise<Image> {
    const row = await this.images.findOne({ where: { id } });
    if (!row) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', '图片不存在或无权查看');
    return row;
  }

  /**
   * 相册内图片的组合筛选（PRD 4.4）。
   * 相册级鉴权由守卫完成，这里只按身份裁图片自身档位，并保证 status 标签不外泄。
   */
  async listInAlbum(albumId: number, query: ListImageDto, actor: Actor): Promise<Page<ImageView>> {
    const album = await this.albums.getById(albumId);
    if (query.status?.length && TagService.hidesStatusTags(actor)) {
      throw new AppError(HttpStatus.FORBIDDEN, 'STATUS_FILTER_FORBIDDEN', '状态标签只对成员开放');
    }
    const { skip, take, page, pageSize } = clampPaging(query);
    /** 分享链接访客只能走 /public/share 通道（M3），相册列表这条路径对他们恒空 */
    if (actor.kind === ActorKind.ShareVisitor) return pagedList([], 0, page, pageSize);

    const matched = await this.matchedImageIds(album, query);
    if (matched && !matched.length) return pagedList([], 0, page, pageSize);

    const qb = this.images
      .createQueryBuilder('i')
      .where('i.albumId = :album', { album: album.id })
      .orderBy('i.sort', 'ASC')
      .addOrderBy('i.id', 'DESC')
      .skip(skip)
      .take(take);
    if (matched) qb.andWhere('i.id IN (:...ids)', { ids: matched });
    this.applyVisibility(qb, actor);

    const [rows, total] = await qb.getManyAndCount();
    const tagMap = await this.tagsOfMany(rows.map((r) => r.id), actor);
    return pagedList(
      rows.map((row) =>
        imageView(row, actor, {
          albumStage: album.stage,
          tags: tagMap.get(row.id) ?? [],
        }),
      ),
      total,
      page,
      pageSize,
    );
  }

  /** 预览字节出口：鉴权在守卫，这里只保证「派生图存在才给字节」 */
  async preview(id: number): Promise<StreamableFile> {
    const image = await this.getById(id);
    if (!image.previewPath) {
      throw new AppError(HttpStatus.CONFLICT, 'PREVIEW_NOT_READY', '预览图尚未生成，请稍后重试');
    }
    const file = await this.open(image.previewPath, '预览图');
    return new StreamableFile(file.stream, { type: 'image/webp', length: file.size });
  }

  /**
   * 原图一律按附件下发：类型在上传时已由魔数确认，但这里仍不给浏览器解释内容的机会。
   * 原始文件名走 RFC 5987 双写，中文名不乱码（PRD 15.14）。
   */
  async original(id: number): Promise<StreamableFile> {
    const image = await this.getById(id);
    const file = await this.open(image.originalPath, '原图');
    return new StreamableFile(file.stream, {
      type: 'application/octet-stream',
      length: file.size,
      disposition: contentDisposition(image.filename),
    });
  }

  async update(id: number, dto: UpdateImageDto, actor: Actor, ctx: RequestContext): Promise<ImageView> {
    const image = await this.getById(id);
    const album = await this.albums.getById(image.albumId);
    this.albums.assertEditable(album);
    const ref = await this.loader.load(ResourceType.Image, id);
    if (!ref) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', '图片不存在或无权查看');
    unwrapDecision(decide(Action.EditMeta, actor, ref));

    const changed: string[] = [];
    if (dto.visibility && dto.visibility !== image.visibility) {
      unwrapDecision(decide(Action.ChangeVisibility, actor, ref));
      this.assertCanSet(actor, dto.visibility);
      unwrapDecision(checkInheritance(dto.visibility, [album.visibility]));
      changed.push(`visibility:${image.visibility}→${dto.visibility}`);
      image.visibility = dto.visibility;
    }
    if (dto.shotTime !== undefined) {
      const next = dto.shotTime === null ? null : new Date(dto.shotTime);
      if (String(image.shotTime ?? '') !== String(next ?? '')) {
        changed.push('shotTime');
        image.shotTime = next;
      }
    }
    if (dto.sort !== undefined && dto.sort !== image.sort) {
      changed.push('sort');
      image.sort = dto.sort;
    }
    if (!changed.length) return this.view(image, actor, album.stage);

    await this.images.save(image);
    await this.audit.record(actor, ctx, {
      action: 'image_update',
      targetType: LogTargetType.Image,
      targetId: image.id,
      detail: changed.join(','),
    });
    return this.view(image, actor, album.stage);
  }

  async batchTags(dto: BatchTagsDto, actor: Actor, ctx: RequestContext): Promise<BatchResult> {
    if (!dto.add?.length && !dto.remove?.length) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NOTHING_TO_DO', 'add 与 remove 至少提供一个');
    }
    this.assertNotTrainee(actor);
    const addIds = dto.add ?? [];
    const removeIds = dto.remove ?? [];
    const wanted = [...new Set([...addIds, ...removeIds])];
    const rows = await this.tags.pick(wanted);
    const missing = wanted.filter((id) => !rows.some((r) => r.id === id));
    if (missing.length) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'TAG_NOT_FOUND', `标签不存在：${missing.join(',')}`);
    }
    const merged = rows.find((r) => r.mergedInto !== null && addIds.includes(r.id));
    if (merged) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'TAG_MERGED',
        `标签「${merged.tagName}」已合并，请改用合并后的标签`,
      );
    }
    /** 状态标签属于内部流转信息：临时账号可以打外部标签，但不能给自己定状态 */
    if (TagService.hidesStatusTags(actor) && rows.some((r) => addIds.includes(r.id) && r.tagType === TagType.Status)) {
      throw new AppError(HttpStatus.FORBIDDEN, 'STATUS_TAG_FORBIDDEN', '状态标签只能由成员维护');
    }

    const rejected: RejectedItem[] = [];
    let updated = 0;
    const touched = new Set<number>();
    const albums = new Map<number, Album | null>();
    for (const imageId of dto.imageIds) {
      const ref = await this.loader.load(ResourceType.Image, imageId);
      if (!ref) {
        rejected.push(this.notFound(imageId));
        continue;
      }
      const decision = decide(Action.EditTags, actor, ref);
      if (!decision.allowed) {
        rejected.push({
          imageId,
          status: decision.status,
          code: decision.reason,
          message: decision.message,
        });
        continue;
      }
      const albumId = ref.albumId as number;
      if (!albums.has(albumId)) albums.set(albumId, await this.albumById(albumId));
      const album = albums.get(albumId);
      if (!album) {
        rejected.push(this.notFound(imageId));
        continue;
      }
      if (album.status === AlbumStatus.Locked) {
        rejected.push(this.lockedAlbum(imageId));
        continue;
      }
      await this.tags.attach(imageId, addIds);
      await this.tags.detach(imageId, removeIds);
      for (const id of wanted) touched.add(id);
      updated += 1;
    }

    if (updated) await this.tags.recount([...touched]);
    await this.audit.record(actor, ctx, {
      action: 'image_batch_tags',
      targetType: LogTargetType.Image,
      detail: `images=${dto.imageIds.length}, ok=${updated}, rejected=${rejected.length}, add=${addIds.join('/')}, remove=${removeIds.join('/')}`,
    });
    return { requested: dto.imageIds.length, updated, rejected };
  }

  /** 批量改档位：逐条跑鉴权 + 3.2 继承校验，不合规项回清单 */
  async batchVisibility(dto: BatchVisibilityDto, actor: Actor, ctx: RequestContext): Promise<BatchResult> {
    this.assertNotTrainee(actor);
    const rejected: RejectedItem[] = [];
    const albums = new Map<number, Album | null>();
    let updated = 0;

    for (const imageId of dto.imageIds) {
      const ref = await this.loader.load(ResourceType.Image, imageId);
      if (!ref) {
        rejected.push(this.notFound(imageId));
        continue;
      }
      const decision = decide(Action.ChangeVisibility, actor, ref);
      if (!decision.allowed) {
        rejected.push({
          imageId,
          status: decision.status,
          code: decision.reason,
          message: decision.message,
        });
        continue;
      }
      const block = this.rejectLevel(actor, dto.visibility);
      if (block) {
        rejected.push({ imageId, ...block });
        continue;
      }
      const albumId = ref.albumId as number;
      if (!albums.has(albumId)) albums.set(albumId, await this.albumById(albumId));
      const album = albums.get(albumId);
      if (!album) {
        rejected.push(this.notFound(imageId));
        continue;
      }
      if (album.status === AlbumStatus.Locked) {
        rejected.push(this.lockedAlbum(imageId));
        continue;
      }
      const inheritance = checkInheritance(dto.visibility, [album.visibility]);
      if (!inheritance.allowed) {
        rejected.push({
          imageId,
          status: inheritance.status,
          code: inheritance.reason,
          message: inheritance.message,
        });
        continue;
      }
      await this.images.update({ id: imageId }, { visibility: dto.visibility });
      updated += 1;
    }

    await this.audit.record(actor, ctx, {
      action: 'image_batch_visibility',
      targetType: LogTargetType.Image,
      detail: `images=${dto.imageIds.length}, ok=${updated}, rejected=${rejected.length}, target=${dto.visibility}`,
    });
    return { requested: dto.imageIds.length, updated, rejected };
  }

  /**
   * 类型之间 AND、同类型多值 OR（PRD 4.4）。
   * 命中片段的生成口径与分享链接共用 tagMatchFilter，两处不会各说各话。
   */
  private async matchedImageIds(album: Album, query: ListImageDto): Promise<number[] | null> {
    const wanted = [...new Set([...(query.tags ?? []), ...(query.status ?? [])])];
    if (!wanted.length) return null;

    const rows = await this.tags.pick(wanted);
    const missing = wanted.filter((id) => !rows.some((r) => r.id === id));
    if (missing.length) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'TAG_NOT_FOUND', `标签不存在：${missing.join(',')}`);
    }
    const statusIds = new Set(query.status ?? []);
    const wrongType = rows.filter((r) => statusIds.has(r.id) && r.tagType !== TagType.Status);
    if (wrongType.length) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'STATUS_TYPE_MISMATCH',
        `status 只能传状态标签，${wrongType.map((r) => r.tagName).join('、')} 不是`,
      );
    }

    const filter = tagMatchFilter(rows);
    const raw = await this.images
      .createQueryBuilder('i')
      .innerJoin(ImageTagMap, 'm', 'm.imageId = i.id')
      .innerJoin(Tag, 't', 't.id = m.tagId')
      .where('i.albumId = :albumId', { albumId: album.id })
      .andWhere(filter.where, filter.params)
      .select('i.id', 'id')
      .groupBy('i.id')
      .having(filter.having, filter.params)
      .getRawMany<{ id: number | string }>();
    return raw.map((r) => Number(r.id));
  }

  /** 档位裁剪与 decide() 同源：游客只见 public，成员按等级上限 + 本人 private 例外 */
  private applyVisibility(qb: SelectQueryBuilder<Image>, actor: Actor): void {
    if (actor.kind === ActorKind.Guest) {
      qb.andWhere('i.visibility = :public', { public: Visibility.Public });
      return;
    }
    // 白名单即授权，可覆盖档位（PRD 6.2），临时账号不再按图片档位二次收紧
    if (actor.kind === ActorKind.Temp) return;
    if (actor.kind !== ActorKind.Member) {
      qb.andWhere('i.visibility = :public', { public: Visibility.Public });
      return;
    }
    const allowed = visibleVisibilities(actor.level);
    if (allowed.includes(Visibility.Private)) return;
    qb.andWhere('(i.visibility IN (:...allowed) OR (i.visibility = :private AND i.uploadUid = :uid))', {
      allowed,
      private: Visibility.Private,
      uid: actor.uid,
    });
  }

  private async tagsOfMany(imageIds: number[], actor: Actor): Promise<Map<number, TagView[]>> {
    const rows = await this.tags.tagsOf(imageIds);
    const map = new Map<number, TagView[]>();
    for (const { imageId, tag } of rows) {
      const [view] = visibleTags(actor, [tag]);
      if (!view) continue;
      const bucket = map.get(imageId) ?? [];
      bucket.push(view);
      map.set(imageId, bucket);
    }
    return map;
  }

  private async view(image: Image, actor: Actor, albumStage: AlbumStage): Promise<ImageView> {
    const tagMap = await this.tagsOfMany([image.id], actor);
    return imageView(image, actor, {
      albumStage,
      tags: tagMap.get(image.id) ?? [],
    });
  }

  private assertCanSet(actor: Actor, target: Visibility): void {
    const block = this.rejectLevel(actor, target);
    if (block) throw new AppError(block.status, block.code, block.message);
  }

  private rejectLevel(actor: Actor, target: Visibility): { status: number; code: string; message: string } | null {
    if (actor.kind !== ActorKind.Member) return null;
    if (canSetVisibility(actor.level, target)) return null;
    return {
      status: HttpStatus.FORBIDDEN,
      code: 'SET_PUBLIC_FORBIDDEN',
      message: '见习成员不能把资源设为公开，对外发布需 L2 及以上',
    };
  }

  /** PRD 6.1：L1 禁用一切批量操作 */
  private assertNotTrainee(actor: Actor): void {
    if (actor.kind === ActorKind.Member && actor.level === UserLevel.Trainee) {
      throw new AppError(HttpStatus.FORBIDDEN, 'BATCH_FORBIDDEN', '见习成员不能使用批量操作');
    }
  }

  private notFound(imageId: number): RejectedItem {
    return { imageId, status: HttpStatus.NOT_FOUND, code: 'NOT_FOUND', message: '图片不存在或无权查看' };
  }

  /** 锁定相册禁止任何写入（PRD 4.2），批量场景里以清单项返回而不是中断整批 */
  private lockedAlbum(imageId: number): RejectedItem {
    return {
      imageId,
      status: HttpStatus.CONFLICT,
      code: 'ALBUM_LOCKED',
      message: '相册已锁定，禁止上传与修改',
    };
  }

  private async albumById(id: number): Promise<Album | null> {
    try {
      return await this.albums.getById(id);
    } catch {
      return null;
    }
  }

  /** 库里有条记录、磁盘上文件却没了（手工清理或磁盘故障）时，给 409 而不是 500 */
  private async open(rel: string, label: string): Promise<StoredFile> {
    try {
      return await this.storage.read(rel);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      throw new AppError(HttpStatus.CONFLICT, 'FILE_MISSING', `${label}文件缺失，请联系管理员重新生成`);
    }
  }
}
