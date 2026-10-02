/**
 * 网盘的 mock：目录用途（kind）＋「文件权限1~4」决定读／下／传／改／删，判定全在 policy.folderGatePerms，
 * 这里只负责把它接到数据表上。删除按规则 7 先落垃圾箱，超管在私人目录里才是就地彻底删除（规则 8），
 * 垃圾箱本身只有超管能读改（规则 12）；拍展整棵子树不进列表（规则 3）；上传目的地只列有上传权的目录（规则 10）。
 * 同级重名、深度上限、移动防环沿用 PRD 5.3。字节仍不落盘（本机没有后端与磁盘），只维护元数据与鉴权链接。
 * 规则 13：四档门槛之外，超管可以给单个人开某一档，这里的判定与共享／私人目录的补建都认那份个人授权。
 */
import type { BatchZipResult, FileView, FolderNode, FolderOwner, FolderPerms, Page, UploadTarget } from '@/types/api';
import { UserLevel } from '@/types/api';
import type { Actor, DriveGates } from './policy';
import { FolderKind, driveGateOpen, folderGatePerms, hiddenFolderKind } from './policy';
import { API, fail, int, md5Of, str } from './shared';
import {
  FILES,
  FOLDERS,
  TRASH_FOLDER_ID,
  fileById,
  folderById,
  folderChain,
  nextFileId,
  nextFolderId,
  settingList,
  settingNumber,
} from './tables';
import type { MockFile, MockFolder } from './tables';
import { USERS, driveGrantOf, levelName, quotaOwner, releaseFileQuota } from './db';

const MAX_DEPTH = 8;
const MAX_ZIP_ITEMS = 500;

const NO_PERMS: FolderPerms = {
  read: false,
  download: false,
  upload: false,
  modify: false,
  remove: false,
  purge: false,
};

/** 游客、分享访客、临时账号一律进不了网盘（PRD 5.4），临时账号的定向交付改走任务入口 */
type DriveActor = Extract<Actor, { kind: 'member' }>;

function assertDriveActor(actor: Actor): asserts actor is DriveActor {
  if (actor.kind === 'guest') fail(401, 'LOGIN_REQUIRED', '网盘需要登录');
  if (actor.kind === 'share') fail(403, 'SHARE_READONLY', '分享链接不含网盘入口');
  if (actor.kind === 'temp') fail(403, 'TEMP_FORBIDDEN', '临时账号无权访问网盘');
}

/** 四档文件权限的等级门槛，后台「站点设置 → 网盘权限」改完立即生效；只放开某一个人走成员管理的个人授权（规则 13） */
function driveGates(): DriveGates {
  return {
    perm1: settingNumber('drive.perm1_workspace'),
    perm2: settingNumber('drive.perm2_manage'),
    perm3: settingNumber('drive.perm3_shared'),
    perm4: settingNumber('drive.perm4_personal'),
  };
}

/** 临时账号的授权级联包含子孙（PRD 5.5）：祖先里命中白名单即可 */
function tempFolderOk(actor: Extract<Actor, { kind: 'temp' }>, folder: MockFolder): boolean {
  return folderChain(folder.id).some((f) => actor.folderIds.includes(f.id));
}

function permsOf(actor: Actor, folder: MockFolder): FolderPerms {
  return folderGatePerms(
    actor,
    { id: folder.id, kind: folder.kind, ownerUid: folder.ownerUid },
    {
      gates: driveGates(),
      // 规则 13：超管单独开给这个人的档，判定里和等级门槛取并集
      grants: actor.kind === 'member' ? driveGrantOf(actor.uid) : undefined,
      tempWhitelisted: actor.kind === 'temp' ? tempFolderOk(actor, folder) : undefined,
    },
  );
}

/** 规则 3：拍展整棵子树不进目录列表，只靠账户 ID 定向访问 */
function inHiddenSubtree(folder: MockFolder): boolean {
  return folderChain(folder.id).some((f) => hiddenFolderKind(f.kind));
}

function listedFolder(actor: Actor, folder: MockFolder): boolean {
  return !inHiddenSubtree(folder) && permsOf(actor, folder).read;
}

/** 规则 1/5/6：共享与私人目录是「自动拥有」的，够门槛就补建，不能只靠种子数据（超管授权时也直接调它） */
export function ensureProvisioned(actor: Actor): void {
  if (actor.kind !== 'member') return;
  const user = USERS.find((u) => u.uid === actor.uid);
  if (!user) return;
  const gates = driveGates();
  const push = (name: string, kind: FolderKind, visibility: MockFolder['visibility'], description: string): void => {
    const exists = FOLDERS.some((f) => f.kind === kind && f.ownerUid === user.uid && f.parentId === null);
    if (exists) return;
    const id = nextFolderId();
    FOLDERS.push({
      id,
      parentId: null,
      path: `/${id}/`,
      depth: 1,
      name,
      description,
      kind,
      ownerUid: user.uid,
      visibility,
      createUid: user.uid,
      createTime: new Date().toISOString(),
      updateTime: new Date().toISOString(),
      deletedFromId: null,
      deletedAt: null,
    });
  };
  if (driveGateOpen(user.level, gates.perm3, user.driveGrant?.perm3)) {
    push(user.nickname, FolderKind.Shared, 'member', '个人共享文件夹');
  }
  if (driveGateOpen(user.level, gates.perm4, user.driveGrant?.perm4)) {
    push(`${user.nickname}的私人文件夹`, FolderKind.Personal, 'private', '');
  }
}

/** 目录写操作要求上级可改；垃圾箱里只允许清除与还原，不再建新目录 */
function assertWritableParent(actor: Actor, parent: MockFolder): void {
  if (parent.kind === FolderKind.Trash) fail(403, 'TRASH_NO_WRITE', '垃圾箱里不能创建目录');
  if (!permsOf(actor, parent).modify) {
    fail(403, 'FOLDER_READONLY', '对该目录没有改动权（规则 9：他人共享文件夹只读只下载）');
  }
}

function siblingNameTaken(parentId: number | null, name: string, exceptId = 0): boolean {
  // 顶级目录 parent_id 为 NULL，MySQL 的 UNIQUE 放行重复，这里按 PRD 在应用层补校验
  return FOLDERS.some((f) => f.parentId === parentId && f.name === name && f.id !== exceptId);
}

function directFiles(folderId: number): MockFile[] {
  return FILES.filter((f) => f.folderId === folderId);
}

function ownerOf(folder: MockFolder): FolderOwner | null {
  if (folder.ownerUid === null) return null;
  const user = USERS.find((u) => u.uid === folder.ownerUid);
  if (!user) return null;
  // 规则 1：共享文件夹名称下面并排显示职务标签与等级标签
  return { uid: user.uid, nickname: user.nickname, position: user.position, levelName: levelName(user.level) };
}

function folderNode(actor: Actor, folder: MockFolder): FolderNode {
  const perms = permsOf(actor, folder);
  return {
    id: folder.id,
    parentId: folder.parentId,
    name: folder.name,
    description: folder.description,
    depth: folder.depth,
    path: folder.path,
    kind: folder.kind,
    visibility: folder.visibility,
    ownerUid: folder.ownerUid,
    owner: ownerOf(folder),
    perms,
    fileCount: directFiles(folder.id).filter((f) => canSeeFile(actor, f)).length,
    deletedAt: folder.deletedAt,
    children: FOLDERS.filter((f) => f.parentId === folder.id && listedFolder(actor, f))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      .map((child) => folderNode(actor, child)),
  };
}

function fileView(file: MockFile, actor: Actor): FileView {
  const folder = folderById(file.folderId);
  const perms = folder ? permsOf(actor, folder) : NO_PERMS;
  const previewable = file.previewStatus === 1;
  return {
    id: file.id,
    folderId: file.folderId,
    filename: file.filename,
    fileSize: file.fileSize,
    mimeType: file.mimeType,
    md5: file.md5,
    previewStatus: file.previewStatus,
    visibility: file.visibility,
    // 磁盘路径 storage_path 从不下发（PRD 12.3）
    uploadUid: actor.kind === 'member' || actor.kind === 'temp' ? file.uploadUid : null,
    uploadTempId: actor.kind === 'member' || actor.kind === 'temp' ? file.uploadTempId : null,
    createTime: file.createTime,
    links: {
      preview: previewable ? `${API}/drive/files/${file.id}/preview` : null,
      download: perms.download ? `${API}/drive/files/${file.id}/download` : null,
    },
    canDelete: perms.remove || perms.purge,
    deletedAt: file.deletedAt,
  };
}

function canSeeFile(actor: Actor, file: MockFile): boolean {
  const folder = folderById(file.folderId);
  if (!folder) return false;
  return permsOf(actor, folder).read;
}

/** 无权分支直接不返回，而不是给个空壳（PRD 10.4） */
export function driveTree(actor: Actor): FolderNode[] {
  assertDriveActor(actor);
  ensureProvisioned(actor);
  return FOLDERS.filter((f) => f.parentId === null && listedFolder(actor, f))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    .map((f) => folderNode(actor, f));
}

const SORTERS: Record<string, (a: MockFile, b: MockFile) => number> = {
  time: (a, b) => b.createTime.localeCompare(a.createTime),
  name: (a, b) => a.filename.localeCompare(b.filename, 'zh'),
  size: (a, b) => b.fileSize - a.fileSize,
  type: (a, b) =>
    (a.mimeType.split('/').pop() ?? '').localeCompare(b.mimeType.split('/').pop() ?? '') ||
    a.filename.localeCompare(b.filename, 'zh'),
};

export function listFiles(
  query: Record<string, unknown> | undefined,
  actor: Actor,
): Page<FileView> {
  assertDriveActor(actor);
  const folderId = int(query?.folder, 0);
  const kw = str(query?.kw)?.toLowerCase() ?? '';
  const type = str(query?.type) ?? '';
  const deep = query?.deep === '1' || query?.deep === 1 || query?.deep === true;
  const all = query?.all === '1' || query?.all === 1 || query?.all === true;
  const order = str(query?.order) === 'asc' ? 1 : -1;
  const page = int(query?.page, 1);
  const pageSize = Math.min(200, int(query?.pageSize, 50));

  const inScope = (file: MockFile): boolean => {
    // 根级只列目录：文件必然挂在某个目录下，全盘列表会把各目录内容平铺到根级（手绘稿 19）
    if (!folderId) return !!kw || all;
    if (!deep) return file.folderId === folderId;
    const target = folderById(folderId);
    const folder = folderById(file.folderId);
    if (!target || !folder) return false;
    // 物化路径前缀匹配 = 整棵子树（PRD 5.3）
    return folder.path.startsWith(target.path);
  };

  // 定向查某个隐藏子树（任务页按账户 ID 取图）时才放开，其余列表一律不露出拍展内容
  const target = folderId ? folderById(folderId) : undefined;
  const targetingHidden = target !== undefined && inHiddenSubtree(target);

  const rows = FILES.filter((f) => canSeeFile(actor, f))
    .filter((f) => {
      const folder = folderById(f.folderId);
      if (!folder) return false;
      if (targetingHidden) return true;
      return !inHiddenSubtree(folder);
    })
    .filter(inScope)
    .filter((f) => !kw || f.filename.toLowerCase().includes(kw))
    .filter((f) => !type || f.mimeType.startsWith(type) || f.filename.toLowerCase().endsWith(`.${type}`))
    .sort(SORTERS[str(query?.sort) ?? 'time'] ?? SORTERS.time);

  const ordered = order === 1 ? [...rows].reverse() : rows;
  const start = (page - 1) * pageSize;
  return {
    page,
    pageSize,
    total: ordered.length,
    list: ordered.slice(start, start + pageSize).map((f) => fileView(f, actor)),
  };
}

/**
 * 规则 10：可选的目的地必须有上传权；读得到但没上传权的目录照样列出，只是标灰并给原因
 * （别人的共享文件夹 = 规则 9），省得对着一个空下拉猜为什么没有我要的那个目录。
 * 拍展子树不出现（那条路径靠任务页按账户 ID 定向进入）；垃圾箱会露出来但标灰，
 * 因为它的读取权是真的、上传权不是。
 */
export function uploadTargets(actor: Actor): UploadTarget[] {
  assertDriveActor(actor);
  ensureProvisioned(actor);
  return FOLDERS.filter((f) => !inHiddenSubtree(f) && permsOf(actor, f).read)
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => {
      const perms = permsOf(actor, f);
      return {
        id: f.id,
        name: f.name,
        path: f.path,
        depth: f.depth,
        kind: f.kind,
        trail: folderChain(f.id)
          .map((node) => node.name)
          .join('／'),
        disabledReason: perms.upload
          ? null
          : f.kind === FolderKind.Shared
            ? '他人共享文件夹只能读取与下载（规则 9）'
            : '该目录没有上传权（规则 10）',
      };
    });
}

export function createFolder(body: Record<string, unknown>, actor: Actor): FolderNode {
  assertDriveActor(actor);
  const parentId = body.parentId === undefined || body.parentId === null ? null : Number(body.parentId);
  const parent = parentId === null ? null : folderById(parentId);
  if (parentId !== null && !parent) fail(404, 'NOT_FOUND', '上级目录不存在或无权访问');

  const isSuper = actor.kind === 'member' && actor.level === UserLevel.SuperAdmin;
  if (!parent && !isSuper) fail(403, 'TOP_LEVEL_FORBIDDEN', '顶层目录按用途由系统创建，只能在目录内新建子目录');
  if (parent) assertWritableParent(actor, parent);

  const name = String(body.name ?? '').trim();
  if (!name) fail(400, 'VALIDATION_FAILED', '目录名不能为空');
  if (parent && parent.depth >= MAX_DEPTH) fail(409, 'FOLDER_TOO_DEEP', `目录层级最多 ${MAX_DEPTH} 层`);
  if (siblingNameTaken(parentId, name)) fail(409, 'FOLDER_NAME_EXISTS', '同级已存在同名目录');

  const id = nextFolderId();
  const folder: MockFolder = {
    id,
    parentId,
    path: `${parent?.path ?? '/'}${id}/`,
    depth: (parent?.depth ?? 0) + 1,
    name,
    description: str(body.description) ?? '',
    // 用途随上级：规则 11 的「按时间建子目录」和别人的共享目录里的子目录都靠这一条继承
    kind: parent?.kind ?? FolderKind.Workspace,
    ownerUid: parent?.ownerUid ?? null,
    // 档位继承上级，仅作展示；访问判定看 kind 与文件权限
    visibility: parent?.visibility ?? 'member',
    createUid: actor.kind === 'member' ? actor.uid : 0,
    createTime: new Date().toISOString(),
    updateTime: new Date().toISOString(),
    deletedFromId: null,
    deletedAt: null,
  };
  FOLDERS.push(folder);
  return folderNode(actor, folder);
}

/** 把整棵子树的用途与档位对齐到新上级（移动 = 换用途） */
function restampSubtree(folder: MockFolder, kind: FolderKind, visibility: MockFolder['visibility']): void {
  for (const node of FOLDERS.filter((f) => f.path.startsWith(folder.path))) {
    node.kind = kind;
    node.visibility = visibility;
  }
  folder.kind = kind;
  folder.visibility = visibility;
}

/** 改名 / 移动；移动要整棵子树重算 path 与 depth，并禁止移进自己的子孙 */
export function updateFolder(id: number, body: Record<string, unknown>, actor: Actor): FolderNode {
  assertDriveActor(actor);
  const folder = folderById(id);
  if (!folder) fail(404, 'NOT_FOUND', '目录不存在或无权访问');
  if (!permsOf(actor, folder).modify) {
    fail(403, 'FOLDER_READONLY', '对该目录没有改动权（规则 9：他人共享文件夹只读只下载）');
  }

  const name = str(body.name)?.trim();
  if (name && siblingNameTaken(folder.parentId, name, folder.id)) {
    fail(409, 'FOLDER_NAME_EXISTS', '同级已存在同名目录');
  }

  const subtree = FOLDERS.filter((f) => f.path.startsWith(folder.path));

  if (body.parentId !== undefined) {
    const newParentId = body.parentId === null ? null : Number(body.parentId);
    if (newParentId === id) fail(409, 'FOLDER_CYCLE', '不能移动到自身');
    const newParent = newParentId === null ? null : (folderById(newParentId) ?? null);
    if (newParentId !== null && !newParent) fail(404, 'NOT_FOUND', '目标上级目录不存在');
    if (newParent && !permsOf(actor, newParent).modify) {
      fail(403, 'FOLDER_READONLY', '目标上级目录没有改动权');
    }
    if (newParent && newParent.kind === FolderKind.Trash) {
      fail(403, 'TRASH_NO_WRITE', '请用删除操作把目录放进垃圾箱');
    }
    // 目标目录在被移动的子树里 = 移进自己的子孙，防环（PRD 5.3）
    if (newParent && newParent.path.startsWith(folder.path)) {
      fail(409, 'FOLDER_CYCLE', '不能把目录移动到它自己的子目录下');
    }
    const targetDepth = (newParent?.depth ?? 0) + 1;
    const deepest = Math.max(...subtree.map((f) => f.depth - folder.depth));
    if (targetDepth + deepest > MAX_DEPTH) fail(409, 'FOLDER_TOO_DEEP', `移动后层级会超过 ${MAX_DEPTH} 层`);
    if (name !== undefined && siblingNameTaken(newParentId, name || folder.name, folder.id)) {
      fail(409, 'FOLDER_NAME_EXISTS', '目标同级已存在同名目录');
    }
    const oldPrefix = folder.path;
    const newPrefix = `${newParent?.path ?? '/'}${folder.id}/`;
    const delta = targetDepth - folder.depth;
    for (const node of subtree) {
      node.path = node.path.replace(oldPrefix, newPrefix);
      node.depth += delta;
    }
    folder.parentId = newParentId;
    folder.depth = targetDepth;
    folder.path = newPrefix;
    restampSubtree(folder, newParent?.kind ?? folder.kind, newParent?.visibility ?? folder.visibility);
  }

  if (name) folder.name = name;
  if (body.description !== undefined) folder.description = String(body.description);
  folder.updateTime = new Date().toISOString();
  return folderNode(actor, folder);
}

/** 规则 7：删文件要该目录的删除权，删完进垃圾箱；规则 8：超管在私人目录里直接彻底删除 */
export function deleteFile(id: number, actor: Actor): { id: number; purged: boolean } {
  assertDriveActor(actor);
  const file = fileById(id);
  if (!file) fail(404, 'NOT_FOUND', '文件不存在或无权访问');
  const folder = folderById(file.folderId);
  if (!folder) fail(404, 'NOT_FOUND', '文件不存在或无权访问');
  const perms = permsOf(actor, folder);
  if (!perms.remove && !perms.purge) fail(403, 'FOLDER_READONLY', '对该目录没有删除权');

  if (perms.purge || folder.kind === FolderKind.Trash) {
    releaseFileQuota(file);
    FILES.splice(FILES.indexOf(file), 1);
    return { id, purged: true };
  }
  file.deletedFromId = file.folderId;
  file.deletedAt = new Date().toISOString();
  file.folderId = TRASH_FOLDER_ID;
  return { id, purged: false };
}

/** 垃圾箱里的还原与清除：只有超管拿得到 modify／purge（规则 12） */
export function restoreFile(id: number, actor: Actor): FileView {
  assertDriveActor(actor);
  const file = fileById(id);
  if (!file) fail(404, 'NOT_FOUND', '文件不存在或无权访问');
  if (!file.deletedAt) fail(409, 'NOT_IN_TRASH', '该文件不在垃圾箱里');
  const home = file.deletedFromId === null ? undefined : folderById(file.deletedFromId);
  if (!home) fail(409, 'ORIGINAL_FOLDER_GONE', '原目录已不存在，无法还原');
  const trashPerms = folderById(TRASH_FOLDER_ID);
  if (!trashPerms || !permsOf(actor, trashPerms).modify) fail(403, 'TRASH_FORBIDDEN', '垃圾箱只有超管能更改');
  file.folderId = home.id;
  file.deletedFromId = null;
  file.deletedAt = null;
  return fileView(file, actor);
}

export function purgeFile(id: number, actor: Actor): { id: number; purged: true } {
  assertDriveActor(actor);
  const file = fileById(id);
  if (!file) fail(404, 'NOT_FOUND', '文件不存在或无权访问');
  const folder = folderById(file.folderId);
  if (!folder || !permsOf(actor, folder).purge) {
    fail(403, 'TRASH_FORBIDDEN', '彻底删除只有超管在垃圾箱或私人目录里可做（规则 8/12）');
  }
  releaseFileQuota(file);
  FILES.splice(FILES.indexOf(file), 1);
  return { id, purged: true };
}

/** 规则 7：删目录同样先落垃圾箱，整棵子树跟着走；超管私人目录里就地清除（规则 8） */
export function deleteFolder(
  id: number,
  actor: Actor,
): { id: number; purged: boolean; movedFolders: number; movedFiles: number } {
  assertDriveActor(actor);
  const folder = folderById(id);
  if (!folder) fail(404, 'NOT_FOUND', '目录不存在或无权访问');
  if (folder.id === TRASH_FOLDER_ID) fail(403, 'TRASH_UNDELETABLE', '垃圾箱本身不能删除');
  const perms = permsOf(actor, folder);
  if (!perms.remove && !perms.purge) fail(403, 'FOLDER_READONLY', '对该目录没有删除权');

  const subtree = FOLDERS.filter((f) => f.path.startsWith(folder.path));
  const files = FILES.filter((f) => subtree.some((d) => d.id === f.folderId));

  if (perms.purge) {
    for (const f of files) {
      releaseFileQuota(f);
      FILES.splice(FILES.indexOf(f), 1);
    }
    for (const f of subtree) FOLDERS.splice(FOLDERS.indexOf(f), 1);
    return { id, purged: true, movedFolders: subtree.length, movedFiles: files.length };
  }

  const oldPrefix = folder.path;
  const originalParentId = folder.parentId;
  const trash = folderById(TRASH_FOLDER_ID);
  const trashDepth = trash?.depth ?? 1;
  const newPrefix = `${trash?.path ?? `/${TRASH_FOLDER_ID}/`}${folder.id}/`;
  const delta = trashDepth + 1 - folder.depth;
  for (const node of subtree) {
    node.path = node.path.replace(oldPrefix, newPrefix);
    node.depth += delta;
  }
  folder.parentId = TRASH_FOLDER_ID;
  folder.depth = trashDepth + 1;
  folder.path = newPrefix;
  folder.deletedFromId = originalParentId;
  folder.deletedAt = new Date().toISOString();
  for (const f of files) {
    f.deletedFromId = f.folderId;
    f.deletedAt = folder.deletedAt;
    f.folderId = TRASH_FOLDER_ID;
  }
  return { id, purged: false, movedFolders: subtree.length, movedFiles: files.length };
}

export function restoreFolder(id: number, actor: Actor): FolderNode {
  assertDriveActor(actor);
  const folder = folderById(id);
  if (!folder) fail(404, 'NOT_FOUND', '目录不存在或无权访问');
  if (!folder.deletedAt) fail(409, 'NOT_IN_TRASH', '该目录不在垃圾箱里');
  const trash = folderById(TRASH_FOLDER_ID);
  if (!trash || !permsOf(actor, trash).modify) fail(403, 'TRASH_FORBIDDEN', '垃圾箱只有超管能更改');
  const homeId = folder.deletedFromId;
  const home = homeId === null ? undefined : folderById(homeId);
  if (homeId !== null && !home) fail(409, 'ORIGINAL_FOLDER_GONE', '原上级目录已不存在，无法还原');
  if (home && home.kind === FolderKind.Trash) fail(409, 'ORIGINAL_FOLDER_GONE', '原上级目录已经在垃圾箱里');

  const subtree = FOLDERS.filter((f) => f.path.startsWith(folder.path));
  const newPrefix = `${home?.path ?? '/'}${folder.id}/`;
  const oldPrefix = folder.path;
  const targetDepth = (home?.depth ?? 0) + 1;
  const delta = targetDepth - folder.depth;
  for (const node of subtree) {
    node.path = node.path.replace(oldPrefix, newPrefix);
    node.depth += delta;
    if (node.kind === FolderKind.Trash) node.kind = home?.kind ?? FolderKind.Workspace;
  }
  folder.parentId = home?.id ?? null;
  folder.depth = targetDepth;
  folder.path = newPrefix;
  folder.kind = home?.kind ?? folder.kind;
  folder.visibility = home?.visibility ?? folder.visibility;
  folder.deletedFromId = null;
  folder.deletedAt = null;
  folder.updateTime = new Date().toISOString();
  // 原本就住在这棵子树里的文件跟着回家，别把它们留在垃圾箱根上
  const restoredIds = new Set(subtree.map((node) => node.id));
  for (const f of FILES) {
    if (f.deletedFromId !== null && restoredIds.has(f.deletedFromId)) {
      f.folderId = f.deletedFromId;
      f.deletedFromId = null;
      f.deletedAt = null;
    }
  }
  return folderNode(actor, folder);
}

/** 清空垃圾箱的一棵目录，或从垃圾箱里彻底删除某个目录 */
export function purgeFolder(id: number, actor: Actor): { id: number; purged: true; folders: number; files: number } {
  assertDriveActor(actor);
  const folder = folderById(id);
  if (!folder) fail(404, 'NOT_FOUND', '目录不存在或无权访问');
  const perms = permsOf(actor, folder);
  if (!perms.purge) fail(403, 'TRASH_FORBIDDEN', '彻底删除只有超管能做（规则 12）');
  const subtree = FOLDERS.filter((f) => f.path.startsWith(folder.path));
  const files = FILES.filter((f) => subtree.some((d) => d.id === f.folderId));
  for (const f of files) {
    releaseFileQuota(f);
    FILES.splice(FILES.indexOf(f), 1);
  }
  for (const f of subtree) FOLDERS.splice(FOLDERS.indexOf(f), 1);
  return { id, purged: true, folders: subtree.length, files: files.length };
}

/** 文件上传在 mock 里一次成形：真接口是分片合并，校验口径同样在合并时做 */
export function uploadFile(body: Record<string, unknown>, actor: Actor): FileView {
  assertDriveActor(actor);
  const folderId = int(body.folderId, 0);
  const folder = folderById(folderId);
  if (!folder) fail(404, 'NOT_FOUND', '目录不存在或无权访问');
  const perms = permsOf(actor, folder);
  if (!perms.read) fail(404, 'NOT_FOUND', '目录不存在或无权访问');
  // 规则 10：目的地必须真的有上传权，别人的共享文件夹会在这里被挡下
  if (!perms.upload) fail(403, 'FOLDER_NO_UPLOAD', '该目录没有上传权，换一个目的地（规则 9/10）');

  const filename = String(body.filename ?? '').trim();
  const size = Number(body.fileSize);
  if (!filename) fail(400, 'VALIDATION_FAILED', 'filename 不能为空');
  if (!Number.isInteger(size) || size < 1) fail(400, 'VALIDATION_FAILED', 'fileSize 必须是整数');

  const ext = `.${filename.split('.').pop()?.toLowerCase() ?? ''}`;
  // 黑名单无条件拒，即使命中白名单（PRD 5.2）
  if (settingList('upload.blocked_extensions').includes(ext)) {
    fail(415, 'EXTENSION_BLOCKED', `禁止上传可执行类型 ${ext}`);
  }
  if (!settingList('upload.file_extensions').includes(ext)) {
    fail(415, 'TYPE_NOT_ALLOWED', `扩展名 ${ext} 不在白名单内（服务端仍会按魔数复核）`);
  }

  const maxFile = settingNumber('upload.max_file_size');
  if (size > maxFile) fail(413, 'FILE_TOO_LARGE', `单个文件上限 ${Math.round(maxFile / 1024 / 1024 / 1024)}GB`);

  const owner = quotaOwner(actor);
  if (owner && owner.quota > 0 && owner.used + size > owner.quota) {
    fail(413, 'QUOTA_EXCEEDED', `空间不足，已用 ${owner.used} / 配额 ${owner.quota}`);
  }

  const file: MockFile = {
    id: nextFileId(),
    folderId,
    filename,
    storagePath: `uuid-${Date.now().toString(36)}.bin`,
    fileSize: size,
    mimeType: String(body.mimeType ?? ''),
    md5: md5Of(Date.now() % 100000),
    previewStatus: (ext === '.psd' || ext === '.ai' || ext === '.zip' || ext === '.7z' || ext === '.rar') ? 2 : 1,
    visibility: folder.visibility,
    uploadUid: actor.uid,
    uploadTempId: null,
    createTime: new Date().toISOString(),
    deletedFromId: null,
    deletedAt: null,
  };
  FILES.push(file);
  owner?.add(size);
  return fileView(file, actor);
}

/** 批量打包：读 zip 能力位（PRD 6.4），临时账号需 allow_download；单次上限 500（PRD 4.5） */
export function batchZip(body: Record<string, unknown>, actor: Actor): BatchZipResult {
  assertDriveActor(actor);
  if (actor.kind === 'member' && !actor.caps.zip) {
    // 等级默认有 zip 位但被强制关掉 → CAP_DISABLED；等级默认就没有（L1）→ LEVEL_FORBIDDEN
    fail(
      403,
      actor.level >= UserLevel.Member ? 'CAP_DISABLED' : 'LEVEL_FORBIDDEN',
      actor.level >= UserLevel.Member ? '「批量打包」已被超管关闭' : '当前成员等级无权使用批量打包',
    );
  }

  const ids = Array.isArray(body.fileIds)
    ? (body.fileIds as unknown[]).map(Number)
    : String(body.fileIds ?? '')
        .split(',')
        .map(Number)
        .filter((n) => !Number.isNaN(n));
  if (!ids.length) fail(400, 'VALIDATION_FAILED', 'fileIds 不能为空');
  if (ids.length > MAX_ZIP_ITEMS) fail(400, 'BATCH_TOO_LARGE', `单次最多打包 ${MAX_ZIP_ITEMS} 个文件`);

  const rejected: BatchZipResult['rejected'] = [];
  const accepted: MockFile[] = [];
  for (const id of ids) {
    const file = FILES.find((f) => f.id === id);
    const folder = file ? folderById(file.folderId) : undefined;
    if (!file || !folder) {
      rejected.push({ fileId: id, status: 404, code: 'NOT_FOUND', message: '文件不存在或无权访问' });
      continue;
    }
    const perms = permsOf(actor, folder);
    if (!perms.read) {
      rejected.push({ fileId: id, status: 404, code: 'NOT_FOUND', message: '文件不存在或无权访问' });
      continue;
    }
    if (!perms.download) {
      rejected.push({ fileId: id, status: 403, code: 'FOLDER_NO_DOWNLOAD', message: '该目录没有下载权' });
      continue;
    }
    accepted.push(file);
  }
  return {
    requested: ids.length,
    accepted: accepted.length,
    estimatedSize: accepted.reduce((sum, f) => sum + f.fileSize, 0),
    zipUrl: accepted.length ? `${API}/drive/files/batch-zip?job=demo` : '',
    rejected,
  };
}
