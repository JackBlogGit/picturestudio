import { Actor, ActorKind } from '../../common/permission/types';
import { Visibility } from '../../common/enums/visibility.enum';
import { AlbumStage, Image, Tag, TagType } from '../../entities';

/**
 * 图片对外的唯一体裁口径：originalPath / previewPath / thumbPath 一律不出网，
 * 字节只能通过 /images/:id/preview 与 /images/:id/original 两个鉴权出口拿到（PRD 12.3）。
 */
export interface TagView {
  id: number;
  type: TagType;
  name: string;
}

export interface ImageView {
  id: number;
  albumId: number;
  filename: string;
  fileSize: number;
  width: number;
  height: number;
  md5: string;
  shotTime: Date | null;
  watermarked: 0 | 1;
  visibility: Visibility;
  sort: number;
  /** D31：这张图处于前期还是后期；图自己没标过时由所属相册的阶段兜住 */
  stage: AlbumStage;
  uploadUid: number | null;
  uploadTempId: number | null;
  tags: TagView[];
  createTime: Date;
  links: { preview: string; original: string | null };
}

export const API_PREFIX = '/api/v1';

export function previewUrl(id: number): string {
  return `${API_PREFIX}/images/${id}/preview`;
}

/**
 * 谁能拿到原图链接（PRD 6.2 / 12.8）：成员一律给，临时账号只在「原图下载」开着时给，
 * 游客与分享访客恒空——分享页的原图另有公开通道，由 visitorView 覆写。
 * 闸门在投影层而不是前端藏按钮，D25 的相册级开关也接在这一位上。
 */
export function mayTakeOriginal(actor: Actor): boolean {
  if (actor.kind === ActorKind.Member) return true;
  if (actor.kind === ActorKind.Temp) return actor.flags.download;
  return false;
}

export function imageView(
  image: Image,
  actor: Actor,
  opts: { albumStage?: AlbumStage | null; tags?: TagView[] } = {},
): ImageView {
  // 游客与分享访客不给上传账号（PRD 12.8）；成员和临时账号要靠它判断「仅本人上传」
  const anon = actor.kind === ActorKind.Guest || actor.kind === ActorKind.ShareVisitor;
  return {
    id: image.id,
    albumId: image.albumId,
    filename: image.filename,
    fileSize: Number(image.fileSize),
    width: image.width,
    height: image.height,
    md5: image.md5,
    shotTime: image.shotTime,
    watermarked: (image.watermarked ? 1 : 0) as 0 | 1,
    visibility: image.visibility,
    sort: image.sort,
    stage: image.imgStage ?? opts.albumStage ?? AlbumStage.Post,
    uploadUid: anon ? null : image.uploadUid,
    uploadTempId: anon ? null : (image.uploadTempId ?? null),
    tags: opts.tags ?? [],
    createTime: image.createTime,
    links: {
      preview: previewUrl(image.id),
      original: mayTakeOriginal(actor) ? `${API_PREFIX}/images/${image.id}/original` : null,
    },
  };
}

/**
 * 标签下发范围（PRD 6.2 / 6.3）：成员全量；临时账号去掉内部 status；
 * 游客与分享访客只给漫展和角色，其余一律当作不存在。
 */
export function visibleTags(actor: Actor, tags: Tag[]): TagView[] {
  return tags
    .filter((t) => {
      if (actor.kind === ActorKind.Member) return true;
      if (actor.kind === ActorKind.Temp) return t.tagType !== TagType.Status;
      return t.tagType === TagType.Event || t.tagType === TagType.Role;
    })
    .map((t) => ({ id: t.id, type: t.tagType, name: t.tagName }));
}
