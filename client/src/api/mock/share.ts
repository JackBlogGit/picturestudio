/**
 * Coser 返图分享链接的 mock，对应后端 PRD 10.3 的六条路由。
 * 两种口径：`album` 在单个相册内按标签命中，`person` 把同一个 Coser 跨相册汇总成一条链接。
 * 关键口径：链接有效期内访客可见 = 命中筛选条件的图片预览，**忽略图片自身的 visibility**（D2），
 * 但相册本身是 admin/private 时禁止生成；命中集合外的图片 ID 一律 404 而不是 403。
 */
import type { ImageView, PublicShareView, ShareLinkView } from '@/types/api';
import { ALBUMS, IMAGES, albumById, imagesOfAlbum, tagById } from './db';
import type { ImageSeed } from './db';
import { Action, decide } from './policy';
import type { Actor } from './policy';
import { API, albumRef, assertWritable, csv, fail, int, isTrue, matchTags, str, toView } from './shared';
import { SHARE_LINKS, nextShareToken, shareByToken, shareExpired } from './tables';
import type { MockShareLink } from './tables';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

/** 口令校验通过后签发的「链接子会话」，真接口是 HttpOnly Cookie，mock 只记在内存里 */
const UNLOCKED = new Map<string, number>();
const SUBSESSION_MS = 2 * 3600_000;

function filterIds(link: MockShareLink): number[] {
  const ids: number[] = [];
  if (link.coserTagId) ids.push(link.coserTagId);
  if (link.filterJson) {
    try {
      const parsed = JSON.parse(link.filterJson) as Record<string, number[]>;
      for (const group of Object.values(parsed)) ids.push(...group);
    } catch {
      // 筛选条件写坏时退化为「无附加筛选」，不能让一整页打不开
    }
  }
  return [...new Set(ids)];
}

/** 档位允许对外的相册：public/member 且未锁定（PRD 4.4 的生成闸门，跨相册链接每次读取都按它复核） */
function eligibleAlbumIds(): number[] {
  return ALBUMS.filter((a) => (a.visibility === 'public' || a.visibility === 'member') && a.status !== 3).map(
    (a) => a.id,
  );
}

const bySort = (a: ImageSeed, b: ImageSeed): number => a.sort - b.sort;
/** sort 只在册内有意义，跨相册时先按册分块，再把各册自己的顺序接上 */
const byAlbumThenSort = (a: ImageSeed, b: ImageSeed): number => a.albumId - b.albumId || a.sort - b.sort;

/** 命中集合：快照用固化 ID，动态每次实时算（PRD 4.4） */
function hitImages(link: MockShareLink): ImageSeed[] {
  const pool =
    link.scope === 'person'
      ? IMAGES.filter((s) => eligibleAlbumIds().includes(s.albumId))
      : imagesOfAlbum(link.albumId ?? 0);
  const hit =
    link.snapshot === 1 ? pool.filter((s) => link.imageIds.includes(s.id)) : matchTags(pool, filterIds(link));
  return hit.sort(link.scope === 'person' ? byAlbumThenSort : bySort);
}

/** 链接当前实际命中的相册名，按相册编号排：跨相册链接靠它说清「图从哪几册来」 */
function hitAlbumNames(link: MockShareLink): string[] {
  const ids = [...new Set(hitImages(link).map((s) => s.albumId))].sort((a, b) => a - b);
  return ids.map((id) => albumById(id)?.name ?? `#${id}`);
}

/** 访客视角的投影：走公开通道的预览，只有 allow_download=1 才给原图链接 */
function visitorView(seed: ImageSeed, link: MockShareLink): ImageView {
  const actor: Actor = {
    kind: 'share',
    shareId: link.id,
    imageIds: [seed.id],
    allowDownload: link.allowDownload === 1,
  };
  const base = toView(seed, actor);
  return {
    ...base,
    links: {
      preview: `${API}/public/share/${link.shareToken}/images/${seed.id}/preview`,
      original:
        link.allowDownload === 1
          ? `${API}/public/share/${link.shareToken}/images/${seed.id}/original`
          : null,
    },
  };
}

/** 管理侧的链接视图：口令只回「有没有」，绝不回明文（PRD 12.1） */
export function linkView(link: MockShareLink): ShareLinkView {
  const album = link.albumId === null ? undefined : albumById(link.albumId);
  const coser = link.coserTagId ? tagById(link.coserTagId) : undefined;
  return {
    id: link.id,
    shareToken: link.shareToken,
    url: `${window.location.origin}/s/${link.shareToken}`,
    scope: link.scope,
    albumId: link.albumId,
    albumName: album?.name ?? '',
    albumNames: hitAlbumNames(link),
    coserTagId: link.coserTagId,
    coserName: coser?.name ?? null,
    snapshot: link.snapshot,
    hasPassword: link.password !== null,
    allowDownload: link.allowDownload,
    visitCount: link.visitCount,
    expireTime: link.expireTime,
    revoked: link.revoked,
    expired: shareExpired(link),
    imageCount: hitImages(link).length,
    createUid: link.createUid,
    createTime: link.createTime,
    lastVisitTime: link.lastVisitTime,
  };
}

interface LinkDraft {
  scope: 'album' | 'person';
  albumId: number | null;
  coserTagId: number | null;
  filterIdsList: number[];
  snapshot: 0 | 1;
  imageIds: number[];
}

/** 两种链接只差来源与命中口径，落库字段共用一份，免得两条路径各写一遍口令/有效期规则 */
function saveLink(draft: LinkDraft, body: Record<string, unknown>, actor: Actor): MockShareLink {
  const days = Math.min(MAX_DAYS, Math.max(1, int(body.expireDays, DEFAULT_DAYS)));
  const link: MockShareLink = {
    id: Math.max(0, ...SHARE_LINKS.map((s) => s.id)) + 1,
    shareToken: nextShareToken(),
    scope: draft.scope,
    albumId: draft.albumId,
    coserTagId: draft.coserTagId,
    filterJson: draft.filterIdsList.length ? JSON.stringify({ tags: draft.filterIdsList }) : null,
    snapshot: draft.snapshot,
    // 真接口存 bcrypt，这里只存演示口令，任何响应体都不会把它带出去
    password: str(body.password) ?? null,
    allowDownload: isTrue(body.allowDownload) ? 1 : 0,
    visitCount: 0,
    expireTime: new Date(Date.now() + days * 86_400_000).toISOString(),
    revoked: 0,
    createUid: actor.kind === 'member' ? actor.uid : 0,
    createTime: new Date().toISOString(),
    lastVisitTime: null,
    imageIds: draft.imageIds,
  };
  SHARE_LINKS.push(link);
  return link;
}

export function createShareLink(albumId: number, body: Record<string, unknown>, actor: Actor): ShareLinkView {
  assertWritable(actor);
  const album = albumById(albumId);
  if (!album) fail(404, 'NOT_FOUND', '相册不存在或无权查看');

  const decision = decide(Action.CreateShareLink, actor, albumRef(album));
  if (!decision.allowed) fail(decision.status, decision.reason, decision.message);
  if (album.status === 3) fail(409, 'ALBUM_LOCKED', '相册已锁定，禁止生成新的返图链接');
  // 对外发链接的源头只允许 public/member（PRD 4.4）
  if (album.visibility === 'admin' || album.visibility === 'private') {
    fail(403, 'SHARE_SOURCE_FORBIDDEN', '相册档位为 admin/private，请先改为 public/member 再生成链接');
  }

  const coserTagId = body.coserTagId === undefined || body.coserTagId === null ? null : Number(body.coserTagId);
  const extra = csv(body.tagIds);
  const filterIdsList = [...new Set([...(coserTagId ? [coserTagId] : []), ...extra])];
  const snapshot = isTrue(body.snapshot) ? 1 : 0;
  const imageIds = snapshot
    ? matchTags(imagesOfAlbum(album.id), filterIdsList).map((s) => s.id)
    : [];
  if (snapshot && !imageIds.length) fail(400, 'EMPTY_SNAPSHOT', '快照模式下没有命中任何图片');

  return linkView(
    saveLink({ scope: 'album', albumId: album.id, coserTagId, filterIdsList, snapshot, imageIds }, body, actor),
  );
}

/**
 * 返给个人：以 Coser 为主体，把这个人在所有可对外相册里的图汇总成一条链接。
 * 来源相册逐册过三道闸——档位、锁定、本人有没有建链权限（L2 只能返自己拍的），
 * 过不了的相册直接不进这条链接，而不是让整个请求失败。
 */
export function createPersonShareLink(body: Record<string, unknown>, actor: Actor): ShareLinkView {
  assertWritable(actor);
  const coserTagId = Number(body.coserTagId);
  const coser = Number.isInteger(coserTagId) ? tagById(coserTagId) : undefined;
  if (!coser) fail(400, 'VALIDATION_FAILED', '返给个人必须指定 Coser');
  if (coser.type !== 'coser') fail(400, 'TAG_TYPE_WRONG', '返图对象只能是 coser 类型标签');

  const sourceAlbums = eligibleAlbumIds().filter((id) => {
    const album = albumById(id);
    return album !== undefined && decide(Action.CreateShareLink, actor, albumRef(album)).allowed;
  });
  const extra = csv(body.tagIds);
  const filterIdsList = [...new Set([coserTagId, ...extra])];
  const snapshot = isTrue(body.snapshot) ? 1 : 0;
  const matched = matchTags(
    IMAGES.filter((s) => sourceAlbums.includes(s.albumId)),
    filterIdsList,
  );
  if (!matched.length) {
    fail(409, 'NO_SHARE_SOURCE', `可对外返图的相册里没有「${coser.name}」的图（档位需为 public/member 且未锁定）`);
  }

  return linkView(
    saveLink(
      {
        scope: 'person',
        albumId: null,
        coserTagId,
        filterIdsList,
        snapshot,
        imageIds: snapshot ? matched.map((s) => s.id) : [],
      },
      body,
      actor,
    ),
  );
}

/** GET /share-links：L3/L4 看全站，L2 只看本人创建 */
export function listShareLinks(query: Record<string, unknown> | undefined, actor: Actor): ShareLinkView[] {
  if (actor.kind !== 'member') fail(403, 'LEVEL_FORBIDDEN', '返图链接管理仅成员可见');
  let rows = SHARE_LINKS.slice();
  if (actor.level < 3) rows = rows.filter((s) => s.createUid === actor.uid);
  const albumId = int(query?.album, 0);
  // 跨相册链接也命中本相册的图，得跟着出现在当册的清单里
  if (albumId) rows = rows.filter((s) => s.albumId === albumId || hitImages(s).some((i) => i.albumId === albumId));
  if (isTrue(query?.onlyAlive)) rows = rows.filter((s) => !shareExpired(s));
  return rows
    .sort((a, b) => b.createTime.localeCompare(a.createTime))
    .map((s) => linkView(s));
}

export function revokeShareLink(id: number, actor: Actor): ShareLinkView {
  assertWritable(actor);
  const link = SHARE_LINKS.find((s) => s.id === id);
  if (!link) fail(404, 'NOT_FOUND', '链接不存在');
  if (actor.kind !== 'member') fail(403, 'SHARE_READONLY', '分享访客不能撤销链接');
  if (link.createUid !== actor.uid && actor.level < 3) {
    fail(403, 'NOT_OWNER', '只能撤销本人创建的链接');
  }
  link.revoked = 1;
  return linkView(link);
}

function unlocked(link: MockShareLink): boolean {
  if (!link.password) return true;
  const until = UNLOCKED.get(link.shareToken);
  return until !== undefined && until > Date.now();
}

/** GET /public/share/:token */
export function publicShare(token: string): PublicShareView {
  const link = shareByToken(token);
  // 注销与不存在同一口径，避免枚举 token（PRD 12.5）
  if (!link || link.revoked === 1) fail(404, 'NOT_FOUND', '链接不存在或已被注销');
  if (shareExpired(link)) fail(410, 'LINK_EXPIRED', '该返图链接已过期，交付已收回');
  if (!unlocked(link)) fail(403, 'SHARE_PASSWORD_REQUIRED', '该链接需要访问密码');

  const seeds = hitImages(link);
  link.visitCount += 1;
  link.lastVisitTime = new Date().toISOString();
  const coser = link.coserTagId ? tagById(link.coserTagId) : undefined;
  const album = link.albumId === null ? undefined : albumById(link.albumId);
  // 跨相册链接没有单一来源，页头把命中的几册活动名并起来说清来源
  const hitAlbums = [...new Set(seeds.map((s) => s.albumId))]
    .map((id) => albumById(id))
    .filter((a): a is NonNullable<ReturnType<typeof albumById>> => a !== undefined);
  const union = (pick: (a: (typeof hitAlbums)[number]) => string): string =>
    [...new Set(hitAlbums.map(pick))].join('、');
  return {
    shareToken: link.shareToken,
    scope: link.scope,
    albumName: album?.name ?? '',
    albumNames: hitAlbumNames(link),
    eventName: album ? album.eventName : union((a) => a.eventName),
    eventDate: album ? album.eventDate : union((a) => a.eventDate),
    coserName: coser?.name ?? '精选返图',
    expireTime: link.expireTime,
    allowDownload: link.allowDownload === 1,
    needPassword: false,
    total: seeds.length,
    images: seeds.map((s) => visitorView(s, link)),
  };
}

/** POST /public/share/:token/unlock */
export function unlockShare(token: string, body: Record<string, unknown>): { unlocked: true } {
  const link = shareByToken(token);
  if (!link || link.revoked === 1) fail(404, 'NOT_FOUND', '链接不存在或已被注销');
  if (shareExpired(link)) fail(410, 'LINK_EXPIRED', '该返图链接已过期，交付已收回');
  // 无密码链接直接算通过，前端不用分支
  if (!link.password) return { unlocked: true };
  if (String(body.password ?? '') !== link.password) {
    fail(401, 'BAD_CREDENTIALS', '访问密码错误');
  }
  UNLOCKED.set(token, Date.now() + SUBSESSION_MS);
  return { unlocked: true };
}

/** 访客请求集合外的图片 ID：404，不用 403 暴露存在性（PRD 4.4） */
export function shareImage(token: string, imageId: number, action: 'preview' | 'original'): ImageView {
  const link = shareByToken(token);
  if (!link || link.revoked === 1 || shareExpired(link)) fail(404, 'NOT_FOUND', '链接不存在或已失效');
  const seed = hitImages(link).find((s) => s.id === imageId);
  if (!seed) fail(404, 'NOT_FOUND', '该图片不在分享链接范围内');
  const view = visitorView(seed, link);
  if (action === 'original' && !view.links.original) {
    fail(403, 'SHARE_DOWNLOAD_OFF', '该分享链接未开放原图下载');
  }
  return view;
}
