/**
 * 后台控制台的 mock（PRD 8.2 / 10.5）：仪表盘、成员、临时账号、标签库、
 * 日志审计、站点设置。相册管理复用 album.ts，分享链接管理复用 share.ts。
 * 权限口径：L3 起进后台，L3 只能操作 L1/L2，站点设置只对 L4 可写；
 * 超管唯一性（12.4）在改级时挡住，必须带 confirmTransfer 才允许转让。
 */
import type {
  AdminSettingRow,
  AdminTagRow,
  AdminTempRow,
  AdminUserRow,
  AlbumCapKey,
  CapMode,
  CapKey,
  DashboardData,
  DriveGrant,
  FeatureGrant,
  Page,
  TempFlags,
  UserLevel,
} from '@/types/api';
import { ALBUM_CAP_KEYS, CAP_KEYS, CAP_LABEL, RESERVED_CAPS, UserLevel as Level } from '@/types/api';
import {
  ALBUMS,
  IMAGES,
  NO_DRIVE_GRANT,
  TAGS,
  TEMPS,
  USERS,
  addTemp,
  deleteTag,
  levelName,
  mergeTag,
  newTempPassword,
  nextAccountCode,
  renameTag,
  tagUseCount,
  userActor,
} from './db';
import type { MockTemp, MockUser } from './db';
import { FILES, FOLDERS, LOGS, SETTINGS, SHARE_LINKS, shareExpired, toCsv, folderById } from './tables';
import type { MockLog } from './tables';
import { assertAccountCode, capabilitiesFor, fail, int, isTrue, paged, requireLevel, requireReauth, str } from './shared';
import { overriddenCaps } from './policy';
import type { Actor } from './policy';
import { adminAlbumList, albumRow } from './album';
import type { AlbumRow } from './album';
import { ensureProvisioned } from './drive';

// ---------------- 审计日志落表 ----------------

let logSeq = LOGS.length ? Math.max(...LOGS.map((l) => l.id)) : 0;

/** 每次写操作补一条审计；detail 绝不带密码与令牌（PRD 12.11）。加密空间模块也复用这一处，共享同一个 logSeq */
export function writeLog(
  actor: Actor,
  action: string,
  targetType: string,
  targetId: number | null,
  detail: string,
  result: 0 | 1 = 1,
): void {
  logSeq += 1;
  const base: MockLog = {
    id: logSeq,
    userType: actor.kind === 'member' ? 'user' : actor.kind === 'temp' ? 'temp' : 'guest',
    uid: actor.kind === 'member' ? actor.uid : null,
    tempId: actor.kind === 'temp' ? actor.tempId : null,
    action,
    targetType,
    targetId,
    detail,
    ip: '127.0.0.1',
    ua: 'demo-console',
    result,
    createTime: new Date().toISOString(),
  };
  LOGS.unshift(base);
}

// ---------------- 仪表盘 ----------------

const QUOTA_WARN = 0.8;

function trendDays(): { date: string; uploads: number }[] {
  const days: { date: string; uploads: number }[] = [];
  for (let i = 13; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 86_400_000);
    const date = d.toISOString().slice(0, 10);
    days.push({
      date,
      uploads: LOGS.filter((l) => l.action === 'image_upload' && l.result === 1 && l.createTime.slice(0, 10) === date)
        .length,
    });
  }
  return days;
}

export function dashboard(actor: Actor): DashboardData {
  requireLevel(actor, 3);
  const quota = USERS.reduce((sum, u) => sum + (u.spaceQuota || 0), 0);
  const used = USERS.reduce((sum, u) => sum + u.usedSpace, 0);
  const ratio = quota ? used / quota : 0;
  return {
    counts: {
      albums: ALBUMS.length,
      images: IMAGES.length,
      folders: FOLDERS.length,
      files: FILES.length,
      tags: TAGS.length,
      users: USERS.length,
      tempActive: TEMPS.filter((t) => new Date(t.expiresAt).getTime() > Date.now()).length,
      shareAlive: SHARE_LINKS.filter((s) => !shareExpired(s)).length,
    },
    storage: {
      quota,
      used,
      ratio: Number(ratio.toFixed(4)),
      // 总量超 80% 飘红 + 站内通知（PRD 8.2）
      warning: ratio > QUOTA_WARN,
      perUser: USERS.map((u) => ({
        uid: u.uid,
        nickname: u.nickname,
        quota: u.spaceQuota,
        used: u.usedSpace,
        ratio: u.spaceQuota ? Number((u.usedSpace / u.spaceQuota).toFixed(4)) : 0,
      })),
    },
    trend: trendDays(),
    recentLogs: LOGS.slice().sort((a, b) => b.createTime.localeCompare(a.createTime)).slice(0, 8),
    albumList: adminAlbumList({ page: 1, pageSize: 5 }, actor).list,
  };
}

// ---------------- 成员管理 ----------------

type UserRow = AdminUserRow;

function userRow(user: MockUser): UserRow {
  const grant = user.featureGrant ?? {};
  return {
    uid: user.uid,
    username: user.username,
    nickname: user.nickname,
    position: user.position,
    level: user.level,
    levelName: levelName(user.level),
    spaceQuota: user.spaceQuota,
    usedSpace: user.usedSpace,
    disabled: !!user.disabled,
    lastLogin: user.lastLogin ?? null,
    albumCount: ALBUMS.filter((a) => a.createUid === user.uid).length,
    imageCount: IMAGES.filter((s) => s.uploaderUid === user.uid).length,
    driveGrant: user.driveGrant ?? NO_DRIVE_GRANT,
    featureGrant: grant,
    capabilities: user.disabled ? null : capabilitiesFor(user.level, grant),
    capsOverridden: overriddenCaps(user.level, grant),
  };
}

/** L3 只能碰 L1/L2，L4 的账号只有 L4 自己能改（PRD 6.1 / 12.4） */
function assertCanManage(actor: Extract<Actor, { kind: 'member' }>, target: MockUser): void {
  if (actor.level === Level.Admin && target.level > Level.Member) {
    fail(403, 'LEVEL_FORBIDDEN', '普通管理员不能操作 L3/L4 账号');
  }
}

export function listUsers(query: Record<string, unknown> | undefined, actor: Actor): UserRow[] {
  const member = requireLevel(actor, 3);
  let rows = USERS.map(userRow);
  const level = Number(query?.level);
  if (level) rows = rows.filter((u) => u.level === level);
  const kw = str(query?.keyword)?.trim().toLowerCase();
  if (kw) rows = rows.filter((u) => `${u.username} ${u.nickname} ${u.position}`.toLowerCase().includes(kw));
  // L3 看不到 L4 的存在，避免超管账号被枚举
  if (member.level === Level.Admin) rows = rows.filter((u) => u.level <= Level.Admin);
  return rows;
}

export function createUser(body: Record<string, unknown>, actor: Actor): UserRow {
  const member = requireReauth(requireLevel(actor, 3));
  const username = String(body.username ?? '').trim();
  const nickname = String(body.nickname ?? '').trim();
  const level = Number(body.level ?? Level.Trainee) as UserLevel;
  if (!/^[a-z0-9_.-]{3,32}$/i.test(username)) fail(400, 'USERNAME_INVALID', '账号名 3~32 位，仅限字母数字与 _.-');
  if (!nickname) fail(400, 'VALIDATION_FAILED', '昵称不能为空');
  if (![1, 2, 3, 4].includes(level)) fail(400, 'VALIDATION_FAILED', '等级只能是 1~4');
  if (USERS.some((u) => u.username === username)) fail(409, 'USERNAME_EXISTS', '账号名已存在');
  // 建号必须带初始口令，与 resetPassword 同一口径；口令不落 mock 表，演示登录仍统一走 demo1234
  const password = String(body.password ?? '');
  if (password.length < 8) fail(400, 'PASSWORD_WEAK', '口令至少 8 位');
  if (member.level === Level.Admin && level > Level.Member) {
    fail(403, 'LEVEL_FORBIDDEN', '普通管理员只能创建 L1/L2 账号');
  }
  if (level === Level.SuperAdmin && USERS.some((u) => u.level === Level.SuperAdmin)) {
    fail(409, 'SUPER_ADMIN_EXISTS', '系统只允许 1 个超级管理员，请使用「转让超管」');
  }
  const user: MockUser = {
    uid: Math.max(0, ...USERS.map((u) => u.uid)) + 1,
    username,
    nickname,
    position: String(body.position ?? '').trim() || '成员',
    level,
    spaceQuota: Number(body.spaceQuota ?? SETTINGS['storage.default_quota']),
    usedSpace: 0,
    disabled: false,
    lastLogin: null,
  };
  USERS.push(user);
  writeLog(actor, 'user_create', 'user', user.uid, `username=${username}, level=${level}, position=${user.position}, hasPassword=1`, 1);
  return userRow(user);
}

export function updateUser(id: number, body: Record<string, unknown>, actor: Actor): UserRow {
  const member = requireReauth(requireLevel(actor, 3));
  const user = USERS.find((u) => u.uid === id);
  if (!user) fail(404, 'NOT_FOUND', '账号不存在');
  assertCanManage(member, user);

  // 账号名修改：仅超级管理员独占，防止普通管理员用改用户名来绕过枚举保护
  if (body.username !== undefined) {
    if (member.level !== Level.SuperAdmin) {
      fail(403, 'LEVEL_FORBIDDEN', '仅超级管理员可修改账号名');
    }
    const nextUsername = String(body.username).trim();
    if (!nextUsername) fail(400, 'USERNAME_INVALID', '账号名不能为空');
    if (!/^[a-z0-9_.-]{3,32}$/i.test(nextUsername)) fail(400, 'USERNAME_INVALID', '账号名 3~32 位，仅限字母数字与 _.-');
    if (nextUsername !== user.username && USERS.some((u) => u.username === nextUsername)) {
      fail(409, 'USERNAME_EXISTS', '账号名已存在');
    }
    if (nextUsername !== user.username) {
      const oldName = user.username;
      user.username = nextUsername;
      writeLog(actor, 'user_rename', 'user', user.uid, `old=${oldName}, new=${nextUsername}`, 1);
    }
  }

  const nextLevel = body.level === undefined ? undefined : (Number(body.level) as UserLevel);
  if (nextLevel !== undefined && ![1, 2, 3, 4].includes(nextLevel)) {
    fail(400, 'VALIDATION_FAILED', '等级只能是 1~4');
  }
  if (nextLevel === Level.SuperAdmin && user.level !== Level.SuperAdmin) {
    const holder = USERS.find((u) => u.level === Level.SuperAdmin && u.uid !== id);
    if (holder && !isTrue(body.confirmTransfer)) {
      fail(409, 'SUPER_ADMIN_EXISTS', `超管由「${holder.nickname}」持有，转让需二次确认`);
    }
    if (holder && isTrue(body.confirmTransfer)) {
      holder.level = Level.Admin;
      writeLog(actor, 'superadmin_downgrade', 'user', holder.uid, `转让超管：uid=${holder.uid} → L3`, 1);
    }
  }
  // 唯一超管不能被降级或禁用掉，否则再没人能进站点设置；转让走的是上面「提升他人」那条路径
  if (user.level === Level.SuperAdmin && nextLevel !== undefined && nextLevel !== Level.SuperAdmin) {
    if (!USERS.some((u) => u.uid !== id && u.level === Level.SuperAdmin)) {
      fail(409, 'LAST_SUPER_ADMIN', '系统必须保留 1 个超级管理员，请先用「提升他人」完成转让');
    }
  }
  if (nextLevel !== undefined) user.level = nextLevel;
  if (body.nickname !== undefined) user.nickname = String(body.nickname).trim() || user.nickname;
  // 空职务不改写：欢迎语与共享文件夹标签都读这一列，宁可不改也不能清空
  if (body.position !== undefined) user.position = String(body.position).trim() || user.position;
  if (body.spaceQuota !== undefined) user.spaceQuota = Math.max(0, Number(body.spaceQuota) || 0);
  if (body.disabled !== undefined) {
    if (user.uid === member.uid) fail(409, 'SELF_DISABLE', '不能禁用当前登录的账号');
    if (user.level === Level.SuperAdmin && isTrue(body.disabled)) fail(409, 'LAST_SUPER_ADMIN', '不能禁用超级管理员');
    user.disabled = isTrue(body.disabled);
  }
  writeLog(actor, 'user_update', 'user', user.uid, `level=${user.level}, disabled=${user.disabled ? 1 : 0}`, 1);
  return userRow(user);
}

export function deleteUser(id: number, actor: Actor): { uid: number; removed: true } {
  const member = requireReauth(requireLevel(actor, 4));
  const user = USERS.find((u) => u.uid === id);
  if (!user) fail(404, 'NOT_FOUND', '账号不存在');
  if (user.uid === member.uid) fail(409, 'SELF_DELETE', '不能删除当前登录的账号');
  if (user.level === Level.SuperAdmin) fail(409, 'LAST_SUPER_ADMIN', '不能删除超级管理员，请先转让');
  // 真接口是 FK 限制 + 资源先转移；这里只挡人，不动他上传的图
  const at = USERS.indexOf(user);
  USERS.splice(at, 1);
  writeLog(actor, 'user_delete', 'user', id, `username=${user.username}`, 1);
  return { uid: id, removed: true };
}

export function resetPassword(id: number, body: Record<string, unknown>, actor: Actor): { uid: number; reset: true } {
  requireReauth(requireLevel(actor, 3));
  const user = USERS.find((u) => u.uid === id);
  if (!user) fail(404, 'NOT_FOUND', '账号不存在');
  if (actor.kind === 'member' && actor.level === Level.Admin && user.level > Level.Member) {
    fail(403, 'LEVEL_FORBIDDEN', '普通管理员不能重置 L3/L4 的口令');
  }
  const pwd = String(body.newPassword ?? '');
  if (pwd.length < 8) fail(400, 'PASSWORD_WEAK', '口令至少 8 位');
  // 真接口走 bcrypt(cost 12)，这里只记「改了」，绝不落明文
  writeLog(actor, 'user_reset_password', 'user', id, 'method=admin_reset', 1);
  return { uid: id, reset: true };
}

/**
 * 规则 13：给单个人开启文件权限1~4，只有超管能做（L3 连读都要走成员列表，改不了）。
 * 入参是整份替换而不是增量合并：四个开关都按 body 里的值落，缺字段即关掉，
 * 免得前端漏传一个就静默留着一条没人认领的授权。
 */
export function updateUserDriveGrants(id: number, body: Record<string, unknown>, actor: Actor): UserRow {
  requireReauth(requireLevel(actor, 4));
  const user = USERS.find((u) => u.uid === id);
  if (!user) fail(404, 'NOT_FOUND', '账号不存在');
  const grant: DriveGrant = {
    perm1: isTrue(body.perm1),
    perm2: isTrue(body.perm2),
    perm3: isTrue(body.perm3),
    perm4: isTrue(body.perm4),
  };
  user.driveGrant = grant;
  // 文件权限3/4 一旦开启就该有这个人的共享／私人目录，不等他下次登录再补建
  ensureProvisioned(userActor(user.uid));
  writeLog(
    actor,
    'user_drive_grant',
    'user',
    user.uid,
    `perm1=${grant.perm1 ? 1 : 0}, perm2=${grant.perm2 ? 1 : 0}, perm3=${grant.perm3 ? 1 : 0}, perm4=${grant.perm4 ? 1 : 0}`,
    1,
  );
  return userRow(user);
}

/**
 * D21：超管逐项给某个人覆盖能力位——只有 L4 能调；入参是整份 FeatureGrant，
 * 缺键或值为 'inherit' 都视为回到跟随等级（JSON 里不落 inherit）；
 * 保留位不能下放，唯一 L4 的 adminConsole / writeSiteSettings 不能关（PRD 6.4）。
 */
export function updateUserFeatureGrants(id: number, body: Record<string, unknown>, actor: Actor): UserRow {
  requireReauth(requireLevel(actor, 4));
  const user = USERS.find((u) => u.uid === id);
  if (!user) fail(404, 'NOT_FOUND', '账号不存在');

  const raw = body as Partial<Record<CapKey, CapMode>>;
  const VALID_MODES: CapMode[] = ['inherit', 'on', 'off'];

  // 校验所有键必须在 CAP_KEYS 内，值必须是三态之一
  for (const [key, mode] of Object.entries(raw)) {
    if (!CAP_KEYS.includes(key as CapKey)) {
      fail(400, 'VALIDATION_FAILED', `未知能力位：${key}`);
    }
    if (!VALID_MODES.includes(mode as CapMode)) {
      fail(400, 'VALIDATION_FAILED', `${key} 的值必须是 inherit / on / off`);
    }
  }

  // 保留位：writeSiteSettings 不能开给 L1–L3
  for (const [key, mode] of Object.entries(raw)) {
    if (mode !== 'on') continue;
    if (RESERVED_CAPS.includes(key as CapKey) && user.level !== Level.SuperAdmin) {
      fail(409, 'CAP_RESERVED', `「站点配置写入」保留位只归超管，不能下放给 L${user.level}`);
    }
  }

  // 唯一在职 L4：不能关 adminConsole / writeSiteSettings（否则再没人能进后台）
  const lastSuper = USERS.filter((u) => u.level === Level.SuperAdmin);
  if (lastSuper.length === 1 && lastSuper[0].uid === id) {
    const forbiddenOff = (['adminConsole', 'writeSiteSettings'] as CapKey[]).find(
      (key) => raw[key] === 'off',
    );
    if (forbiddenOff) {
      fail(409, 'LAST_SUPER_ADMIN', `你是系统唯一的超级管理员，不能关闭「${CAP_LABEL[forbiddenOff]}」`);
    }
  }

  // 整份替换：'inherit' 的键不落表（缺键即跟随等级）
  const grant: FeatureGrant = {};
  for (const key of CAP_KEYS) {
    const mode = raw[key];
    if (mode === 'on' || mode === 'off') grant[key] = mode;
  }
  user.featureGrant = grant;

  const detail = Object.entries(grant)
    .map(([k, v]) => `${k}=${v}`)
    .join(',') || '(all inherit)';
  writeLog(actor, 'user_feature_grant', 'user', user.uid, detail, 1);
  return userRow(user);
}

/**
 * D22：超管改临时账号的登录凭据。帐户ID 同时是规则 3 的「拍展」目录名，
 * 改完要把那一棵同步改名，否则任务页显示的目录名与他登录用的 ID 不再是同一个词。
 * 口令只在写入时校验长度，响应与日志都不带它（12.11）。
 */
export function updateTempCredentials(id: number, body: Record<string, unknown>, actor: Actor): TempRow {
  requireReauth(requireLevel(actor, 4));
  const temp = TEMPS.find((t) => t.tempId === id);
  if (!temp) fail(404, 'NOT_FOUND', '临时账号不存在');
  const nextCode = str(body.code)?.trim().toUpperCase();
  const nextPwd = str(body.password);
  if (!nextCode && !nextPwd) fail(400, 'VALIDATION_FAILED', '帐户ID 与密码至少要改一项');

  // ---------- 先校验，全部通过后再落库 ----------
  if (nextCode) {
    assertAccountCode(nextCode);
    if (TEMPS.some((t) => t.code === nextCode)) fail(409, 'TEMP_CODE_TAKEN', '这个帐户ID 已被占用');
  }
  if (nextPwd && nextPwd.length < 6) fail(400, 'WEAK_PASSWORD', '登录密码至少 6 位');

  // ---------- 落库 ----------
  const changed: string[] = [];
  if (nextCode && nextCode !== temp.code) {
    const before = temp.code;
    temp.code = nextCode;
    // 规则 3 的锚点目录跟着改名：白名单与配额都按 id 认，改名不动里面的文件
    const folder = folderById(temp.taskFolderId);
    if (folder) {
      folder.name = nextCode;
      folder.updateTime = new Date().toISOString();
    }
    changed.push(`code=${before}→${nextCode}`);
  }
  if (nextPwd) {
    temp.password = nextPwd;
    changed.push('password=1');
  }
  writeLog(actor, 'temp_credentials', 'temp', id, changed.join(', '), 1);
  return tempRow(temp);
}

// ---------------- 临时账号 ----------------

type TempRow = AdminTempRow;

/** 逐列挑而不是整行展开：密码与任务阶段标记不进后台列表响应 */
function tempRow(temp: MockTemp): TempRow {
  const owner = USERS.find((u) => u.uid === temp.ownerUid);
  return {
    tempId: temp.tempId,
    code: temp.code,
    displayName: temp.displayName,
    ownerUid: temp.ownerUid,
    ownerName: owner ? `${owner.nickname}（${levelName(owner.level)}）` : `uid=${temp.ownerUid}`,
    expiresAt: temp.expiresAt,
    expired: new Date(temp.expiresAt).getTime() < Date.now(),
    flags: temp.flags,
    albumIds: temp.albumIds,
    folderIds: temp.folderIds,
    spaceQuota: temp.spaceQuota,
    usedSpace: temp.usedSpace,
  };
}

export function listTemps(query: Record<string, unknown> | undefined, actor: Actor): TempRow[] {
  requireLevel(actor, 3);
  let rows = TEMPS.map(tempRow);
  if (isTrue(query?.onlyAlive)) rows = rows.filter((t) => !t.expired);
  const kw = str(query?.keyword)?.trim().toLowerCase();
  if (kw) rows = rows.filter((t) => `${t.code} ${t.displayName}`.toLowerCase().includes(kw));
  return rows;
}

export function createTemp(body: Record<string, unknown>, actor: Actor): TempRow {
  const member = requireReauth(requireLevel(actor, 3));
  const displayName = String(body.displayName ?? '').trim();
  if (!displayName) fail(400, 'VALIDATION_FAILED', '显示名不能为空');
  const ownerUid = Number(body.ownerUid ?? member.uid);
  if (!USERS.some((u) => u.uid === ownerUid)) fail(400, 'OWNER_NOT_FOUND', '归属成员不存在');
  const albumIds = (Array.isArray(body.albumIds) ? body.albumIds : []).map(Number);
  for (const id of albumIds) {
    if (!ALBUMS.some((a) => a.id === id)) fail(404, 'NOT_FOUND', `相册 ${id} 不存在`);
  }
  const folderIds = (Array.isArray(body.folderIds) ? body.folderIds : []).map(Number);
  const days = Math.min(365, Math.max(1, int(body.days, 14)));
  const flags = (body.flags ?? {}) as Partial<TempFlags>;
  const code = String(body.code ?? '').trim() || nextAccountCode();
  if (TEMPS.some((t) => t.code === code)) fail(409, 'TEMP_CODE_TAKEN', '帐户ID 已被占用');
  const temp = addTemp({
    code,
    displayName,
    password: String(body.password ?? '').trim() || newTempPassword(),
    ownerUid,
    days,
    shootContent: str(body.shootContent) ?? '',
    recycling: str(body.recycling) ?? '',
    flags: {
      preview: true,
      download: flags.download === undefined ? true : isTrue(flags.download),
      editTag: isTrue(flags.editTag),
    },
    albumIds,
    folderIds,
    spaceQuota: Number(body.spaceQuota ?? 1_073_741_824),
  });
  writeLog(
    actor,
    'temp_create',
    'temp',
    temp.tempId,
    `flags=${Object.entries(temp.flags).filter(([, v]) => v).map(([k]) => k).join(',')}, albums=${albumIds.join('|')}, days=${days}`,
    1,
  );
  return tempRow(temp);
}

export function updateTemp(id: number, body: Record<string, unknown>, actor: Actor): TempRow {
  requireReauth(requireLevel(actor, 3));
  const temp = TEMPS.find((t) => t.tempId === id);
  if (!temp) fail(404, 'NOT_FOUND', '临时账号不存在');
  const flags = body.flags as Partial<TempFlags> | undefined;
  if (flags) {
    // D27：传图／传文件两开关已作废，写档能力由身份决定，这里只回写剩下的三位
    for (const key of ['preview', 'download', 'editTag'] as const) {
      if (flags[key] !== undefined) temp.flags[key] = isTrue(flags[key]);
    }
  }
  if (Array.isArray(body.albumIds)) {
    temp.albumIds = body.albumIds.map(Number).filter((a) => ALBUMS.some((x) => x.id === a));
  }
  if (Array.isArray(body.folderIds)) {
    const kept = body.folderIds.map(Number).filter((f) => FOLDERS.some((x) => x.id === f));
    // 帐户 ID 目录是规则 3 的锚点，白名单怎么改都要留着它
    temp.folderIds = [...new Set([...kept, temp.taskFolderId])];
  }
  if (body.spaceQuota !== undefined) temp.spaceQuota = Math.max(0, Number(body.spaceQuota) || 0);
  if (body.displayName !== undefined) temp.displayName = String(body.displayName).trim() || temp.displayName;
  // 续期只加天数，不允许把已过期的链接「复活」成过去时间
  if (body.addDays !== undefined) {
    const add = Math.min(365, Math.max(-365, Number(body.addDays) || 0));
    const from = Math.max(Date.now(), new Date(temp.expiresAt).getTime());
    temp.expiresAt = new Date(from + add * 86_400_000).toISOString();
  }
  writeLog(actor, 'temp_update', 'temp', id, `expiresAt=${temp.expiresAt.slice(0, 10)}`, 1);
  return tempRow(temp);
}

export function deleteTemp(id: number, actor: Actor): { tempId: number; removed: true } {
  requireReauth(requireLevel(actor, 3));
  const temp = TEMPS.find((t) => t.tempId === id);
  if (!temp) fail(404, 'NOT_FOUND', '临时账号不存在');
  // 真接口还要写 Redis 黑名单让在手 JWT 立即失效，这里等价地把它从表里摘掉。
  // 帐户 ID 目录与里面的文件都不跟着删：注销只是关登录入口，已交付的内容要留凭证（规则 3）。
  TEMPS.splice(TEMPS.indexOf(temp), 1);
  writeLog(actor, 'temp_destroy', 'temp', id, `code=${temp.code}`, 1);
  return { tempId: id, removed: true };
}

// ---------------- 标签库 ----------------

type TagRow = AdminTagRow;

export function listTags(query: Record<string, unknown> | undefined, actor: Actor): TagRow[] {
  requireLevel(actor, 3);
  const rows = TAGS.map((t) => ({ id: t.id, type: t.type, name: t.name, useCount: tagUseCount(t.id) }));
  const type = str(query?.type);
  const kw = str(query?.keyword)?.trim().toLowerCase();
  return rows
    .filter((t) => !type || t.type === type)
    .filter((t) => !kw || t.name.toLowerCase().includes(kw))
    .sort((a, b) => b.useCount - a.useCount || a.name.localeCompare(b.name, 'zh'));
}

export function createTag(body: Record<string, unknown>, actor: Actor): TagRow {
  requireReauth(requireLevel(actor, 3));
  const type = String(body.type ?? '');
  const name = String(body.name ?? '').trim();
  if (!['event', 'coser', 'role', 'photographer', 'status'].includes(type)) {
    fail(400, 'TAG_TYPE_INVALID', '标签类型不合法');
  }
  if (!name) fail(400, 'VALIDATION_FAILED', '标签名不能为空');
  if (TAGS.some((t) => t.type === type && t.name === name)) fail(409, 'TAG_EXISTS', '同类型下已存在同名标签');
  const tag = { id: Math.max(0, ...TAGS.map((t) => t.id)) + 1, type, name } as (typeof TAGS)[number];
  TAGS.push(tag);
  writeLog(actor, 'tag_create', 'tag', tag.id, `type=${type}, name=${name}`, 1);
  return { id: tag.id, type: tag.type, name: tag.name, useCount: 0 };
}

export function renameTagRoute(id: number, body: Record<string, unknown>, actor: Actor): TagRow {
  requireReauth(requireLevel(actor, 3));
  const tag = TAGS.find((t) => t.id === id);
  if (!tag) fail(404, 'NOT_FOUND', '标签不存在');
  const name = String(body.name ?? '').trim();
  if (!name) fail(400, 'VALIDATION_FAILED', '标签名不能为空');
  if (TAGS.some((t) => t.id !== id && t.type === tag.type && t.name === name)) {
    fail(409, 'TAG_EXISTS', '同类型下已存在同名标签，请改用合并');
  }
  renameTag(id, name);
  writeLog(actor, 'tag_rename', 'tag', id, `name=${name}`, 1);
  return { id, type: tag.type, name, useCount: tagUseCount(id) };
}

export function mergeTags(fromId: number, body: Record<string, unknown>, actor: Actor): { fromId: number; toId: number; moved: number } {
  requireReauth(requireLevel(actor, 3));
  const from = TAGS.find((t) => t.id === fromId);
  const toId = Number(body.toId);
  const to = TAGS.find((t) => t.id === toId);
  if (!from || !to) fail(404, 'NOT_FOUND', '标签不存在');
  if (from.id === to.id) fail(400, 'SAME_TAG', '不能和自己合并');
  // 跨类型合并会毁掉筛选语义（PRD 4.6）
  if (from.type !== to.type) fail(409, 'TAG_TYPE_MISMATCH', '只能合并同类型标签');
  const moved = mergeTag(from.id, to.id);
  writeLog(actor, 'tag_merge', 'tag', to.id, `from=${from.id} to=${to.id}, moved=${moved}`, 1);
  return { fromId: from.id, toId: to.id, moved };
}

export function removeTag(id: number, actor: Actor): { id: number; cleaned: number } {
  requireReauth(requireLevel(actor, 3));
  if (!TAGS.some((t) => t.id === id)) fail(404, 'NOT_FOUND', '标签不存在');
  const cleaned = deleteTag(id);
  writeLog(actor, 'tag_delete', 'tag', id, `detached=${cleaned}`, 1);
  return { id, cleaned };
}

// ---------------- 相册功能开关（PRD 6.5，D25） ----------------

/**
 * 超管逐册关掉功能：入参 `capsOff` 是**整份替换**的「已关闭键」数组（空数组即全开），
 * 与 D21 的按人能力位是两条独立的轴——那一层管这个人能不能做，这一层管这本册让不让做。
 * 只收紧不放宽：这里只能关，没有把等级不允许的动作开到相册上的语义（PRD 6.5）。
 * 未知键一律 400，免得前端拼错一个键名就把一条限制静默丢掉。
 */
export function updateAlbumCaps(id: number, body: Record<string, unknown>, actor: Actor): AlbumRow {
  requireReauth(requireLevel(actor, 4));
  const album = ALBUMS.find((a) => a.id === id);
  if (!album) fail(404, 'NOT_FOUND', '相册不存在或无权查看');
  const raw = Array.isArray(body.capsOff) ? body.capsOff : null;
  if (!raw) fail(400, 'VALIDATION_FAILED', 'capsOff 必须是开关键数组（整份替换，空数组即全部打开）');

  const next: AlbumCapKey[] = [];
  for (const item of raw) {
    const key = item as AlbumCapKey;
    if (!ALBUM_CAP_KEYS.includes(key)) fail(400, 'VALIDATION_FAILED', `未知功能开关：${String(item)}`);
    if (!next.includes(key)) next.push(key);
  }
  album.albumCaps = next;

  writeLog(
    actor,
    'album_caps',
    'album',
    album.id,
    `off=${next.join(',') || '(none)'}, name=${album.name}`,
    1,
  );
  return albumRow(album);
}

// ---------------- 日志审计 ----------------

export function listLogs(query: Record<string, unknown> | undefined, actor: Actor): Page<MockLog> {
  requireLevel(actor, 3);
  // 审计列表按时间倒序（PRD 8.2），否则新写入的记录会插在种子数据中间
  let rows = LOGS.slice().sort((a, b) => b.createTime.localeCompare(a.createTime));
  const userType = str(query?.userType);
  if (userType) rows = rows.filter((l) => l.userType === userType);
  const uid = Number(query?.uid);
  if (uid) rows = rows.filter((l) => l.uid === uid);
  const action = str(query?.action);
  if (action) rows = rows.filter((l) => l.action === action);
  const result = query?.result === undefined ? NaN : Number(query.result);
  if (!Number.isNaN(result)) rows = rows.filter((l) => l.result === result);
  const from = str(query?.from);
  if (from) rows = rows.filter((l) => l.createTime.slice(0, 10) >= from);
  const to = str(query?.to);
  if (to) rows = rows.filter((l) => l.createTime.slice(0, 10) <= to);
  const kw = str(query?.keyword)?.trim().toLowerCase();
  if (kw) {
    rows = rows.filter((l) => `${l.action} ${l.targetType} ${l.detail} ${l.ip}`.toLowerCase().includes(kw));
  }
  return paged(rows, int(query?.page, 1), Math.min(200, int(query?.pageSize, 20)));
}

/** CSV 导出走 tables.ts 的转义，防公式注入（PRD 12.12） */
export function exportLogs(query: Record<string, unknown> | undefined, actor: Actor): { filename: string; csv: string } {
  requireLevel(actor, 3);
  const rows = listLogs({ ...query, page: 1, pageSize: 200 }, actor).list;
  const csv = toCsv(
    ['id', '时间', '身份', 'uid', 'tempId', '操作', '目标类型', '目标ID', '详情', 'IP', 'UA', '结果'],
    rows.map((l) => [l.id, l.createTime, l.userType, l.uid, l.tempId, l.action, l.targetType, l.targetId, l.detail, l.ip, l.ua, l.result === 1 ? '成功' : '拒绝']),
  );
  writeLog(actor, 'logs_export', 'log', null, `rows=${rows.length}`, 1);
  return { filename: `audit-${new Date().toISOString().slice(0, 10)}.csv`, csv };
}

// ---------------- 站点设置 ----------------

type SettingRow = AdminSettingRow;

const SETTING_GROUPS: [string, string][] = [
  ['upload.', '上传'],
  ['preview.', '派生图'],
  ['watermark.', '水印'],
  ['storage.', '存储与配额'],
  ['drive.', '网盘权限'],
  ['security.', '安全与限流'],
  ['site.', '站点信息'],
];

function groupOf(key: string): string {
  return SETTING_GROUPS.find(([prefix]) => key.startsWith(prefix))?.[1] ?? '其他';
}

export function listSettings(actor: Actor): SettingRow[] {
  requireLevel(actor, 3);
  return Object.entries(SETTINGS)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({
      key,
      value,
      group: groupOf(key),
      readOnlyNote:
        key.startsWith('site.') || key.startsWith('drive.')
          ? 'schema.sql 默认配置里没有这一族键，落库时再定稿'
          : undefined,
    }));
}

const NUMBER_KEYS = ['upload.max_image_size', 'upload.max_file_size', 'upload.chunk_size', 'preview.max_width', 'preview.thumb_width', 'preview.quality', 'storage.default_quota', 'watermark.opacity'];
/** 文件权限1~4：值是允许该操作的最低成员等级，填 5 等于这类目录谁都拿不到 */
const PERM_KEYS = ['drive.perm1_workspace', 'drive.perm2_manage', 'drive.perm3_shared', 'drive.perm4_personal'];
const BOOL_KEYS = ['watermark.enabled'];
const JSON_KEYS = ['upload.image_extensions', 'upload.file_extensions', 'upload.blocked_extensions', 'upload.rate_limit', 'security.session_ttl', 'site.contact'];

/** 单键类型校验，规则与后端的读取方式一致（数字/布尔/JSON 三类） */
function assertSettingValue(key: string, value: string): void {
  if (PERM_KEYS.includes(key)) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      fail(400, 'SETTING_TYPE_INVALID', `${key} 是最低等级，只能填 1~5（5 表示关闭）`);
    }
  }
  if (NUMBER_KEYS.includes(key)) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) fail(400, 'SETTING_TYPE_INVALID', `${key} 必须是非负数字`);
    if (key === 'preview.quality' && (n < 1 || n > 100)) fail(400, 'SETTING_TYPE_INVALID', 'quality 取值 1~100');
    if (key === 'watermark.opacity' && (n < 0.05 || n > 1)) fail(400, 'SETTING_TYPE_INVALID', 'opacity 取值 0.05~1');
  }
  if (BOOL_KEYS.includes(key) && !['true', 'false', '0', '1'].includes(value)) {
    fail(400, 'SETTING_TYPE_INVALID', `${key} 必须是布尔值`);
  }
  if (JSON_KEYS.includes(key)) {
    try {
      const parsed: unknown = JSON.parse(value);
      const expectArray = key.endsWith('_extensions') || key === 'site.contact';
      if (expectArray && !Array.isArray(parsed)) fail(400, 'SETTING_TYPE_INVALID', `${key} 必须是 JSON 数组`);
      if (key === 'site.contact') {
        const bad = (parsed as unknown[]).some(
          (item) => typeof (item as { value?: unknown })?.value !== 'string' || !(item as { value: string }).value.trim(),
        );
        if (bad) fail(400, 'SETTING_TYPE_INVALID', '每条联系方式都要有非空的 value');
      }
      if (!expectArray && typeof parsed !== 'number' && typeof parsed !== 'object') {
        fail(400, 'SETTING_TYPE_INVALID', `${key} 必须是 JSON 值`);
      }
    } catch {
      fail(400, 'SETTING_TYPE_INVALID', `${key} 不是合法 JSON`);
    }
  }
}

/** 仅 L4 可写（PRD 6.1「无权限修改核心配置」→ L3 只读）；按键族做类型校验，位置与文案按字符串读 */
export function updateSettings(body: Record<string, unknown>, actor: Actor): SettingRow[] {
  requireReauth(requireLevel(actor, 4));
  const patch = (body.settings ?? {}) as Record<string, unknown>;
  // 后端 setMany 是一次批量 save（全成或全不成），这里也先校验完整批再落表
  const checked: [string, string][] = Object.entries(patch).map(([key, raw]) => {
    if (!(key in SETTINGS)) fail(400, 'SETTING_UNKNOWN', `未知配置项：${key}`);
    const value = String(raw);
    assertSettingValue(key, value);
    return [key, value];
  });
  for (const [key, value] of checked) SETTINGS[key] = value;
  writeLog(actor, 'settings_update', 'setting', null, checked.map(([key]) => key).join(','), 1);
  return listSettings(actor);
}
