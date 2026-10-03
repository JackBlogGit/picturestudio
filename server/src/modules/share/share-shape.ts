import { API_PREFIX, imageView, ImageView, TagView } from '../image/image-shape';
import { ActorKind, ShareActor } from '../../common/permission/types';
import { Album, AlbumStage, CoserShareLink, Image } from '../../entities';

/** 与 client/src/types/api.ts 的 M3 交付段逐字段对齐 */
export interface ShareLinkView {
  id: number;
  shareToken: string;
  url: string;
  scope: 'album' | 'person';
  albumId: number | null;
  albumName: string;
  albumNames: string[];
  coserTagId: number | null;
  coserName: string | null;
  snapshot: 0 | 1;
  hasPassword: boolean;
  allowDownload: 0 | 1;
  visitCount: number;
  expireTime: string;
  revoked: 0 | 1;
  expired: boolean;
  imageCount: number;
  createUid: number;
  createTime: string;
  lastVisitTime: string | null;
}

export interface PublicShareView {
  shareToken: string;
  scope: 'album' | 'person';
  albumName: string;
  albumNames: string[];
  eventName: string;
  eventDate: string;
  coserName: string;
  expireTime: string;
  allowDownload: boolean;
  needPassword: boolean;
  total: number;
  images: ImageView[];
}

/** better-sqlite3 的 datetime 读回来可能是字符串，统一一次再序列化，免得视图里到处 .toISOString() 炸 */
const iso = (value: Date | string | null | undefined): string | null =>
  value === null || value === undefined ? null : new Date(value).toISOString();

/** 注销与过期同口径：对外都是「这条链接已经不行了」，不给枚举留提示（PRD 12.5） */
export function isShareExpired(link: CoserShareLink): boolean {
  return link.revoked === 1 || new Date(link.expireTime).getTime() < Date.now();
}

export function publicImagePrefix(token: string, imageId: number): string {
  return `${API_PREFIX}/public/share/${encodeURIComponent(token)}/images/${imageId}`;
}

/**
 * 访客视角的预览走公开通道而不是 /images/:id/preview：
 * 那条路认成员令牌，分享页的访客手上只有 token，两者不能混用（PRD 10.3）。
 */
export function visitorView(
  image: Image,
  link: CoserShareLink,
  tags: TagView[],
  albumStage: AlbumStage | null,
): ImageView {
  const actor: ShareActor = {
    kind: ActorKind.ShareVisitor,
    linkId: link.id,
    imageIds: [image.id],
    allowDownload: link.allowDownload === 1,
  };
  const base = imageView(image, actor, { albumStage, tags });
  const prefix = publicImagePrefix(link.shareToken, image.id);
  return {
    ...base,
    links: {
      preview: `${prefix}/preview`,
      original: link.allowDownload === 1 ? `${prefix}/original` : null,
    },
  };
}

export function linkView(opts: {
  link: CoserShareLink;
  origin: string;
  album: Album | null;
  albumNames: string[];
  coserName: string | null;
  imageCount: number;
  hasPassword: boolean;
}): ShareLinkView {
  const { link } = opts;
  return {
    id: link.id,
    shareToken: link.shareToken,
    url: `${opts.origin}/s/${encodeURIComponent(link.shareToken)}`,
    scope: link.albumId === null ? 'person' : 'album',
    albumId: link.albumId,
    albumName: opts.album?.name ?? '',
    albumNames: opts.albumNames,
    coserTagId: link.coserTagId,
    coserName: opts.coserName,
    snapshot: (link.snapshot === 1 ? 1 : 0) as 0 | 1,
    // link.password 是 select:false，在这里恒为 undefined，口令位只能由调用方查库给出
    hasPassword: opts.hasPassword,
    allowDownload: (link.allowDownload === 1 ? 1 : 0) as 0 | 1,
    visitCount: link.visitCount,
    expireTime: iso(link.expireTime) ?? '',
    revoked: (link.revoked === 1 ? 1 : 0) as 0 | 1,
    expired: isShareExpired(link),
    imageCount: opts.imageCount,
    createUid: link.createUid,
    createTime: iso(link.createTime) ?? '',
    lastVisitTime: iso(link.lastVisitTime),
  };
}

/** 命中的相册编号按编号排：跨相册链接靠它说清「图从哪几册来」 */
function hitAlbums(images: ImageView[], albumsById: Map<number, Album>): Album[] {
  const ids = [...new Set(images.map((i) => i.albumId))].sort((a, b) => a - b);
  return ids.map((id) => albumsById.get(id)).filter((a): a is Album => a !== undefined);
}

export function publicView(opts: {
  link: CoserShareLink;
  scopeAlbum: Album | null;
  coserName: string | null;
  albumsById: Map<number, Album>;
  images: ImageView[];
}): PublicShareView {
  const { link, scopeAlbum } = opts;
  const hits = hitAlbums(opts.images, opts.albumsById);
  /** 跨相册链接没有单一来源，页头把命中的几册活动名并起来 */
  const union = (pick: (album: Album) => string): string =>
    [...new Set(hits.map(pick))].join('、');
  return {
    shareToken: link.shareToken,
    scope: scopeAlbum === null ? 'person' : 'album',
    albumName: scopeAlbum?.name ?? '',
    albumNames: hits.map((album) => album.name),
    eventName: scopeAlbum ? scopeAlbum.eventName : union((album) => album.eventName),
    eventDate: scopeAlbum ? scopeAlbum.eventDate ?? '' : union((album) => album.eventDate ?? ''),
    coserName: opts.coserName ?? '精选返图',
    expireTime: iso(link.expireTime) ?? '',
    allowDownload: link.allowDownload === 1,
    // 口令没过根本拿不到这份数据，能返回就一定是已解锁状态
    needPassword: false,
    total: opts.images.length,
    images: opts.images,
  };
}
