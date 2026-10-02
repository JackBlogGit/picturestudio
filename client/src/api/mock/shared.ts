/**
 * mock 各接口模块共用的身份解析、投影与判定：handler / share / drive / admin 都从这里取，
 * 免得同一套档位裁剪口径在四个文件里各写一遍。行为对齐后端 service 层。
 */
import type { AlbumCapsView, AlbumCapKey, AlbumView, ImageView, Page, RejectedItem, TagView } from '@/types/api';
import { UserLevel } from '@/types/api';
import { ApiError } from '../error';
import { getAccessToken } from '../token';
import { ALBUMS, TEMPS, USERS, albumById, imagesOfAlbum, tagById } from './db';
import type { ImageSeed } from './db';
import {
  Action,
  capabilitiesFor,
  decide,
  hidesStatusTags,
  memberActorOf,
  visibleTagTypes,
  visibleVisibilities,
} from './policy';
import type { Actor, MemberActor, ResourceRef } from './policy';

export const API = '/api/v1';

export function fail(status: number, code: string, message: string, data: unknown = null): never {
  throw new ApiError(status, code, message, data);
}

/** 令牌格式 mock.<kind>.<id>，只用于恢复身份，不承担鉴权；成员身份带有效能力位（D21） */
export function currentActor(): Actor {
  const token = getAccessToken();
  const parsed = /^mock\.(user|temp)\.(\d+)$/.exec(token);
  if (!parsed) return { kind: 'guest' };
  if (parsed[1] === 'user') {
    const user = USERS.find((u) => u.uid === Number(parsed[2]));
    if (!user) return { kind: 'guest' };
    return memberActorOf({
      uid: user.uid,
      username: user.username,
      nickname: user.nickname,
      level: user.level,
      featureGrant: user.featureGrant,
    });
  }
  const temp = TEMPS.find((t) => t.tempId === Number(parsed[2]));
  if (!temp) fail(401, 'TEMP_NOT_FOUND', '临时账号不存在');
  return {
    kind: 'temp',
    tempId: temp.tempId,
    displayName: temp.displayName,
    ownerUid: temp.ownerUid,
    expiresAt: temp.expiresAt,
    flags: temp.flags,
    albumIds: temp.albumIds,
    folderIds: temp.folderIds,
  };
}

export function requireMember(actor: Actor): Extract<Actor, { kind: 'member' }> {
  if (actor.kind !== 'member') fail(403, 'LEVEL_FORBIDDEN', '仅正式成员可访问');
  return actor;
}

/** L3/L4 才进的后台；L3 再按具体页面收敛范围；门禁读有效 adminConsole（D21 强制关也拦） */
export function requireLevel(actor: Actor, min: UserLevel): MemberActor {
  const member = requireMember(actor);
  // min=3 等价于需要 adminConsole 能力位，min=4 等价于需要 writeSiteSettings
  const requiredCap = min === 4 ? member.caps.writeSiteSettings : member.caps.adminConsole;
  if (member.level < min || !requiredCap) {
    fail(403, 'LEVEL_FORBIDDEN', `需要 L${min} 及以上等级与对应的能力位`);
  }
  return member;
}

export function csv(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '')
    .map(Number);
}

export function str(value: unknown): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : String(value);
}

export function int(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/** 与后端 DTO 的 toBool 同口径：true / 'true' / '1' / 1 都算开 */
export function isTrue(value: unknown): boolean {
  return value === true || value === 'true' || value === '1' || value === 1;
}

/**
 * 帐户ID 格式闸门（PRD 6.2）：注册页建号与超管改 ID 共用这一份，
 * 两处口径分叉的话，会出现「注册页不让用的 ID 后台能改上去」。
 */
export function assertAccountCode(code: string): void {
  if (!/^[A-Z0-9][A-Z0-9-]{3,23}$/.test(code)) {
    fail(400, 'INVALID_ACCOUNT_CODE', '帐户ID 只能是大写字母、数字与短横线，4~24 位');
  }
}

// ---------------- 相册级功能开关（PRD 6.5，D25） ----------------

/** 本册自己关掉的开关键，即 albums.album_caps 那一列的形状：数组里出现即关，缺省即全开 */
export function ownAlbumCaps(album: AlbumView): AlbumCapKey[] {
  return album.albumCaps ?? [];
}

/**
 * 有效关闭集：沿 parent_id 一路并到顶级相册（父关子也关，与 3.2 的档位继承同向）。
 * 整个 mock 只有这里走祖先链，policy 层的判定只读 ResourceRef.albumCaps，不再自己碰树。
 */
export function closedAlbumCaps(album: AlbumView): AlbumCapKey[] {
  const out = new Set<AlbumCapKey>(ownAlbumCaps(album));
  let current = album.parentId === null ? undefined : albumById(album.parentId);
  while (current) {
    for (const key of ownAlbumCaps(current)) out.add(key);
    current = current.parentId === null ? undefined : albumById(current.parentId);
  }
  return [...out];
}

/**
 * 后台功能开关弹窗的三段回显：有效关闭集、本册自己关的、从父册带下来的。
 * 后者在弹窗里只读展示——子册超管不能越过父册去「打开」一件父册关掉的事（只收紧不放宽）。
 */
export function albumCapsView(album: AlbumView): AlbumCapsView {
  const own = ownAlbumCaps(album);
  const inherited = closedAlbumCaps(album).filter((key) => !own.includes(key));
  return { capsOff: [...new Set([...own, ...inherited])], capsOwnOff: own, capsInheritedOff: inherited };
}

export function md5Of(id: number): string {
  let h = id * 2654435761;
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    h = (h * 1103515245 + 12345) >>> 0;
    out += h.toString(16).padStart(8, '0');
    if (out.length >= 32) break;
  }
  return out.slice(0, 32);
}

/** 响应体不出磁盘路径；原图链接只发给成员（PRD 12.3 / 12.8） */
export function toView(seed: ImageSeed, actor: Actor): ImageView {
  const anon = actor.kind === 'guest' || actor.kind === 'share';
  const keep = visibleTagTypes(actor);
  const tags = seed.tags.map((id) => tagById(id)).filter((t): t is TagView => !!t && keep.includes(t.type));
  const tempCanDownload = actor.kind === 'temp' && actor.flags.download;
  const album = albumById(seed.albumId);
  // D25：本册（含父链）关掉「原图下载」时链接位直接不下发——闸门在投影层，不是前端藏按钮（PRD 6.5）
  const downloadClosed = album ? closedAlbumCaps(album).includes('download') : false;
  return {
    id: seed.id,
    albumId: seed.albumId,
    filename: seed.filename,
    // 满画质大 JPEG 约 0.9MB / 百万像素；按 8.4MB 算会得出 337MB 这种不像照片的数
    fileSize: seed.bytes ?? Math.round(seed.megapixels * 900_000),
    width: seed.width,
    height: seed.height,
    md5: md5Of(seed.id),
    shotTime: seed.shotTime,
    watermarked: (album?.visibility === 'public' ? 1 : 0) as 0 | 1,
    visibility: seed.visibility,
    sort: seed.sort,
    uploadUid: anon ? null : seed.uploaderUid,
    uploadTempId: anon ? null : seed.uploaderTempId,
    tags,
    createTime: album?.createTime ?? new Date().toISOString(),
    links: {
      preview: `${API}/images/${seed.id}/preview`,
      original:
        !downloadClosed && (actor.kind === 'member' || tempCanDownload)
          ? `${API}/images/${seed.id}/original`
          : null,
    },
  };
}

export function imageRef(seed: ImageSeed): ResourceRef {
  const album = albumById(seed.albumId);
  return {
    type: 'image',
    id: seed.id,
    visibility: seed.visibility,
    ownerId: seed.uploaderUid,
    albumId: seed.albumId,
    uploadTempId: seed.uploaderTempId,
    containerVisibilities: album ? [album.visibility] : [],
    albumCaps: album ? closedAlbumCaps(album) : [],
  };
}

export function albumRef(album: AlbumView): ResourceRef {
  // 计算祖先链的可见性，子相册不能宽于父相册（PRD 3.2）
  const containerVisibilities: AlbumView['visibility'][] = [];
  let current = albumById(album.parentId!);
  while (current) {
    containerVisibilities.push(current.visibility);
    current = albumById(current.parentId!);
  }
  return {
    type: 'album',
    id: album.id,
    visibility: album.visibility,
    ownerId: album.createUid,
    containerVisibilities,
    // D25：父链带下来的关闭项一并算进来，子册不会借着「自己没关」绕开父册的限制
    albumCaps: closedAlbumCaps(album),
  };
}

/** 相册列表的档位过滤与 AlbumService.list 同源（PRD 6.2）。
 * 只返回顶级相册（parentId === null），子相册在父相册详情页内展示。 */
export function listableAlbums(actor: Actor): AlbumView[] {
  if (actor.kind === 'guest') {
    return ALBUMS.filter((a) => a.parentId === null && a.visibility === 'public' && a.status !== 2);
  }
  if (actor.kind === 'temp') {
    // 临时账号仅能看到白名单中且 visibility === 'public' 的顶级相册
    // D25：本册关掉「临时账号访问」时整本从列表消失——闸门口径要和 decideTemp 的 404 一致，不能列表可见、点进 404
    return ALBUMS.filter(
      (a) =>
        a.parentId === null &&
        actor.albumIds.includes(a.id) &&
        a.visibility === 'public' &&
        a.status !== 2 &&
        !closedAlbumCaps(a).includes('tempAccess'),
    );
  }
  if (actor.kind === 'share') return [];
  const allowed = visibleVisibilities(actor.level);
  return ALBUMS.filter(
    (a) =>
      a.parentId === null &&
      (allowed.includes(a.visibility) || (a.visibility === 'private' && a.createUid === actor.uid)),
  );
}

/** 守卫语义：先按身份判相册可读，读不到统一 404（PRD 12.5） */
export function readableAlbum(albumId: number, actor: Actor): AlbumView {
  const album = albumById(albumId);
  if (!album) fail(404, 'NOT_FOUND', '相册不存在或无权查看');
  const decision = decide(Action.Preview, actor, albumRef(album));
  if (!decision.allowed) fail(decision.status, decision.reason, decision.message);
  return album;
}

/** 图片档位裁剪与 ImageService.applyVisibility 一致 */
export function readableImages(seeds: ImageSeed[], actor: Actor): ImageSeed[] {
  if (actor.kind === 'guest' || actor.kind === 'share') {
    return seeds.filter((s) => s.visibility === 'public');
  }
  // 临时账号仅能看到 public 档的图片（白名单 + 档位双重闸门）
  if (actor.kind === 'temp') return seeds.filter((s) => s.visibility === 'public');
  const allowed = visibleVisibilities(actor.level);
  if (allowed.includes('private')) return seeds;
  return seeds.filter(
    (s) => allowed.includes(s.visibility) || (s.visibility === 'private' && s.uploaderUid === actor.uid),
  );
}

/** 类型之间 AND、同类型多值 OR（PRD 4.4） */
export function matchTags(seeds: ImageSeed[], wanted: number[]): ImageSeed[] {
  const groups = new Map<string, number[]>();
  for (const id of wanted) {
    const tag = tagById(id);
    if (!tag) fail(400, 'TAG_NOT_FOUND', `标签不存在：${id}`);
    groups.set(tag.type, [...(groups.get(tag.type) ?? []), tag.id]);
  }
  return seeds.filter((s) =>
    [...groups.values()].every((ids) => ids.some((id) => s.tags.includes(id))),
  );
}

export function paged<T>(list: T[], page: number, pageSize: number): Page<T> {
  const start = (page - 1) * pageSize;
  return { page, pageSize, total: list.length, list: list.slice(start, start + pageSize) };
}

export function assertWritable(actor: Actor): void {
  if (actor.kind === 'guest') fail(401, 'LOGIN_REQUIRED', '需登录后操作');
  if (actor.kind === 'share') fail(403, 'SHARE_READONLY', '分享链接仅支持浏览与下载');
}

export function assertNotTrainee(actor: Actor): void {
  // 批量操作的"见习限制"改为读能力位：editOwn（批量打标签）与 changeVisibility（批量改档位）
  // 现在由 capGate 按 PRD 6.4 判定——等级默认值 + 超管覆盖，不再硬编码 L1。
  // 此函数保留占位，新代码不再调用。
  void actor;
}

/** 锁定相册禁止写入（PRD 4.2），批量场景里以清单项返回而不是中断整批 */
export function lockedItem(imageId: number): RejectedItem {
  return { imageId, status: 409, code: 'ALBUM_LOCKED', message: '相册已锁定，禁止上传与修改' };
}

export { Action, capabilitiesFor, hidesStatusTags, imagesOfAlbum, visibleTagTypes, visibleVisibilities };
export type { Actor, AlbumView, ImageView, ImageSeed, RejectedItem, TagView };
