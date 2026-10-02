/**
 * mock 分发器：按后端真实响应契约造数据，并复用 policy.ts 的判定，
 * 让「关掉 mock 直接联调」时页面代码不需要任何分支。
 * 错误一律抛 ApiError(status, code)，code 取自后端 AppError 的同名常量。
 */
import type {
  AlbumCapsView,
  AlbumView,
  BatchResult,
  Identity,
  ImageZipResult,
  ImageView,
  LoginResult,
  Page,
  Profile,
  RejectedItem,
  TagView,
  Visibility,
} from '@/types/api';
import { LEVEL_LABEL } from '@/types/api';
import { ApiError } from '../error';
import type { RequestOptions } from '../types';
import {
  TAGS,
  TEMPS,
  USERS,
  addImage,
  albumById,
  imageById,
  imagesOfAlbum,
  quotaOwner,
  sortSeeds,
  tagById,
} from './db';
import { settingList, settingNumber } from './tables';
import {
  Action,
  ALL_VISIBILITIES,
  capabilitiesFor,
  canSetPublic,
  checkInheritance,
  decide,
  hidesStatusTags,
  overriddenCaps,
  visibleTagTypes,
  visibleVisibilities,
} from './policy';
import type { Actor, MemberActor, ResourceRef } from './policy';
import {
  API,
  albumCapsView,
  albumRef,
  assertWritable,
  csv,
  currentActor,
  fail,
  imageRef,
  int,
  isTrue,
  listableAlbums,
  lockedItem,
  matchTags,
  md5Of,
  paged,
  readableAlbum,
  readableImages,
  str,
  toView,
} from './shared';
import { adminAlbumList, childAlbums, createAlbum, deleteAlbum, setAlbumStatus, updateAlbum } from './album';
import {
  createPersonShareLink,
  createShareLink,
  listShareLinks,
  publicShare,
  revokeShareLink,
  shareImage,
  unlockShare,
} from './share';
import {
  batchZip,
  createFolder,
  deleteFile,
  deleteFolder,
  driveTree,
  listFiles,
  purgeFile,
  purgeFolder,
  restoreFile,
  restoreFolder,
  updateFolder,
  uploadFile,
  uploadTargets,
} from './drive';
import { siteInfo } from './site';
import { takePending } from './take';
import {
  createTag,
  createTemp,
  createUser,
  dashboard,
  deleteTemp,
  deleteUser,
  exportLogs,
  listLogs,
  listSettings,
  listTags,
  listTemps,
  listUsers,
  mergeTags,
  removeTag,
  renameTagRoute,
  resetPassword,
  updateAlbumCaps,
  updateSettings,
  updateTemp,
  updateTempCredentials,
  updateUser,
  updateUserDriveGrants,
  updateUserFeatureGrants,
} from './admin';
import { listTasks, peekAccountCode, registerTemp, setTaskStage } from './temps';
import {
  vaultCipher,
  vaultDelete,
  vaultDestroy,
  vaultList,
  vaultRekey,
  vaultSetup,
  vaultSpaces,
  vaultStatus,
  vaultUpload,
} from './vault';

/** 单次批量打包上限（PRD 4.5）：超过就直接拒，而不是悄悄截断 */
const MAX_ZIP_ITEMS = 500;

// ---------------- 认证 ----------------

function login(body: Record<string, unknown>): LoginResult {
  const username = String(body.username ?? '').trim();
  const password = String(body.password ?? '');
  const user = USERS.find((u) => u.username === username);
  // 账号不存在与口令错误同一文案，避免账号枚举
  if (!user || password !== 'demo1234') {
    fail(401, 'BAD_CREDENTIALS', '账号或密码错误');
  }
  const identity: Identity = {
    kind: 'user',
    uid: user.uid,
    username: user.username,
    nickname: user.nickname,
    level: user.level,
  };
  return { accessToken: `mock.user.${user.uid}`, identity };
}

function tempToken(body: Record<string, unknown>): LoginResult {
  const code = String(body.accessToken ?? '').trim().toUpperCase();
  const temp = TEMPS.find((t) => t.code === code);
  // 账号不存在与口令错误回同一句话，免得被拿来枚举帐户ID
  if (!temp || String(body.password ?? '') !== temp.password) {
    fail(401, 'BAD_CREDENTIALS', '帐户ID或密码错误');
  }
  // 第二道闸门：到期即失效，不再签发令牌（PRD 12.6）
  if (Date.parse(temp.expiresAt) <= Date.now()) {
    fail(401, 'TEMP_EXPIRED', '该帐户ID已到期，请联系派发人重新开具');
  }
  return {
    accessToken: `mock.temp.${temp.tempId}`,
    identity: {
      kind: 'temp',
      tempId: temp.tempId,
      displayName: temp.displayName,
      expiresAt: temp.expiresAt,
    },
  };
}

function me(actor: Actor): Profile {
  const serverTime = new Date().toISOString();
  if (actor.kind === 'member') {
    const user = USERS.find((u) => u.uid === actor.uid);
    if (!user) fail(401, 'ACCOUNT_DISABLED', '账号不存在或已被禁用');
    return {
      kind: 'user',
      uid: user.uid,
      username: user.username,
      nickname: user.nickname,
      position: user.position,
      level: user.level,
      levelName: LEVEL_LABEL[user.level] ?? `L${user.level}`,
      spaceQuota: user.spaceQuota,
      usedSpace: user.usedSpace,
      capabilities: actor.caps,
      capsOverridden: overriddenCaps(user.level, user.featureGrant),
      serverTime,
    };
  }
  if (actor.kind === 'temp') {
    const temp = TEMPS.find((t) => t.tempId === actor.tempId);
    if (!temp) fail(401, 'TEMP_NOT_FOUND', '临时账号不存在');
    return {
      kind: 'temp',
      tempId: temp.tempId,
      accountId: temp.code,
      displayName: temp.displayName,
      expiresAt: temp.expiresAt,
      ownerUid: temp.ownerUid,
      flags: temp.flags,
      allowedAlbumIds: temp.albumIds,
      allowedFolderIds: temp.folderIds,
      spaceQuota: temp.spaceQuota,
      usedSpace: temp.usedSpace,
      serverTime,
    };
  }
  return fail(401, 'LOGIN_REQUIRED', '需登录后访问');
}

/**
 * D15 临时账号自助销毁：后 6 位由服务端复校（15 章 case 29），删行即失效——之后的
 * /auth/me 与任何鉴权请求都会 401，已上传作品按 6.2 保留（upload_temp_id 不清洗）。
 */
function tempDestroy(actor: Actor, body: Record<string, unknown>): { destroyed: boolean } {
  if (actor.kind !== 'temp') fail(403, 'LEVEL_FORBIDDEN', '仅临时账号可自助销毁');
  const temp = TEMPS.find((t) => t.tempId === actor.tempId);
  if (!temp) fail(401, 'TEMP_NOT_FOUND', '临时账号不存在');
  if (String(body.accountTail ?? '').trim() !== temp.code.slice(-6)) {
    fail(400, 'CONFIRM_REQUIRED', '帐户ID 后 6 位不正确');
  }
  TEMPS.splice(TEMPS.indexOf(temp), 1);
  return { destroyed: true };
}

// ---------------- 相册与图片 ----------------

function albumList(query: RequestOptions['query'], actor: Actor): Page<AlbumView & AlbumCapsView> {
  const page = int(query?.page, 1);
  const pageSize = Math.min(int(query?.pageSize, 20), 100);
  let rows = listableAlbums(actor);
  if (!isTrue(query?.includeArchived)) {
    rows = rows.filter((a) => a.status !== 2);
  }
  const status = Number(query?.status);
  if (status) rows = rows.filter((a) => a.status === status);
  const stage = str(query?.stage);
  if (stage === 'pre' || stage === 'post') rows = rows.filter((a) => a.stage === stage);
  const kw = str(query?.keyword)?.trim();
  if (kw) {
    const lower = kw.toLowerCase();
    rows = rows.filter((a) => a.name.toLowerCase().includes(lower) || a.eventName.toLowerCase().includes(lower));
  }
  rows = [...rows].sort(
    (a, b) => b.eventDate.localeCompare(a.eventDate) || b.id - a.id,
  );
  const out = paged(rows, page, pageSize);
  // D25：列表行也带有效关闭集，前端只读 capsOff 一处，不必自己走父链
  return { ...out, list: out.list.map((a) => ({ ...a, ...albumCapsView(a) })) };
}

/** 相册详情带封面计数，前端瀑布流头部要用 */
function albumDetail(albumId: number, actor: Actor): AlbumView & AlbumCapsView & { imagesCount: number } {
  const album = readableAlbum(albumId, actor);
  return {
    ...album,
    // D25：详情页按有效关闭集不渲染入口，闸门口径与接口判定同一份（PRD 6.5）
    ...albumCapsView(album),
    imagesCount: readableImages(imagesOfAlbum(album.id), actor).length,
  };
}

function imageList(albumId: number, query: RequestOptions['query'], actor: Actor): Page<ImageView> {
  const album = readableAlbum(albumId, actor);
  const statusIds = csv(query?.status);
  if (statusIds.length && hidesStatusTags(actor)) {
    fail(403, 'STATUS_FILTER_FORBIDDEN', '状态标签只对成员开放');
  }
  const page = int(query?.page, 1);
  const pageSize = Math.min(int(query?.pageSize, 20), 100);

  let seeds = readableImages(imagesOfAlbum(album.id), actor);
  const wanted = [...new Set([...csv(query?.tags), ...statusIds])];
  if (wanted.length) {
    for (const id of statusIds) {
      const tag = tagById(id);
      if (!tag) fail(400, 'TAG_NOT_FOUND', `标签不存在：${id}`);
      if (tag.type !== 'status') fail(400, 'STATUS_TYPE_MISMATCH', `status 只能传状态标签，${tag.name} 不是`);
    }
    seeds = matchTags(seeds, wanted);
  }
  return paged(
    sortSeeds(seeds).map((s) => toView(s, actor)),
    page,
    pageSize,
  );
}

function suggest(query: RequestOptions['query'], actor: Actor): TagView[] {
  if (actor.kind === 'guest') fail(401, 'LOGIN_REQUIRED', '需登录后使用标签补全');
  const type = str(query?.type);
  const kw = str(query?.q)?.trim().toLowerCase();
  const keep = visibleTagTypes(actor);
  return TAGS.filter((t) => keep.includes(t.type))
    .filter((t) => !type || t.type === type)
    .filter((t) => !kw || t.name.toLowerCase().includes(kw))
    .slice(0, 20);
}

function batchTags(body: Record<string, unknown>, actor: Actor): BatchResult {
  assertWritable(actor);
  const imageIds = csv(body.imageIds);
  const add = csv(body.add);
  const remove = csv(body.remove);
  if (!add.length && !remove.length) fail(400, 'NOTHING_TO_DO', 'add 与 remove 至少提供一个');
  if (!imageIds.length) fail(400, 'VALIDATION_FAILED', 'imageIds 不能为空');

  for (const id of [...add, ...remove]) {
    if (!tagById(id)) fail(400, 'TAG_NOT_FOUND', `标签不存在：${id}`);
  }
  if (hidesStatusTags(actor) && add.some((id) => tagById(id)?.type === 'status')) {
    fail(403, 'STATUS_TAG_FORBIDDEN', '状态标签只能由成员维护');
  }

  const rejected: RejectedItem[] = [];
  let updated = 0;
  for (const imageId of imageIds) {
    const seed = imageById(imageId);
    if (!seed) {
      rejected.push({ imageId, status: 404, code: 'NOT_FOUND', message: '图片不存在或无权查看' });
      continue;
    }
    const decision = decide(Action.EditTags, actor, imageRef(seed));
    if (!decision.allowed) {
      rejected.push({ imageId, status: decision.status, code: decision.reason, message: decision.message });
      continue;
    }
    if (albumById(seed.albumId)?.status === 3) {
      rejected.push(lockedItem(imageId));
      continue;
    }
    seed.tags = [...new Set([...seed.tags.filter((t) => !remove.includes(t)), ...add])];
    updated += 1;
  }
  return { requested: imageIds.length, updated, rejected };
}

function batchVisibility(body: Record<string, unknown>, actor: Actor): BatchResult {
  assertWritable(actor);
  const imageIds = csv(body.imageIds);
  const visibility = String(body.visibility ?? '') as Visibility;
  if (!imageIds.length) fail(400, 'VALIDATION_FAILED', 'imageIds 不能为空');
  if (!ALL_VISIBILITIES.includes(visibility)) fail(400, 'VALIDATION_FAILED', '可见范围取值不合法');

  const rejected: RejectedItem[] = [];
  let updated = 0;
  for (const imageId of imageIds) {
    const seed = imageById(imageId);
    if (!seed) {
      rejected.push({ imageId, status: 404, code: 'NOT_FOUND', message: '图片不存在或无权查看' });
      continue;
    }
    const ref = imageRef(seed);
    const decision = decide(Action.ChangeVisibility, actor, ref);
    if (!decision.allowed) {
      rejected.push({ imageId, status: decision.status, code: decision.reason, message: decision.message });
      continue;
    }
    if (actor.kind === 'member' && !canSetPublic(actor, visibility)) {
      rejected.push({
        imageId,
        status: 403,
        code: 'SET_PUBLIC_FORBIDDEN',
        message: '对外发布（设为公开）被能力位关闭，无法设为 public',
      });
      continue;
    }
    const album = albumById(seed.albumId);
    if (!album) {
      rejected.push({ imageId, status: 404, code: 'NOT_FOUND', message: '图片不存在或无权查看' });
      continue;
    }
    if (album.status === 3) {
      rejected.push(lockedItem(imageId));
      continue;
    }
    // 子资源档位不得宽于上级（PRD 3.2）
    const inheritance = checkInheritance(visibility, [album.visibility]);
    if (!inheritance.allowed) {
      rejected.push({ imageId, status: inheritance.status, code: inheritance.reason, message: inheritance.message });
      continue;
    }
    seed.visibility = visibility;
    updated += 1;
  }
  return { requested: imageIds.length, updated, rejected };
}

/** 批量打包下载：逐条复核权限，不因单张越权中断整批（PRD 4.5） */
function batchZipImages(body: Record<string, unknown>, actor: Actor): ImageZipResult {
  const imageIds = csv(body.imageIds);
  if (!imageIds.length) fail(400, 'VALIDATION_FAILED', 'imageIds 不能为空');
  if (imageIds.length > MAX_ZIP_ITEMS) fail(400, 'BATCH_TOO_LARGE', `单次最多打包 ${MAX_ZIP_ITEMS} 张`);

  const rejected: ImageZipResult['rejected'] = [];
  let accepted = 0;
  let estimatedSize = 0;
  for (const imageId of imageIds) {
    const seed = imageById(imageId);
    if (!seed) {
      rejected.push({ imageId, status: 404, code: 'NOT_FOUND', message: '图片不存在或无权查看' });
      continue;
    }
    const decision = decide(Action.ZipDownload, actor, imageRef(seed));
    if (!decision.allowed) {
      rejected.push({ imageId, status: decision.status, code: decision.reason, message: decision.message });
      continue;
    }
    accepted += 1;
    estimatedSize += toView(seed, actor).fileSize;
  }
  return {
    requested: imageIds.length,
    accepted,
    estimatedSize,
    zipUrl: accepted ? `${API}/images/batch-zip?job=demo` : '',
    rejected,
  };
}

function updateImage(id: number, body: Record<string, unknown>, actor: Actor): ImageView {
  assertWritable(actor);
  const seed = imageById(id);
  if (!seed) fail(404, 'NOT_FOUND', '图片不存在或无权查看');
  const ref = imageRef(seed);
  const decision = decide(Action.EditMeta, actor, ref);
  if (!decision.allowed) fail(decision.status, decision.reason, decision.message);
  const album = albumById(seed.albumId);
  if (album?.status === 3) fail(409, 'ALBUM_LOCKED', '相册已锁定，禁止上传与修改');

  const next = str(body.visibility) as Visibility | undefined;
  if (next && next !== seed.visibility) {
    const change = decide(Action.ChangeVisibility, actor, ref);
    if (!change.allowed) fail(change.status, change.reason, change.message);
    if (actor.kind === 'member' && !canSetPublic(actor, next)) {
      fail(403, 'SET_PUBLIC_FORBIDDEN', '对外发布（设为公开）被能力位关闭，无法设为 public');
    }
    if (album) {
      const inheritance = checkInheritance(next, [album.visibility]);
      if (!inheritance.allowed) fail(inheritance.status, inheritance.reason, inheritance.message);
    }
    seed.visibility = next;
  }
  if (body.shotTime !== undefined) {
    seed.shotTime = body.shotTime === null ? null : new Date(String(body.shotTime)).toISOString();
  }
  if (body.sort !== undefined) seed.sort = Number(body.sort);
  return toView(seed, actor);
}

/** 供筛选栏使用：成员才拿得到 status 分组（PRD 6.2） */
export function filterableTags(actor: Actor): TagView[] {
  const keep = visibleTagTypes(actor);
  return TAGS.filter((t) => keep.includes(t.type));
}

// ---------------- 上传（演示用，字节不真的落盘） ----------------

const MIN_CHUNK = 256 * 1024;
const MAX_CHUNK = 16 * 1024 * 1024;
const MAX_CHUNKS = 300;

interface MockSession {
  uploadId: string;
  albumId: number;
  /** 本批图片的归属临时账号 ID（拍展传图必填；成员替 temp 代传时记录 tempId 而非 member 自己） */
  tempId: number;
  filename: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
  uploaded: number[];
}

const SESSIONS = new Map<string, MockSession>();

/** 片长夹在 256KB~16MB，片数超预算时自动放大片长而不是拒收大文件 */
function chunkPlan(fileSize: number, declared: number): { chunkSize: number; totalChunks: number } {
  const needed = Math.ceil(fileSize / MAX_CHUNKS);
  const chunkSize = Math.min(MAX_CHUNK, Math.max(MIN_CHUNK, Math.trunc(declared) || MIN_CHUNK, needed));
  return { chunkSize, totalChunks: Math.ceil(fileSize / chunkSize) };
}

/**
 * 建会话时按站点设置挡一遍，顺序与后端 openSession 一致：黑名单 → 图片白名单 → 单张上限 → 配额。
 * 真接口还在合并完按魔数复核，扩展名与 Content-Type 都不作数；mock 不落字节，只能到扩展名这一层。
 */
function assertUploadPolicy(filename: string, size: number, actor: Actor): void {
  const ext = `.${filename.split('.').pop()?.toLowerCase() ?? ''}`;
  if (settingList('upload.blocked_extensions').includes(ext)) {
    fail(400, 'BLOCKED_EXTENSION', `禁止上传 ${ext} 类型文件`);
  }
  if (!settingList('upload.image_extensions').includes(ext)) {
    fail(400, 'EXTENSION_NOT_ALLOWED', `扩展名 ${ext} 不在图片白名单内（服务端还会按魔数复核）`);
  }

  const max = settingNumber('upload.max_image_size');
  if (max > 0 && size > max) {
    fail(413, 'FILE_TOO_BIG', `单张图片最大 ${max} 字节，当前声明 ${size} 字节`, { max, size });
  }

  const owner = quotaOwner(actor);
  if (owner && owner.quota > 0 && owner.used + size > owner.quota) {
    fail(413, 'QUOTA_EXCEEDED', `空间不足，已用 ${owner.used} / 配额 ${owner.quota}`, {
      used: owner.used,
      quota: owner.quota,
      need: size,
    });
  }
}

function sessionView(session: MockSession): Record<string, unknown> {
  const missing = Array.from({ length: session.totalChunks }, (_, i) => i).filter(
    (i) => !session.uploaded.includes(i),
  );
  return {
    uploadId: session.uploadId,
    albumId: session.albumId,
    filename: session.filename,
    size: session.size,
    chunkSize: session.chunkSize,
    totalChunks: session.totalChunks,
    uploaded: [...session.uploaded].sort((a, b) => a - b),
    missing,
    expireTime: new Date(Date.now() + 24 * 3600_000).toISOString(),
  };
}

function uploadAlbum(albumId: number, actor: Actor): AlbumView {
  assertWritable(actor);
  const album = albumById(albumId);
  if (!album) fail(404, 'NOT_FOUND', '相册不存在或无权查看');
  // 成员读 caps.upload，临时账号读「传图」开关＋白名单＋档位，都在 decide() 里判
  const decision = decide(Action.Upload, actor, albumRef(album));
  if (!decision.allowed) fail(decision.status, decision.reason, decision.message);
  if (album.status === 3) fail(409, 'ALBUM_LOCKED', '相册已锁定，禁止上传与修改');
  return album;
}

function ownedSession(uploadId: string, actor: Actor): MockSession {
  assertWritable(actor);
  const session = SESSIONS.get(uploadId);
  // 别人的会话与不存在的会话同一口径，避免枚举 uploadId
  if (!session) fail(404, 'NOT_FOUND', '上传会话不存在或不属于当前账号');
  return session;
}

function createSession(body: Record<string, unknown>, actor: Actor): Record<string, unknown> {
  const albumId = Number(body.albumId);
  const album = uploadAlbum(albumId, actor);
  const filename = String(body.filename ?? '').trim();
  const size = Number(body.fileSize);
  if (!filename) fail(400, 'VALIDATION_FAILED', 'filename 不能为空');
  if (!Number.isInteger(size) || size < 1) fail(400, 'VALIDATION_FAILED', 'fileSize 必须是整数');

  // 归属工单：临时账号本人传图就是交付给自己；成员代传必须点名交付给谁
  const rawTempId = Number(body.tempId);
  let ownerTempId: number;
  if (actor.kind === 'temp') {
    // 客户端带的 tempId 只作复核，不许把自己的返图挂到别人的工单上
    if (Number.isInteger(rawTempId) && rawTempId !== actor.tempId) {
      fail(403, 'TEMP_NOT_SELF', '临时账号只能把返图交付给自己');
    }
    ownerTempId = actor.tempId;
  } else {
    if (!Number.isInteger(rawTempId) || rawTempId <= 0) {
      fail(400, 'VALIDATION_FAILED', '拍展传图必须指定要交付给哪个临时账号');
    }
    const temp = TEMPS.find((t) => t.tempId === rawTempId);
    if (!temp) fail(404, 'TEMP_NOT_FOUND', '指定的临时账号不存在');
    if (!temp.flags.uploadImg) fail(403, 'TEMP_SWITCH_OFF', '该临时账号未开通「传图」开关');
    if (!temp.albumIds.includes(album.id)) {
      fail(403, 'NOT_IN_WHITELIST', `相册「${album.name}」不在临时账号 ${temp.code} 的授权范围内`);
    }
    ownerTempId = temp.tempId;
  }

  assertUploadPolicy(filename, size, actor);
  const { chunkSize, totalChunks } = chunkPlan(size, settingNumber('upload.chunk_size'));
  const uploadId = `mock-${Date.now().toString(36)}-${SESSIONS.size + 1}`;
  const session: MockSession = { uploadId, albumId: album.id, tempId: ownerTempId, filename, size, chunkSize, totalChunks, uploaded: [] };
  SESSIONS.set(uploadId, session);
  return sessionView(session);
}

function putChunk(uploadId: string, index: number, actor: Actor): Record<string, unknown> {
  const session = ownedSession(uploadId, actor);
  if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) {
    fail(400, 'CHUNK_INDEX_INVALID', `分片下标应在 0~${session.totalChunks - 1} 之间`);
  }
  if (!session.uploaded.includes(index)) session.uploaded.push(index);
  const missing = Array.from({ length: session.totalChunks }, (_, i) => i).filter((i) => !session.uploaded.includes(i));
  return { uploaded: session.totalChunks - missing.length, total: session.totalChunks, missing };
}

function completeUpload(uploadId: string, actor: Actor): ImageView {
  const session = ownedSession(uploadId, actor);
  const missing = Array.from({ length: session.totalChunks }, (_, i) => i).filter((i) => !session.uploaded.includes(i));
  if (missing.length) {
    fail(409, 'MISSING_CHUNKS', `还差 ${missing.length} 个分片未上传`, { missing: missing.slice(0, 100) });
  }
  const uid = actor.kind === 'member' ? actor.uid : actor.kind === 'temp' ? actor.ownerUid : 0;
  // 图片总是归属到拍展指定的那个临时账号——不管上传者是成员还是该 temp 本人
  const tempId = session.tempId || null;
  const seed = addImage(session.albumId, session.filename, session.size, uid, tempId);
  quotaOwner(actor)?.add(session.size);
  SESSIONS.delete(uploadId);
  return toView(seed, actor);
}

// ---------------- 分发 ----------------

export async function handleMock(method: string, path: string, opts: RequestOptions = {}): Promise<unknown> {
  const actor = currentActor();
  const body = (opts.body ?? {}) as Record<string, unknown>;
  const query = opts.query;

  if (method === 'POST' && path === '/auth/login') return login(body);
  if (method === 'POST' && path === '/auth/temp-token') return tempToken(body);
  if (method === 'GET' && path === '/auth/me') return me(actor);
  if (method === 'POST' && path === '/auth/temp-destroy') return tempDestroy(actor, body);
  if (method === 'POST' && path === '/auth/logout') return { loggedOut: true };
  if (method === 'PUT' && path === '/auth/password') {
    if (actor.kind === 'guest' || actor.kind === 'share') fail(401, 'LOGIN_REQUIRED', '需登录后操作');
    return null;
  }

  if (method === 'GET' && path === '/albums') return albumList(query, actor);
  if (method === 'POST' && path === '/albums') return createAlbum(body, actor);
  const shareCreate = /^\/albums\/(\d+)\/share-links$/.exec(path);
  if (shareCreate && method === 'POST') return createShareLink(Number(shareCreate[1]), body, actor);
  const statusMatch = /^\/albums\/(\d+)\/status$/.exec(path);
  if (statusMatch && method === 'PATCH') return setAlbumStatus(Number(statusMatch[1]), body, actor);
  const albumMatch = /^\/albums\/(\d+)$/.exec(path);
  if (albumMatch) {
    const id = Number(albumMatch[1]);
    if (method === 'GET') return albumDetail(id, actor);
    if (method === 'PATCH') return updateAlbum(id, body, actor);
    if (method === 'DELETE') return deleteAlbum(id, actor);
  }
  // 子相册列表：GET /albums/:id/children
  const childrenMatch = /^\/albums\/(\d+)\/children$/.exec(path);
  if (childrenMatch && method === 'GET') return childAlbums(Number(childrenMatch[1]), actor);
  const imagesMatch = /^\/albums\/(\d+)\/images$/.exec(path);
  if (imagesMatch && method === 'GET') return imageList(Number(imagesMatch[1]), query, actor);

  if (path === '/tags/suggest' && method === 'GET') return suggest(query, actor);
  if (path === '/tags' && method === 'GET') return filterableTags(actor);

  if (path === '/images/batch-tags' && method === 'POST') return batchTags(body, actor);
  if (path === '/images/batch-visibility' && method === 'PATCH') return batchVisibility(body, actor);
  if (path === '/images/batch-zip' && method === 'POST') return batchZipImages(body, actor);
  const updateMatch = /^\/images\/(\d+)$/.exec(path);
  if (updateMatch && method === 'PATCH') return updateImage(Number(updateMatch[1]), body, actor);

  if (path === '/uploads' && method === 'POST') return createSession(body, actor);
  const completeMatch = /^\/uploads\/([^/]+)\/complete$/.exec(path);
  if (completeMatch && method === 'POST') return completeUpload(completeMatch[1], actor);
  const chunkMatch = /^\/uploads\/([^/]+)\/chunk\/(\d+)$/.exec(path);
  if (chunkMatch && method === 'PUT') return putChunk(chunkMatch[1], Number(chunkMatch[2]), actor);
  const sessionMatch = /^\/uploads\/([^/]+)$/.exec(path);
  if (sessionMatch && method === 'GET') return sessionView(ownedSession(sessionMatch[1], actor));
  if (sessionMatch && method === 'DELETE') {
    ownedSession(sessionMatch[1], actor);
    SESSIONS.delete(sessionMatch[1]);
    return { uploadId: sessionMatch[1] };
  }

  // ---------------- 返图链接（管理侧，PRD 10.3） ----------------

  if (method === 'GET' && path === '/share-links') return listShareLinks(query, actor);
  if (method === 'POST' && path === '/share-links/personal') return createPersonShareLink(body, actor);
  const shareRevoke = /^\/share-links\/(\d+)$/.exec(path);
  if (shareRevoke && method === 'DELETE') return revokeShareLink(Number(shareRevoke[1]), actor);

  // ---------------- 取图（PRD 18 章，只对临时账号开放） ----------------

  if (method === 'GET' && path === '/take/pending') return takePending(actor);

  // ---------------- 公开通道（游客 / 分享访客，PRD 10.6） ----------------

  if (method === 'GET' && path === '/public/site-info') return siteInfo();
  const unlockMatch = /^\/public\/share\/([^/]+)\/unlock$/.exec(path);
  if (unlockMatch && method === 'POST') return unlockShare(decodeURIComponent(unlockMatch[1]), body);
  const byteMatch = /^\/public\/share\/([^/]+)\/images\/(\d+)\/(preview|original)$/.exec(path);
  if (byteMatch && method === 'GET') {
    return shareImage(decodeURIComponent(byteMatch[1]), Number(byteMatch[2]), byteMatch[3] as 'preview' | 'original');
  }
  const shareMatch = /^\/public\/share\/([^/]+)$/.exec(path);
  if (shareMatch && method === 'GET') return publicShare(decodeURIComponent(shareMatch[1]));

  // ---------------- 网盘（PRD 10.4） ----------------

  if (method === 'GET' && path === '/drive/tree') return driveTree(actor);
  if (method === 'GET' && path === '/drive/upload-targets') return uploadTargets(actor);
  if (method === 'GET' && path === '/drive/files') return listFiles(query, actor);
  if (method === 'POST' && path === '/drive/files') return uploadFile(body, actor);
  if (method === 'POST' && path === '/drive/files/batch-zip') return batchZip(body, actor);
  if (method === 'POST' && path === '/drive/folders') return createFolder(body, actor);
  const filePurge = /^\/drive\/files\/(\d+)\/purge$/.exec(path);
  if (filePurge && method === 'DELETE') return purgeFile(Number(filePurge[1]), actor);
  const fileRestore = /^\/drive\/files\/(\d+)\/restore$/.exec(path);
  if (fileRestore && method === 'POST') return restoreFile(Number(fileRestore[1]), actor);
  const fileDelete = /^\/drive\/files\/(\d+)$/.exec(path);
  if (fileDelete && method === 'DELETE') return deleteFile(Number(fileDelete[1]), actor);
  const folderPurge = /^\/drive\/folders\/(\d+)\/purge$/.exec(path);
  if (folderPurge && method === 'DELETE') return purgeFolder(Number(folderPurge[1]), actor);
  const folderRestore = /^\/drive\/folders\/(\d+)\/restore$/.exec(path);
  if (folderRestore && method === 'POST') return restoreFolder(Number(folderRestore[1]), actor);
  const folderMatch = /^\/drive\/folders\/(\d+)$/.exec(path);
  if (folderMatch && method === 'PATCH') return updateFolder(Number(folderMatch[1]), body, actor);
  if (folderMatch && method === 'DELETE') return deleteFolder(Number(folderMatch[1]), actor);

  // ---------------- 加密空间（PRD 5.7 / D26，密文以 base64 走同一份 JSON 契约） ----------------

  if (method === 'GET' && path === '/vault/status') return vaultStatus(query, actor);
  if (method === 'GET' && path === '/vault/files') return vaultList(query, actor);
  if (method === 'GET' && path === '/vault/spaces') return vaultSpaces(actor);
  if (method === 'POST' && path === '/vault/setup') return vaultSetup(body, actor);
  if (method === 'POST' && path === '/vault/rekey') return vaultRekey(body, actor);
  if (method === 'POST' && path === '/vault/files') return vaultUpload(body, actor);
  if (method === 'POST' && path === '/vault/destroy') return vaultDestroy(actor);
  const vaultCipherMatch = /^\/vault\/files\/(\d+)\/cipher$/.exec(path);
  if (vaultCipherMatch && method === 'GET') return vaultCipher(Number(vaultCipherMatch[1]), actor);
  const vaultDeleteMatch = /^\/vault\/files\/(\d+)$/.exec(path);
  if (vaultDeleteMatch && method === 'DELETE') return vaultDelete(Number(vaultDeleteMatch[1]), actor);

  // ---------------- 临时账号任务流（手绘稿 20 / 22 / 23） ----------------

  if (method === 'GET' && path === '/temp-tasks/next-code') return peekAccountCode(actor);
  if (method === 'POST' && path === '/temp-tasks/register') return registerTemp(body, actor);
  if (method === 'GET' && path === '/temp-tasks') return listTasks(query, actor);
  const stageMatch = /^\/temp-tasks\/(\d+)\/stage$/.exec(path);
  if (stageMatch && method === 'PATCH') return setTaskStage(Number(stageMatch[1]), body, actor);
  // 注销与后台走同一个处理函数：都是摘账号行 + 留一份 temp_destroy 日志
  const taskDestroy = /^\/temp-tasks\/(\d+)$/.exec(path);
  if (taskDestroy && method === 'DELETE') return deleteTemp(Number(taskDestroy[1]), actor);

  // ---------------- 后台（PRD 10.5，权限在各自模块里收口） ----------------

  if (method === 'GET' && path === '/admin/dashboard') return dashboard(actor);
  if (method === 'GET' && path === '/admin/albums') return adminAlbumList(query, actor);
  // D25：超管逐册关掉功能开关，入参是整份替换的关闭集，所以走 PUT（PRD 6.5 / 10.5）
  const albumCapsMatch = /^\/admin\/albums\/(\d+)\/caps$/.exec(path);
  if (albumCapsMatch && method === 'PUT') return updateAlbumCaps(Number(albumCapsMatch[1]), body, actor);
  if (method === 'GET' && path === '/admin/users') return listUsers(query, actor);
  if (method === 'POST' && path === '/admin/users') return createUser(body, actor);
  const pwdMatch = /^\/admin\/users\/(\d+)\/password$/.exec(path);
  if (pwdMatch && method === 'PUT') return resetPassword(Number(pwdMatch[1]), body, actor);
  // 规则 13：文件权限1~4 的个人授权，整份替换所以走 PUT
  const grantMatch = /^\/admin\/users\/(\d+)\/drive-grants$/.exec(path);
  if (grantMatch && method === 'PUT') return updateUserDriveGrants(Number(grantMatch[1]), body, actor);
  // D21：超管逐项给某个人覆盖功能能力位，整份替换所以走 PUT（PRD 6.4 / 10.5）
  const featMatch = /^\/admin\/users\/(\d+)\/feature-grants$/.exec(path);
  if (featMatch && method === 'PUT') return updateUserFeatureGrants(Number(featMatch[1]), body, actor);
  const userMatch = /^\/admin\/users\/(\d+)$/.exec(path);
  if (userMatch && method === 'PATCH') return updateUser(Number(userMatch[1]), body, actor);
  if (userMatch && method === 'DELETE') return deleteUser(Number(userMatch[1]), actor);
  if (method === 'GET' && path === '/admin/temp-accounts') return listTemps(query, actor);
  if (method === 'POST' && path === '/admin/temp-accounts') return createTemp(body, actor);
  // D22：超管改临时账号的帐户ID / 登录口令，两项都可单独改，走 PUT 而不是并进 PATCH
  const tempCred = /^\/admin\/temp-accounts\/(\d+)\/credentials$/.exec(path);
  if (tempCred && method === 'PUT') return updateTempCredentials(Number(tempCred[1]), body, actor);
  const tempMatch = /^\/admin\/temp-accounts\/(\d+)$/.exec(path);
  if (tempMatch && method === 'PATCH') return updateTemp(Number(tempMatch[1]), body, actor);
  if (tempMatch && method === 'DELETE') return deleteTemp(Number(tempMatch[1]), actor);
  if (method === 'GET' && path === '/admin/tags') return listTags(query, actor);
  if (method === 'POST' && path === '/admin/tags') return createTag(body, actor);
  const mergeMatch = /^\/admin\/tags\/(\d+)\/merge$/.exec(path);
  if (mergeMatch && method === 'POST') return mergeTags(Number(mergeMatch[1]), body, actor);
  const tagMatch = /^\/admin\/tags\/(\d+)$/.exec(path);
  if (tagMatch && method === 'PATCH') return renameTagRoute(Number(tagMatch[1]), body, actor);
  if (tagMatch && method === 'DELETE') return removeTag(Number(tagMatch[1]), actor);
  if (method === 'GET' && path === '/admin/logs/export') return exportLogs(query, actor);
  if (method === 'GET' && path === '/admin/logs') return listLogs(query, actor);
  if (method === 'GET' && path === '/admin/settings') return listSettings(actor);
  if (method === 'PUT' && path === '/admin/settings') return updateSettings(body, actor);

  return fail(404, 'NOT_FOUND', `mock 未实现 ${method} ${path}`);
}
