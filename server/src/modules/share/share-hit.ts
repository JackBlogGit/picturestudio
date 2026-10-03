import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Visibility } from '../../common/enums/visibility.enum';
import {
  Album,
  AlbumStatus,
  CoserShareLink,
  Image,
  ImageTagMap,
  ShareLinkImage,
  Tag,
} from '../../entities';
import { tagMatchFilter } from '../tag/tag-match';

/** 建链时和读链接时共用同一份命中口径，差别只在于集合是固化的还是实时的 */
export interface ShareFilter {
  /** null = person 口径，跨相册汇总 */
  albumId: number | null;
  /** person 口径的池子覆盖：建链时只算当前成员有权建链的相册，读取时不填即全部可对外相册 */
  poolAlbumIds?: number[];
  coserTagId: number | null;
  filterIds: number[];
  snapshot: 0 | 1;
  /** 快照链接的固化集合，动态链接为空 */
  imageIds: number[];
}

export interface ShareHitSummary {
  count: number;
  albumIds: number[];
}

/**
 * 分享链接的命中集合（PRD 4.4 / D2）。
 *
 * 两条与相册列表不同的口径：
 * 1. 访客看到的 = 命中筛选条件的图片，**忽略图片自身的 visibility**，否则逐张设过档位的相册会漏图；
 * 2. person 口径每次读取都重算「可对外相册」，相册后来转 admin 或锁定就自动退出，链接不必重建；
 *    album 口径的池子就是发链接的那一个相册，不再复核相册档位。
 */
@Injectable()
export class ShareHitService {
  constructor(
    @InjectRepository(Image) private readonly images: Repository<Image>,
    @InjectRepository(Album) private readonly albums: Repository<Album>,
    @InjectRepository(ShareLinkImage) private readonly linkImages: Repository<ShareLinkImage>,
    @InjectRepository(Tag) private readonly tags: Repository<Tag>,
  ) {}

  static scopeOf(link: CoserShareLink): 'album' | 'person' {
    return link.albumId === null ? 'person' : 'album';
  }

  /** 链接的筛选标签 = coserTagId ∪ filterJson 里各组的值 */
  static filterIdsOf(link: CoserShareLink): number[] {
    const ids = link.coserTagId === null ? [] : [Number(link.coserTagId)];
    const json = link.filterJson;
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      for (const group of Object.values(json)) {
        if (Array.isArray(group)) ids.push(...group.map(Number).filter(Number.isFinite));
      }
    }
    return [...new Set(ids)];
  }

  async filterOf(link: CoserShareLink): Promise<ShareFilter> {
    const snapshot = (link.snapshot === 1 ? 1 : 0) as 0 | 1;
    const rows =
      snapshot === 1
        ? await this.linkImages.find({ where: { linkId: link.id }, order: { sort: 'ASC' } })
        : [];
    return {
      albumId: link.albumId,
      coserTagId: link.coserTagId,
      filterIds: ShareHitService.filterIdsOf(link),
      snapshot,
      imageIds: rows.map((r) => Number(r.imageId)),
    };
  }

  /** 建链时链接行还不存在，用同一套条件预算命中集合，空集合就不该建快照 */
  draftFilter(
    albumId: number | null,
    coserTagId: number | null,
    tagIds: number[],
    poolAlbumIds?: number[],
  ): ShareFilter {
    return {
      albumId,
      poolAlbumIds,
      coserTagId,
      filterIds: [...new Set(coserTagId === null ? tagIds : [coserTagId, ...tagIds])],
      snapshot: 0,
      imageIds: [],
    };
  }

  /** 可对外返图的相册：档位 public/member 且未锁定 */
  async eligibleAlbumIds(): Promise<number[]> {
    const rows = await this.albums
      .createQueryBuilder('a')
      .select('a.id', 'id')
      .where('a.visibility IN (:...vis)', { vis: [Visibility.Public, Visibility.Member] })
      .andWhere('a.status <> :locked', { locked: AlbumStatus.Locked })
      .getRawMany<{ id: string | number }>();
    return rows.map((r) => Number(r.id)).sort((a, b) => a - b);
  }

  async hitIds(filter: ShareFilter): Promise<number[]> {
    return (await this.rawHits(filter, false)).map((r) => r.id);
  }

  /** 后台列表逐条链接算命中，只要张数和来源相册，不必把整行图片捞出来 */
  async hitSummary(filter: ShareFilter): Promise<ShareHitSummary> {
    const rows = await this.rawHits(filter, true);
    return {
      count: rows.length,
      albumIds: [...new Set(rows.map((r) => r.albumId))].sort((a, b) => a - b),
    };
  }

  /** 册内按 sort，跨册先分册再接各册自己的顺序——sort 只在册内有意义 */
  async hitImages(filter: ShareFilter): Promise<Image[]> {
    const ids = await this.hitIds(filter);
    if (!ids.length) return [];
    const rows = await this.images.find({ where: { id: In(ids) } });
    const crossAlbum = filter.albumId === null;
    return rows.sort(
      (a, b) => (crossAlbum ? a.albumId - b.albumId : 0) || a.sort - b.sort || b.id - a.id,
    );
  }

  async albumsByIds(ids: number[]): Promise<Album[]> {
    if (!ids.length) return [];
    const rows = await this.albums.find({ where: { id: In(ids) } });
    return rows.sort((a, b) => a.id - b.id);
  }

  private async rawHits(
    filter: ShareFilter,
    withAlbum: boolean,
  ): Promise<Array<{ id: number; albumId: number }>> {
    const qb = this.images.createQueryBuilder('i').select('i.id', 'id');
    if (withAlbum) qb.addSelect('i.albumId', 'albumId');

    if (filter.albumId !== null) {
      qb.where('i.albumId = :album', { album: filter.albumId });
    } else {
      const eligible = filter.poolAlbumIds ?? (await this.eligibleAlbumIds());
      if (!eligible.length) return [];
      qb.where('i.albumId IN (:...eligible)', { eligible });
    }
    if (filter.snapshot === 1) {
      /** 快照就是建链那一次固化的集合，标签后来怎么改都不再复核（PRD 4.4） */
      if (!filter.imageIds.length) return [];
      qb.andWhere('i.id IN (:...fixed)', { fixed: filter.imageIds });
    } else if (filter.filterIds.length) {
      const rows = await this.tags.find({ where: { id: In(filter.filterIds) } });
      /** 标签全被删光时按零命中收口：筛选条件只能收窄集合，退化成整池等于把没打算给的图放行 */
      if (!rows.length) return [];
      const match = tagMatchFilter(rows);
      qb.innerJoin(ImageTagMap, 'm', 'm.imageId = i.id')
        .innerJoin(Tag, 't', 't.id = m.tagId')
        .andWhere(match.where, match.params)
        .groupBy('i.id')
        .having(match.having, match.params);
    }

    const raw = await qb.getRawMany<Record<string, string | number>>();
    return raw.map((r) => ({ id: Number(r.id), albumId: Number(r.albumId ?? 0) }));
  }
}
