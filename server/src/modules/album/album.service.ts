import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AppError } from '../../common/http/app-error';
import { clampPaging, Page, pagedList } from '../../common/http/pagination';
import { requireMember } from '../../common/permission/actor-guards';
import { VISIBLE_MAX_RANK, canSetVisibility } from '../../common/permission/permission-policy';
import { Actor, ActorKind } from '../../common/permission/types';
import { rank, Visibility } from '../../common/enums/visibility.enum';
import { UserLevel } from '../../common/enums/user-level.enum';
import { StorageService } from '../../common/storage/storage.service';
import { LIKE_ESCAPE_SQL, likePattern } from '../../common/sql/like';
import { Album, AlbumStatus, Image, LogTargetType } from '../../entities';
import { AuditService, RequestContext } from '../audit/audit.service';
import { CreateAlbumDto, ListAlbumDto, UpdateAlbumDto } from './dto/album.dto';

const ALL_VISIBILITIES: Visibility[] = [
  Visibility.Public,
  Visibility.Member,
  Visibility.Admin,
  Visibility.Private,
];

/** 档位列表查询用 IN 条件，取值必须与 decide() 的可见性闸门同源 */
export function visibleVisibilities(level: UserLevel): Visibility[] {
  const max = VISIBLE_MAX_RANK[level];
  return ALL_VISIBILITIES.filter((v) => rank(v) <= max);
}

@Injectable()
export class AlbumService {
  constructor(
    @InjectRepository(Album) private readonly albums: Repository<Album>,
    @InjectRepository(Image) private readonly images: Repository<Image>,
    private readonly storage: StorageService,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async getById(id: number): Promise<Album> {
    const row = await this.albums.findOne({ where: { id } });
    if (!row) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', '相册不存在或无权查看');
    return row;
  }

  async list(actor: Actor, query: ListAlbumDto): Promise<Page<Album>> {
    const { skip, take, page, pageSize } = clampPaging(query);
    const qb = this.albums
      .createQueryBuilder('a')
      .orderBy('a.eventDate', 'DESC')
      .addOrderBy('a.id', 'DESC')
      .skip(skip)
      .take(take);

    if (actor.kind === ActorKind.Guest) {
      qb.where('a.visibility = :public', { public: Visibility.Public }).andWhere('a.status <> :archived', {
        archived: AlbumStatus.Archived,
      });
    } else if (actor.kind === ActorKind.Temp) {
      if (!actor.albumIds.length) return pagedList([], 0, page, pageSize);
      qb.where('a.id IN (:...ids)', { ids: actor.albumIds }).andWhere('a.status <> :archived', {
        archived: AlbumStatus.Archived,
      });
    } else if (actor.kind === ActorKind.Member) {
      qb.where('(a.visibility IN (:...allowed) OR (a.visibility = :private AND a.createUid = :uid))', {
        allowed: visibleVisibilities(actor.level),
        private: Visibility.Private,
        uid: actor.uid,
      });
      /** 归档相册前台不展示，但成员可以主动带出来找历史漫展 */
      if (!query.includeArchived) {
        qb.andWhere('a.status <> :archived', { archived: AlbumStatus.Archived });
      }
    } else {
      return pagedList([], 0, page, pageSize);
    }

    if (query.status) qb.andWhere('a.status = :status', { status: query.status });
    const kw = query.keyword?.trim();
    if (kw) {
      qb.andWhere(
        `(a.name LIKE :kw ${LIKE_ESCAPE_SQL} OR a.eventName LIKE :kw ${LIKE_ESCAPE_SQL})`,
        { kw: likePattern(kw) },
      );
    }

    const [list, total] = await qb.getManyAndCount();
    return pagedList(list, total, page, pageSize);
  }

  async create(dto: CreateAlbumDto, actor: Actor, ctx: RequestContext): Promise<Album> {
    const member = requireMember(actor, '创建相册');
    const visibility = dto.visibility ?? Visibility.Member;
    if (!canSetVisibility(member.level, visibility)) {
      throw new AppError(HttpStatus.FORBIDDEN, 'SET_PUBLIC_FORBIDDEN', '见习成员不能创建公开相册');
    }
    const saved = await this.albums.save(
      this.albums.create({
        name: dto.name.trim(),
        eventName: (dto.eventName ?? '').trim(),
        eventDate: dto.eventDate ?? null,
        location: (dto.location ?? '').trim(),
        description: (dto.description ?? '').trim(),
        visibility,
        status: AlbumStatus.Normal,
        coverImgId: null,
        createUid: member.uid,
      }),
    );
    await this.log(actor, ctx, 'album_create', saved.id, saved.name);
    return saved;
  }

  async update(id: number, dto: UpdateAlbumDto, actor: Actor, ctx: RequestContext): Promise<Album> {
    const album = await this.getById(id);
    this.assertEditable(album);

    const member = actor.kind === ActorKind.Member ? actor : null;
    if (dto.visibility && (!member || !canSetVisibility(member.level, dto.visibility))) {
      throw new AppError(HttpStatus.FORBIDDEN, 'SET_PUBLIC_FORBIDDEN', '见习成员不能把相册设为公开');
    }
    if (dto.coverImgId !== undefined && dto.coverImgId !== null) {
      const inAlbum = await this.images.count({ where: { id: dto.coverImgId, albumId: album.id } });
      if (!inAlbum) throw new AppError(HttpStatus.BAD_REQUEST, 'COVER_NOT_IN_ALBUM', '封面只能从本相册已有的图片中选取');
    }

    const changed: string[] = [];
    for (const field of ['name', 'eventName', 'location', 'description', 'eventDate'] as const) {
      const next = dto[field];
      if (next === undefined) continue;
      const value = typeof next === 'string' ? next.trim() : next;
      if (album[field] !== value) {
        (album as unknown as Record<string, unknown>)[field] = value;
        changed.push(field);
      }
    }
    if (dto.visibility && album.visibility !== dto.visibility) {
      changed.push(`visibility:${album.visibility}→${dto.visibility}`);
      album.visibility = dto.visibility;
    }
    if (dto.coverImgId !== undefined && album.coverImgId !== dto.coverImgId) {
      album.coverImgId = dto.coverImgId;
      changed.push('coverImgId');
    }
    if (!changed.length) return album;

    await this.albums.save(album);
    await this.log(actor, ctx, 'album_update', album.id, changed.join(','));
    return album;
  }

  /** 解锁本身必须始终可行，所以这里不拦锁定态 */
  async changeStatus(id: number, status: AlbumStatus, actor: Actor, ctx: RequestContext): Promise<Album> {
    const album = await this.getById(id);
    if (album.status === status) return album;
    album.status = status;
    await this.albums.save(album);
    await this.log(actor, ctx, 'album_status', album.id, `status=${status}`);
    return album;
  }

  /**
   * 物理删除并级联删全部图片（DB 侧 FK 已 CASCADE）。
   * 磁盘文件必须在事务提交之后再删，反过来会留下「记录还在、文件没了」的坏数据。
   */
  async remove(id: number, confirmName: string, actor: Actor, ctx: RequestContext): Promise<number> {
    const album = await this.getById(id);
    if (confirmName.trim() !== album.name) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'CONFIRM_NAME_MISMATCH', '相册名称不匹配，已取消删除');
    }
    const files = await this.images.find({
      where: { albumId: album.id },
      select: { id: true, originalPath: true, previewPath: true, thumbPath: true },
    });
    await this.dataSource.transaction(async (em) => em.getRepository(Album).delete({ id: album.id }));
    // 秒传会让多行共用同一张原图（PRD 4.3），级联删完后再数引用，归零才允许 unlink
    const originals = new Set(files.map((f) => f.originalPath).filter(Boolean));
    for (const path of originals) {
      const stillUsed = await this.images.count({ where: { originalPath: path } });
      if (stillUsed === 0) await this.storage.remove(path);
    }
    for (const file of files) {
      await this.storage.remove(file.previewPath, file.thumbPath);
    }
    await this.log(actor, ctx, 'album_delete', album.id, `${album.name}, images=${files.length}`);
    return files.length;
  }

  /** 上传与打标入口共用：锁定态禁止写入（PRD 4.2） */
  assertEditable(album: Album): void {
    if (album.status === AlbumStatus.Locked) {
      throw new AppError(HttpStatus.CONFLICT, 'ALBUM_LOCKED', '相册已锁定，禁止上传与修改');
    }
  }

  private async log(actor: Actor, ctx: RequestContext, action: string, targetId: number, detail: string): Promise<void> {
    await this.audit.record(actor, ctx, { action, targetType: LogTargetType.Album, targetId, detail });
  }
}
