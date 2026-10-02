/**
 * 临时账号的任务流（手绘稿 20 / 22 / 23）：注册页建账号，任务列表与任务管理读同一张表。
 * 与后台的 /admin/temp-accounts 分开写：那边是管理员的全量台账（L3 起），
 * 这边是「谁登记的账号谁跟」的任务视角（L2 起，L3 才能看别人的），两边都落到 db.addTemp，
 * 所以规则 3 的帐户 ID 目录不会只在某一条路径上才长出来。
 * 状态 chips（前期未完成 / 后期未完成 / 全部已完成…）在前台本地筛：一行数据要同时被几把尺子计数，
 * 做成查询参数就得把同一份判定在服务端再写一遍。
 */
import type { TempTaskRow } from '@/types/api';
import { UserLevel } from '@/types/api';
import { FOLDERS, FILES, folderById } from './tables';
import { TEMPS, USERS, addTemp, nextAccountCode } from './db';
import type { MockTemp } from './db';
import type { Actor } from './policy';
import { fail, int, isTrue, requireMember, requireLevel, str } from './shared';

/** 游客一律不给传文件（网盘上传），只有看图、传图、打标签的权限由开关控制 */
const REGISTER_FLAGS = { preview: true, download: true, uploadImg: true, uploadFile: false, editTag: false };

/** 剩余天数按向上取整给「还剩几天」的观感；到期与否直接比时刻——最后一天取整会得到 -0，用 < 0 判不出来 */
function remaining(expiresAt: string): { daysLeft: number; expired: boolean } {
  const delta = new Date(expiresAt).getTime() - Date.now();
  return { daysLeft: Math.max(0, Math.ceil(delta / 86_400_000)), expired: delta < 0 };
}

/** 帐户 ID 目录（含子目录）里的现存文件数，垃圾箱里的不算交付 */
function deliveredCount(folderId: number): number {
  const folder = folderById(folderId);
  if (!folder) return 0;
  const ids = new Set(FOLDERS.filter((f) => f.path.startsWith(folder.path)).map((f) => f.id));
  return FILES.filter((f) => f.deletedAt === null && ids.has(f.folderId)).length;
}

function taskRow(temp: MockTemp): TempTaskRow {
  const owner = USERS.find((u) => u.uid === temp.ownerUid);
  const folder = folderById(temp.taskFolderId);
  const left = remaining(temp.expiresAt);
  return {
    tempId: temp.tempId,
    code: temp.code,
    displayName: temp.displayName,
    ownerUid: temp.ownerUid,
    ownerName: owner?.nickname ?? `uid=${temp.ownerUid}`,
    ownerPosition: owner?.position ?? '',
    shootContent: temp.shootContent,
    recycling: temp.recycling,
    stage1: temp.stage1,
    stage2: temp.stage2,
    taskFolderId: temp.taskFolderId,
    taskFolderName: folder?.name ?? temp.code,
    fileCount: deliveredCount(temp.taskFolderId),
    usedSpace: temp.usedSpace,
    spaceQuota: temp.spaceQuota,
    expiresAt: temp.expiresAt,
    daysLeft: left.daysLeft,
    expired: left.expired,
    flags: temp.flags,
    createTime: temp.createTime,
  };
}

/** L1/L2 只看自己登记的，L3 起才管得着别人的任务 */
function scopedTemps(actor: Actor, scope: string | undefined): MockTemp[] {
  const member = requireMember(actor);
  if (scope === 'all' && member.level >= UserLevel.Admin) return [...TEMPS];
  return TEMPS.filter((t) => t.ownerUid === member.uid);
}

/**
 * D9 的时长上限：L1/L2 开号只有 7 天，L3/L4 沿用注册页的 365 天天花板。
 * 后端 6.2 的 `MAX_DAYS_FOR_ADMIN` 是 30 天，两边口径没并上，等 M3 联调时一起收。
 */
function maxDaysFor(level: UserLevel): number {
  return level < UserLevel.Admin ? 7 : 365;
}

/** 换一个：帐户ID 必须唯一，它同时是规则 3 的目录名，撞号就会把两批返图混进同一棵目录；顺带下发本身份的时长上限 */
export function peekAccountCode(actor: Actor): { code: string; maxDays: number } {
  const member = requireMember(actor);
  return { code: nextAccountCode(), maxDays: maxDaysFor(member.level) };
}

export function registerTemp(body: Record<string, unknown>, actor: Actor): TempTaskRow {
  const member = requireMember(actor);
  const code = str(body.code)?.trim().toUpperCase();
  if (!code) fail(400, 'VALIDATION_FAILED', '帐户ID不能为空');
  if (!/^[A-Z0-9][A-Z0-9-]{3,23}$/.test(code)) {
    fail(400, 'INVALID_ACCOUNT_CODE', '帐户ID 只能是大写字母、数字与短横线，4~24 位');
  }
  if (TEMPS.some((t) => t.code === code)) fail(409, 'TEMP_CODE_TAKEN', '这个帐户ID 已被占用，点「换一个」再试');
  const password = str(body.password) ?? '';
  if (password.length < 6) fail(400, 'WEAK_PASSWORD', '登录密码至少 6 位');

  // PRD 6.2：L1/L2 创建的账号强制降权——时长 ≤7 天、禁 uploadFile/editTag、配额取默认值；
  // download 保持开启：取图功能的核心就是让临时账户下载属于自己的返图
  const isTrainee = member.level < UserLevel.Admin; // L1 或 L2
  const DEFAULT_QUOTA = 1_073_741_824; // 1GB，站点 temp.default_quota 的默认值

  const days = Math.min(maxDaysFor(member.level), Math.max(1, int(body.days, 14)));
  const flags: typeof REGISTER_FLAGS = isTrainee
    ? { preview: true, download: true, uploadImg: true, uploadFile: false, editTag: false }
    : { ...REGISTER_FLAGS };
  const spaceQuota = isTrainee ? DEFAULT_QUOTA : Number(body.spaceQuota ?? DEFAULT_QUOTA);

  const temp = addTemp({
    code,
    // 画里没有「显示名」这一栏，对外就报帐户ID
    displayName: code,
    password,
    ownerUid: member.uid,
    days,
    shootContent: str(body.shootContent) ?? '',
    recycling: str(body.recycling) ?? '',
    flags,
    albumIds: [],
    folderIds: [],
    spaceQuota,
  });
  return taskRow(temp);
}

export function listTasks(query: Record<string, unknown> | undefined, actor: Actor): TempTaskRow[] {
  const rows = scopedTemps(actor, str(query?.scope)).map(taskRow);
  const kw = str(query?.keyword)?.trim().toLowerCase();
  const filtered = kw
    ? rows.filter((r) => `${r.code} ${r.displayName} ${r.shootContent}`.toLowerCase().includes(kw))
    : rows;
  // 手绘稿 23 的排序尺子就是「时间 + 递增/递减」，默认按登记先后
  const desc = str(query?.sort) === 'desc';
  return filtered.sort((a, b) => (desc ? b.createTime.localeCompare(a.createTime) : a.createTime.localeCompare(b.createTime)));
}

/** 前期 / 后期返图的完成标记：手动勾，传过图不等于交完；owner 即可跟进自己的任务 */
export function setTaskStage(tempId: number, body: Record<string, unknown>, actor: Actor): TempTaskRow {
  const member = requireMember(actor);
  const temp = TEMPS.find((t) => t.tempId === tempId);
  if (!temp) fail(404, 'NOT_FOUND', '临时账号不存在');
  if (temp.ownerUid !== member.uid && member.level < UserLevel.Admin) {
    fail(403, 'LEVEL_FORBIDDEN', '只能跟进自己登记的临时账号任务');
  }
  const stage = Number(body.stage);
  if (stage !== 1 && stage !== 2) fail(400, 'VALIDATION_FAILED', '阶段只能是前期或后期');
  const flag = `stage${stage}` as 'stage1' | 'stage2';
  temp[flag] = isTrue(body.done) ? 1 : 0;
  return taskRow(temp);
}
