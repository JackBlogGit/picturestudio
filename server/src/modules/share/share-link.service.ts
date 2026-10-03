import { randomBytes } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Env } from '../../config/env.config';
import { UserLevel } from '../../common/enums/user-level.enum';
import { AppError } from '../../common/http/app-error';
import { requireMember } from '../../common/permission/actor-guards';
import { canGenerateShareLinkFor, decide } from '../../common/permission/permission-policy';
import { Action, Actor, MemberActor, ResourceType } from '../../common/permission/types';
import {
  Album,
  AlbumStatus,
  CoserShareLink,
  LogTargetType,
  ShareLinkImage,
  Tag,
  TagType,
} from '../../entities';
import { AuditService, RequestContext } from '../audit/audit.service';
import { BCRYPT_COST } from '../auth/auth.service';
import {
  CreateShareLinkDto,
  ListShareLinkDto,
  SHARE_DEFAULT_DAYS,
  SHARE_MAX_DAYS,
} from './dto/share.dto';
import { ShareFilter, ShareHitService } from './share-hit';
import { linkView, ShareLinkView } from './share-shape';

const DAY_MS = 86_400_000;

/** token 只用来定位一条链接，纯随机即可；64 位随机数撞库不在考虑范围内 */
function newShareToken(): string {
  return `pk-${randomBytes(4).toString('hex')}-${randomBytes(4).toString('hex')}`;
}

@Injectable()
export class ShareLinkService {
  private readonly origin: string;

  constructor(
    @InjectRepository(CoserShareLink) private readonly links: Repository<CoserShareLink>,
    @InjectRepository(Album) private readonly albums: Repository<Album>,
    @InjectRepository(Tag) private readonly tags: Repository<Tag>,
    private readonly dataSource: DataSource,
    private readonly hits: ShareHitService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.origin = config.getOrThrow<Env>('app').siteUrl;
  }

  /** 相册口径：本相册内按标签命中，档位与锁定两道闸在生成时把住源头（PRD 4.4） */
  async createForAlbum(
    albumId: number,
    dto: CreateShareLinkDto,
    actor: Actor,
    ctx: RequestContext,
  ): Promise<ShareLinkView> {
    const member = requireMember(actor, '生成返图链接');
    const album = await this.albumById(albumId);
    if (album.status === AlbumStatus.Locked) {
      throw new AppError(HttpStatus.CONFLICT, 'ALBUM_LOCKED', '相册已锁定，禁止生成新的返图链接');
    }
    if (!canGenerateShareLinkFor(album.visibility)) {
      throw new AppError(
        HttpStatus.FORBIDDEN,
        'SHARE_SOURCE_FORBIDDEN',
        '相册档位为 admin/private，请先改为 public/member 再生成链接',
      );
    }
    const coser = await this.optionalTag(dto.coserTagId);
    const draft = this.hits.draftFilter(album.id, coser?.id ?? null, dto.tagIds ?? []);
    return this.persist(draft, dto, member, ctx);
  }

  /**
   * 返给个人：以 Coser 为主体跨相册汇总。来源相册逐册过三道闸——档位、锁定、本人有没有建链权限，
   * 过不了的相册不进这条链接，而不是让整个请求失败（PRD 10.3）。
   */
  async createForPerson(
    dto: CreateShareLinkDto,
    actor: Actor,
    ctx: RequestContext,
  ): Promise<ShareLinkView> {
    const member = requireMember(actor, '生成返图链接');
    const coser = await this.requireCoser(dto.coserTagId);
    const sources = await this.deliverableAlbumIds(member);
    const draft = this.hits.draftFilter(null, coser.id, dto.tagIds ?? [], sources);
    if (!(await this.hits.hitIds(draft)).length) {
      throw new AppError(
        HttpStatus.CONFLICT,
        'NO_SHARE_SOURCE',
        `可对外返图的相册里没有「${coser.tagName}」的图（档位需为 public/member 且未锁定）`,
      );
    }
    return this.persist(draft, dto, member, ctx);
  }

  /** GET /share-links：L3/L4 看全站，L2 只看本人创建；返回裸数组，页面自己排 */
  async list(query: ListShareLinkDto, actor: Actor): Promise<ShareLinkView[]> {
    const member = requireMember(actor, '管理返图链接');
    const rows = await this.links.find({ order: { createTime: 'DESC', id: 'DESC' } });
    const scoped =
      member.level >= UserLevel.Admin ? rows : rows.filter((r) => r.createUid === member.uid);

    const flags = await this.passwordFlagsOf(scoped.map((link) => link.id));
    const views: ShareLinkView[] = [];
    for (const link of scoped) {
      const built = await this.buildView(link, flags.get(link.id) ?? false);
      if (query.onlyAlive && built.view.expired) continue;
      /** 跨相册链接也命中本相册的图，得跟着出现在当册的清单里 */
      if (query.album && built.view.albumId !== query.album && !built.albumIds.includes(query.album)) {
        continue;
      }
      views.push(built.view);
    }
    return views;
  }

  /** 撤销即收回交付：访客侧再访问一律 404，与 token 写错同一口径，不给枚举留提示 */
  async revoke(id: number, actor: Actor, ctx: RequestContext): Promise<ShareLinkView> {
    const member = requireMember(actor, '撤销返图链接');
    const link = await this.byId(id);
    if (link.createUid !== member.uid && member.level < UserLevel.Admin) {
      throw new AppError(HttpStatus.FORBIDDEN, 'NOT_OWNER', '只能撤销本人创建的链接');
    }
    link.revoked = 1;
    await this.links.save(link);
    await this.audit.record(member, ctx, {
      action: 'share_link_revoke',
      targetType: LogTargetType.Link,
      targetId: link.id,
      detail: link.shareToken,
    });
    return (await this.buildView(link, await this.passwordSet(link.id))).view;
  }

  /** 供公开通道复用：按 token 取链接行，找不到即 null，由调用方决定回 404 还是 410 */
  async byToken(shareToken: string): Promise<CoserShareLink | null> {
    return this.links.findOne({ where: { shareToken } });
  }

  /**
   * password 列 select:false，常规查询只会带出 undefined，拿它判「有没有设口令」必然全错。
   * 要这个位就单独问一次 IS NOT NULL，哈希本身不进内存、更不进响应。
   */
  async passwordFlagsOf(ids: number[]): Promise<Map<number, boolean>> {
    if (!ids.length) return new Map();
    const rows = await this.links
      .createQueryBuilder('l')
      .select('l.id', 'id')
      .addSelect('CASE WHEN l.password IS NULL THEN 0 ELSE 1 END', 'has')
      .where('l.id IN (:...ids)', { ids })
      .getRawMany<{ id: number | string; has: number | string }>();
    return new Map(rows.map((row) => [Number(row.id), Number(row.has) === 1]));
  }

  async passwordSet(id: number): Promise<boolean> {
    return (await this.passwordFlagsOf([id])).get(id) ?? false;
  }

  /** 哈希只在口令校验这一条路上取，取到即比对，不往外传 */
  async passwordOf(id: number): Promise<string | null> {
    const row = await this.links.createQueryBuilder('l').addSelect('l.password').where('l.id = :id', { id }).getOne();
    return row?.password ?? null;
  }

  async tagOf(id: number | null): Promise<Tag | null> {
    if (id === null) return null;
    return this.tags.findOne({ where: { id } });
  }

  async albumOf(id: number | null): Promise<Album | null> {
    if (id === null) return null;
    return this.albums.findOne({ where: { id } });
  }

  private async persist(
    draft: ShareFilter,
    dto: CreateShareLinkDto,
    member: MemberActor,
    ctx: RequestContext,
  ): Promise<ShareLinkView> {
    const snapshot = dto.snapshot ? 1 : 0;
    const hitIds = await this.hits.hitIds(draft);
    if (snapshot === 1 && !hitIds.length) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'EMPTY_SNAPSHOT', '快照模式下没有命中任何图片');
    }
    const days = Math.min(SHARE_MAX_DAYS, Math.max(1, Math.trunc(dto.expireDays ?? SHARE_DEFAULT_DAYS)));
    const saved = await this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(CoserShareLink);
      const row = await repo.save(
        repo.create({
          shareToken: newShareToken(),
          albumId: draft.albumId,
          coserTagId: draft.coserTagId,
          filterJson: draft.filterIds.length ? { tags: draft.filterIds } : null,
          snapshot,
          // 库里只留 bcrypt，响应体永远只回「有没有口令」
          password: dto.password ? await bcrypt.hash(dto.password, BCRYPT_COST) : null,
          allowDownload: dto.allowDownload ? 1 : 0,
          visitCount: 0,
          expireTime: new Date(Date.now() + days * DAY_MS),
          revoked: 0,
          createUid: member.uid,
          lastVisitTime: null,
        }),
      );
      if (snapshot === 1) {
        await em.getRepository(ShareLinkImage).insert(
          hitIds.map((imageId, index) => ({ linkId: row.id, imageId, sort: index + 1 })),
        );
      }
      return row;
    });

    await this.audit.record(member, ctx, {
      action: 'share_link_create',
      targetType: LogTargetType.Link,
      targetId: saved.id,
      detail: `scope=${saved.albumId === null ? 'person' : 'album'}, album=${saved.albumId ?? '-'}, snapshot=${snapshot}, images=${snapshot === 1 ? hitIds.length : 'dynamic'}, days=${days}, download=${saved.allowDownload}`,
    });
    return (await this.buildView(saved, Boolean(dto.password))).view;
  }

  private async buildView(
    link: CoserShareLink,
    hasPassword: boolean,
  ): Promise<{ view: ShareLinkView; albumIds: number[] }> {
    const filter = await this.hits.filterOf(link);
    const summary = await this.hits.hitSummary(filter);
    const [album, coser, hitAlbums] = await Promise.all([
      this.albumOf(link.albumId),
      this.tagOf(link.coserTagId),
      this.hits.albumsByIds(summary.albumIds),
    ]);
    return {
      albumIds: summary.albumIds,
      view: linkView({
        link,
        origin: this.origin,
        album,
        albumNames: hitAlbums.map((a) => a.name),
        coserName: coser?.tagName ?? null,
        imageCount: summary.count,
        hasPassword,
      }),
    };
  }

  /** 来源相册逐册过闸：档位与锁定由 eligibleAlbumIds 管，建链权限在这里按人再收一道 */
  private async deliverableAlbumIds(member: MemberActor): Promise<number[]> {
    const eligible = await this.hits.eligibleAlbumIds();
    if (!eligible.length) return [];
    const rows = await this.albums.find({ where: { id: In(eligible) } });
    return rows
      .filter(
        (album) =>
          decide(Action.CreateShareLink, member, {
            type: ResourceType.Album,
            id: album.id,
            visibility: album.visibility,
            ownerId: album.createUid,
            albumId: album.id,
            containerVisibilities: [],
          }).allowed,
      )
      .map((album) => album.id);
  }

  /** 相册口径的 coserTagId 只是筛选条件之一，标签被删过就按「标签不存在」打回，别让整个请求 500 */
  private async optionalTag(id: number | null | undefined): Promise<Tag | null> {
    if (id === null || id === undefined) return null;
    const tag = await this.tags.findOne({ where: { id } });
    if (!tag) throw new AppError(HttpStatus.BAD_REQUEST, 'TAG_NOT_FOUND', `标签不存在：${id}`);
    return tag;
  }

  /** 返给个人以 Coser 为主体，标签没给、给错、类型不对都没有命中口径（PRD 10.3） */
  private async requireCoser(id: number | null | undefined): Promise<Tag> {
    const tag = id === null || id === undefined ? null : await this.tags.findOne({ where: { id } });
    if (!tag) throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', '返给个人必须指定 Coser');
    if (tag.tagType !== TagType.Coser) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'TAG_TYPE_WRONG', '返图对象只能是 coser 类型标签');
    }
    return tag;
  }

  private async byId(id: number): Promise<CoserShareLink> {
    const row = await this.links.findOne({ where: { id } });
    if (!row) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', '链接不存在');
    return row;
  }

  private async albumById(id: number): Promise<Album> {
    const row = await this.albums.findOne({ where: { id } });
    if (!row) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', '相册不存在或无权查看');
    return row;
  }
}
