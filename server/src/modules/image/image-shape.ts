import { Actor, ActorKind } from '../../common/permission/types';
import { Visibility } from '../../common/enums/visibility.enum';
import { Image, Tag, TagType } from '../../entities';

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

export function imageView(
  image: Image,
  actor: Actor,
  opts: { original?: boolean; tags?: TagView[] } = {},
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
    uploadUid: anon ? null : image.uploadUid,
    uploadTempId: anon ? null : (image.uploadTempId ?? null),
    tags: opts.tags ?? [],
    createTime: image.createTime,
    links: {
      preview: previewUrl(image.id),
      original: opts.original ? `${API_PREFIX}/images/${image.id}/original` : null,
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
