/**
 * 相册写入的 mock：档位上限（PRD 6.1）、子资源向下继承（3.2）、归档与锁定（4.2）、
 * 等级 × 操作矩阵（7.2）全部走 policy.ts 的判定，和后端 AlbumService 同一套口径。
 * 前台「我的相册」与后台「相册管理」共用这里，后台只是多一个看全站的列表口径。
 * 子相册：仅 L4 超管可在相册内新建子相册，子相册档位不得宽于父相册（PRD 3.2）。
 */
import type { AlbumRowView, AlbumStage, AlbumView, Page } from '@/types/api';
import { AlbumStatus, VISIBILITY_RANK } from '@/types/api';
import { ALBUMS, USERS, addAlbum, albumById, imagesOfAlbum, levelName, patchAlbum, removeAlbum } from './db';
import { Action, canSetPublic, checkInheritance, decide, visibleVisibilities } from './policy';
import type { Actor } from './policy';
import { albumCapsView, albumRef, assertWritable, fail, int, listableAlbums, paged, requireLevel, str } from './shared';
import { UserLevel } from '@/types/api';

/** 行形状即响应形状，契约类型在 @/types/api 定义，这里只留短名 */
export type AlbumRow = AlbumRowView;

/** 后台模块（admin.ts 的开关接口）复用同一份行投影，免得两边各拼一遍张数与创建者 */
export const albumRow = row;

function row(album: AlbumView): AlbumRow {
  const owner = USERS.find((u) => u.uid === album.createUid);
  return {
    ...album,
    // D25：开关回显随相册行一起下发，前端按 capsOff 不渲染入口，后台弹窗按 own/inherited 区分来源
    ...albumCapsView(album),
    imagesCount: imagesOfAlbum(album.id).length,
    createName: owner ? `${owner.nickname}（${levelName(owner.level)}）` : `uid=${album.createUid}`,
    createLevel: owner?.level ?? 0,
  };
}

/**
 * 成员新建相册：档位不能超出自己的可见上限，L1 更不能对外发布。
 * 若 body 带 parentId，必须是 L4 超管且父相册存在（PRD 3.2 继承上限）。
 */
export function createAlbum(body: Record<string, unknown>, actor: Actor): AlbumRow {
  assertWritable(actor);
  if (actor.kind !== 'member') fail(403, 'TEMP_FORBIDDEN', '临时账号不能创建相册');

  const name = String(body.name ?? '').trim();
  if (!name) fail(400, 'VALIDATION_FAILED', '相册名称不能为空');
  const visibility = (str(body.visibility) ?? 'member') as AlbumView['visibility'];
  if (!visibleVisibilities(actor.level).includes(visibility)) {
    fail(403, 'LEVEL_FORBIDDEN', `当前等级不能创建 ${visibility} 档位的相册`);
  }
  if (!canSetPublic(actor, visibility)) {
    fail(403, 'SET_PUBLIC_FORBIDDEN', '对外发布需 L2 及以上，或由超管开「对外发布」能力位（PRD 6.1 / 6.4）');
  }

  // ---- 子相册分支 ----
  const parentIdRaw = body.parentId;
  const parentId = parentIdRaw === undefined || parentIdRaw === null || parentIdRaw === ''
    ? null
    : Number(parentIdRaw);

  if (parentId !== null) {
    // 仅超级管理员可创建子相册
    requireLevel(actor, UserLevel.SuperAdmin);
    const parent = ALBUMS.find((a) => a.id === parentId);
    if (!parent) fail(404, 'NOT_FOUND', '父相册不存在');
    // 子相册档位不得宽于父相册（PRD 3.2）
    const inheritance = checkInheritance(visibility, [parent.visibility]);
    if (!inheritance.allowed) {
      fail(inheritance.status, inheritance.reason, `子相册可见范围不得宽于父相册（父相册为 ${parent.visibility}）`);
    }
  }

  const stage = (str(body.stage) ?? 'post') as AlbumStage;

  const album = addAlbum({
    parentId,
    name,
    eventName: str(body.eventName) ?? name,
    eventDate: str(body.eventDate) ?? new Date().toISOString().slice(0, 10),
    location: str(body.location) ?? '',
    description: str(body.description) ?? '',
    visibility,
    stage,
    createUid: actor.uid,
  });
  return row(album);
}

/** 返回指定相册的子相册列表（含孙级） */
export function childAlbums(parentId: number, actor: Actor): AlbumRow[] {
  const parent = albumById(parentId);
  if (!parent) fail(404, 'NOT_FOUND', '相册不存在');
  const parentRef = albumRef(parent);
  const decision = decide(Action.Preview, actor, parentRef);
  if (!decision.allowed) fail(decision.status, decision.reason, decision.message);

  // 递归查找所有后代
  const descendants: AlbumView[] = [];
  const queue = [parentId];
  while (queue.length) {
    const current = queue.shift()!;
    const children = ALBUMS.filter((a) => a.parentId === current);
    for (const child of children) {
      descendants.push(child);
      queue.push(child.id);
    }
  }

  // 按 actor 的可见性裁剪
  return descendants
    .filter((a) => {
      const d = decide(Action.Preview, actor, albumRef(a));
      return d.allowed;
    })
    .map(row);
}

/** 改相册元数据；收紧档位时把子图一并收紧，避免出现「父私有子公开」的口子 */
export function updateAlbum(id: number, body: Record<string, unknown>, actor: Actor): AlbumRow {
  assertWritable(actor);
  const album = ALBUMS.find((a) => a.id === id);
  if (!album) fail(404, 'NOT_FOUND', '相册不存在或无权查看');
  const ref = albumRef(album);
  const decision = decide(Action.EditMeta, actor, ref);
  if (!decision.allowed) fail(decision.status, decision.reason, decision.message);
  if (album.status === AlbumStatus.Locked) fail(409, 'ALBUM_LOCKED', '相册已锁定，禁止上传与修改');

  const name = str(body.name)?.trim();
  if (name) album.name = name;
  for (const key of ['eventName', 'eventDate', 'location', 'description'] as const) {
    if (body[key] !== undefined) album[key] = String(body[key]);
  }
  if (body.coverImgId !== undefined) {
    const cover = body.coverImgId === null ? null : Number(body.coverImgId);
    if (cover !== null && !imagesOfAlbum(album.id).some((s) => s.id === cover)) {
      fail(400, 'COVER_NOT_IN_ALBUM', '封面必须是本相册内的图片');
    }
    album.coverImgId = cover;
  }

  const next = str(body.visibility) as AlbumView['visibility'] | undefined;
  if (next && next !== album.visibility) {
    const change = decide(Action.ChangeVisibility, actor, ref);
    if (!change.allowed) fail(change.status, change.reason, change.message);
    if (actor.kind === 'member' && !canSetPublic(actor, next)) {
      fail(403, 'SET_PUBLIC_FORBIDDEN', '对外发布需 L2 及以上，或由超管开「对外发布」能力位（PRD 6.1 / 6.4）');
    }
    album.visibility = next;
    // 级联收紧子图片（PRD 3.2）
    for (const seed of imagesOfAlbum(album.id)) {
      if (VISIBILITY_RANK[seed.visibility] < VISIBILITY_RANK[next]) seed.visibility = next;
    }
    // 级联收紧子相册（PRD 3.2）
    const queue = [album.id];
    while (queue.length) {
      const current = queue.shift()!;
      const children = ALBUMS.filter((a) => a.parentId === current);
      for (const child of children) {
        if (VISIBILITY_RANK[child.visibility] < VISIBILITY_RANK[next]) {
          child.visibility = next;
          // 子相册收紧时也要收紧它的图片
          for (const img of imagesOfAlbum(child.id)) {
            if (VISIBILITY_RANK[img.visibility] < VISIBILITY_RANK[next]) img.visibility = next;
          }
        }
        queue.push(child.id);
      }
    }
  }

  if (body.stage !== undefined) {
    const nextStage = str(body.stage) as AlbumStage;
    if (nextStage === 'pre' || nextStage === 'post') album.stage = nextStage;
  }
  return row(album);
}

export function deleteAlbum(id: number, actor: Actor): { id: number; removedImages: number } {
  assertWritable(actor);
  const album = ALBUMS.find((a) => a.id === id);
  if (!album) fail(404, 'NOT_FOUND', '相册不存在或无权查看');
  const decision = decide(Action.Delete, actor, albumRef(album));
  if (!decision.allowed) fail(decision.status, decision.reason, decision.message);
  const removed = removeAlbum(id);
  return { id, removedImages: removed.length };
}

/** 归档 / 锁定 / 解锁属于交付流程控制，只给 L3+（PRD 6.1） */
export function setAlbumStatus(id: number, body: Record<string, unknown>, actor: Actor): AlbumRow {
  requireLevel(actor, 3);
  const album = ALBUMS.find((a) => a.id === id);
  if (!album) fail(404, 'NOT_FOUND', '相册不存在或无权查看');
  const status = Number(body.status) as AlbumStatus;
  if (![AlbumStatus.Normal, AlbumStatus.Archived, AlbumStatus.Locked].includes(status)) {
    fail(400, 'VALIDATION_FAILED', 'status 只能是 1 正常 / 2 已归档 / 3 已锁定');
  }
  const patched = patchAlbum(id, { status });
  return row(patched as AlbumView);
}

/** 前台列表：按身份裁剪档位与归档，和 handler 的 albumList 同一入口 */
export function albumRows(query: Record<string, unknown> | undefined, actor: Actor): Page<AlbumRow> {
  let rows = listableAlbums(actor).map(row);
  const stage = str(query?.stage);
  if (stage === 'pre' || stage === 'post') rows = rows.filter((a) => a.stage === stage);
  const page = int(query?.page, 1);
  const pageSize = Math.min(100, int(query?.pageSize, 20));
  return paged(rows, page, pageSize);
}

/** 后台列表：L3+ 看全站，包含归档与锁定，并能按档位/状态/关键词筛 */
export function adminAlbumList(query: Record<string, unknown> | undefined, actor: Actor): Page<AlbumRow> {
  requireLevel(actor, 3);
  let list = ALBUMS.map(row);
  const visibility = str(query?.visibility);
  if (visibility) list = list.filter((a) => a.visibility === visibility);
  const status = Number(query?.status);
  if (status) list = list.filter((a) => a.status === status);
  const stage = str(query?.stage);
  if (stage === 'pre' || stage === 'post') list = list.filter((a) => a.stage === stage);
  const uid = Number(query?.createUid);
  if (uid) list = list.filter((a) => a.createUid === uid);
  const kw = str(query?.keyword)?.trim().toLowerCase();
  if (kw) {
    list = list.filter((a) =>
      [a.name, a.eventName, a.location].some((v) => v.toLowerCase().includes(kw)),
    );
  }
  const page = int(query?.page, 1);
  const pageSize = Math.min(100, int(query?.pageSize, 20));
  const sorted = [...list].sort((a, b) => b.id - a.id);
  return paged(sorted, page, pageSize);
}
