/**
 * 后端 common/permission/permission-policy.ts 的前端镜像，只服务于 mock 模式。
 * 真接口联调后这些判定全部由服务端做，前端只用 /auth/me 下发的 capabilities。
 * 保持一致是为了让「演示时看到的越权拦截」和真实后端的行为口径相同。
 */
import type { AlbumCapKey, CapKey, Capabilities, DriveGrant, FeatureGrant, TempFlags, Visibility } from '@/types/api';
import { ALBUM_CAP_LABEL, CAP_KEYS, CAP_LABEL, RESERVED_CAPS, UserLevel, VISIBILITY_RANK } from '@/types/api';

/**
 * 成员身份带「有效能力位」：等级默认值经 users.feature_grants 覆盖后的结果（PRD 6.4，D21）。
 * 判定读 caps，不看等级硬编码——超管按人关掉某一位，这里就当场拦得住。
 */
export type MemberActor = {
  kind: 'member';
  uid: number;
  username: string;
  nickname: string;
  level: UserLevel;
  caps: Capabilities;
  /** 超管逐项覆盖的原始记录，缺键 = 跟随等级（回显「非默认」时用它与默认值比） */
  featureGrant: FeatureGrant;
};

export type Actor =
  | MemberActor
  | { kind: 'guest' }
  | {
      kind: 'temp';
      tempId: number;
      displayName: string;
      ownerUid: number;
      expiresAt: string;
      flags: TempFlags;
      albumIds: number[];
      folderIds: number[];
    }
  | { kind: 'share'; shareId: number; imageIds: number[]; allowDownload: boolean };

export const Action = {
  Preview: 'Preview',
  DownloadOriginal: 'DownloadOriginal',
  ZipDownload: 'ZipDownload',
  Upload: 'Upload',
  EditMeta: 'EditMeta',
  EditTags: 'EditTags',
  ChangeVisibility: 'ChangeVisibility',
  Delete: 'Delete',
  CreateShareLink: 'CreateShareLink',
} as const;

export type ActionName = (typeof Action)[keyof typeof Action];

type Scope = 'none' | 'own' | 'any';

/** PRD 7.2 等级 × 操作矩阵——D21 之后它只是**能力位的等级默认值来源**，不再是终局判定 */
const RESOURCE_MATRIX: Record<ActionName, Record<number, Scope>> = {
  [Action.Preview]: { 1: 'any', 2: 'any', 3: 'any', 4: 'any' },
  [Action.DownloadOriginal]: { 1: 'none', 2: 'any', 3: 'any', 4: 'any' },
  [Action.ZipDownload]: { 1: 'none', 2: 'any', 3: 'any', 4: 'any' },
  [Action.Upload]: { 1: 'any', 2: 'any', 3: 'any', 4: 'any' },
  [Action.EditMeta]: { 1: 'own', 2: 'own', 3: 'any', 4: 'any' },
  [Action.EditTags]: { 1: 'own', 2: 'own', 3: 'any', 4: 'any' },
  [Action.ChangeVisibility]: { 1: 'own', 2: 'own', 3: 'any', 4: 'any' },
  [Action.Delete]: { 1: 'none', 2: 'own', 3: 'any', 4: 'any' },
  [Action.CreateShareLink]: { 1: 'none', 2: 'own', 3: 'any', 4: 'any' },
};

/** PRD 7.2 可见性闸门的档位上限（private 由「本人」额外放行） */
const VISIBLE_MAX_RANK: Record<number, number> = { 1: 2, 2: 2, 3: 3, 4: 4 };

export const ALL_VISIBILITIES: Visibility[] = ['public', 'member', 'admin', 'private'];

export function visibleVisibilities(level: UserLevel): Visibility[] {
  const max = VISIBLE_MAX_RANK[level];
  return ALL_VISIBILITIES.filter((v) => VISIBILITY_RANK[v] <= max);
}

export interface ResourceRef {
  type: 'album' | 'image';
  id: number;
  visibility: Visibility;
  ownerId?: number | null;
  albumId?: number;
  uploadTempId?: number | null;
  /** 上级档位，图片继承相册 */
  containerVisibilities?: Visibility[];
  /**
   * D25：本资源所属相册「当前被关闭」的功能开关，含父册继承（父关子也关，PRD 6.5）。
   * 由 shared.ts 沿祖先链算好后传入，判定层只读这一份，不自己走树。
   */
  albumCaps?: AlbumCapKey[];
}

export interface Decision {
  allowed: boolean;
  status: number;
  reason: string;
  message: string;
}

const ALLOW: Decision = { allowed: true, status: 200, reason: 'OK', message: '' };

function deny(status: number, reason: string, message: string): Decision {
  return { allowed: false, status, reason, message };
}

/** 子资源档位不得宽于上级（PRD 3.2） */
export function checkInheritance(child: Visibility, parents: Visibility[]): Decision {
  const tooLoose = parents.find((p) => VISIBILITY_RANK[child] < VISIBILITY_RANK[p]);
  if (tooLoose) {
    return deny(409, 'INHERITANCE_VIOLATION', `子资源权限不得宽于上级（上级为 ${tooLoose}）`);
  }
  return ALLOW;
}

/** L1 可建相册但不可设为公开（对外发布需 L2+，PRD 6.1）——这只是 `canSetPublic` 位的等级默认值 */
function levelCanPublish(level: UserLevel): boolean {
  return level >= UserLevel.Member;
}

/**
 * 对外发布（把资源档位设成 public）读 `canSetPublic` 能力位而不是等级：
 * 超管按人强制开就给，强制关则连 L4 自己也拦（PRD 6.4「收紧一定拦得住」）。
 */
export function canSetPublic(actor: MemberActor, target: Visibility): boolean {
  return target !== 'public' || actor.caps.canSetPublic;
}

export function effectiveVisibility(resource: ResourceRef): Visibility {
  let v = resource.visibility;
  for (const parent of resource.containerVisibilities ?? []) {
    if (VISIBILITY_RANK[parent] > VISIBILITY_RANK[v]) v = parent;
  }
  return v;
}

/**
 * 动作 → 能力位（PRD 6.4）。Preview 不设位：看得见就能预览。
 * `editOwn` 那一行与 `editAny` 取并集——只开「编辑他人」时本人资源当然也能编。
 */
const ACTION_CAP: Partial<Record<ActionName, CapKey>> = {
  [Action.DownloadOriginal]: 'download',
  [Action.ZipDownload]: 'zip',
  [Action.Upload]: 'upload',
  [Action.EditMeta]: 'editOwn',
  [Action.EditTags]: 'editOwn',
  [Action.ChangeVisibility]: 'changeVisibility',
  [Action.Delete]: 'delete',
  [Action.CreateShareLink]: 'shareLink',
};

/**
 * 受「归属范围」约束的动作（7.2 里那些「仅自有」的写操作）。
 * 上传与下载不看归属：上传的闸门是目标可写性与档位（3.2 / 5.4），下载按可见性判定。
 */
const OWNERSHIP_SCOPED: ActionName[] = [
  Action.EditMeta,
  Action.EditTags,
  Action.ChangeVisibility,
  Action.Delete,
  Action.CreateShareLink,
];

/**
 * D25 相册级功能开关（PRD 6.5）：动作 → 受哪个册内开关键约束。
 * 与 6.4 的按人能力位是两条独立的轴，同一次操作要两道都放行（AND）；
 * 这一层**只收紧不放宽**，所以只有「关掉就拦」的分支，没有强制开的语义。
 * Preview 不在表里：预览受档位闸门管，开关不负责把相册藏起来。
 */
const ACTION_ALBUM_CAP: Partial<Record<ActionName, AlbumCapKey>> = {
  [Action.DownloadOriginal]: 'download',
  [Action.ZipDownload]: 'zip',
  [Action.Upload]: 'upload',
  [Action.EditMeta]: 'editTag',
  [Action.EditTags]: 'editTag',
  [Action.ChangeVisibility]: 'changeVisibility',
  [Action.Delete]: 'delete',
  [Action.CreateShareLink]: 'shareLink',
};

/**
 * 作用在相册行本身上的这几项属于「相册管理」，不受册内开关约束：
 * 否则关掉「删除图片」会把超管自己锁在相册外面，连改档、改名都做不了（PRD 6.5）。
 * 同一个动作落在图片上（ref.type === 'image'）时照常拦，两者靠 ref.type 区分。
 */
const ALBUM_SELF_MANAGED: ActionName[] = [Action.EditMeta, Action.ChangeVisibility, Action.Delete];

/** 相册级开关闸门：命中「关闭」返回拒绝，否则返回 null 交回上层继续判 */
function albumCapsGate(action: ActionName, ref: ResourceRef): Decision | null {
  const key = ACTION_ALBUM_CAP[action];
  if (!key) return null;
  if (ref.type === 'album' && ALBUM_SELF_MANAGED.includes(action)) return null;
  if (!ref.albumCaps?.includes(key)) return null;
  return deny(403, 'ALBUM_CAP_CLOSED', `「${ALBUM_CAP_LABEL[key]}」已被超管在本相册关闭`);
}

type CapGate = { allowed: true; scope: Scope } | { allowed: false; reason: string; message: string };

/** 该能力位对这个身份是否生效（「编辑自有」可被「编辑他人」覆盖） */
function capOn(caps: Capabilities, key: CapKey): boolean {
  return caps[key] || (key === 'editOwn' && caps.editAny);
}

/**
 * 7.1 的第 2、3 步：有效能力位决定动作能不能做，`editAny` 单独决定归属范围。
 * 关掉 editAny 就把自己那几项退回「仅自有」，所以 own/any 不再从等级矩阵读（6.4）。
 */
function capGate(actor: MemberActor, action: ActionName): CapGate {
  const key = ACTION_CAP[action];
  if (!key) return { allowed: true, scope: 'any' };
  if (!capOn(actor.caps, key)) {
    // 等级本来就不给 → 沿用 LEVEL_FORBIDDEN；等级给、被超管单独关掉 → CAP_DISABLED（7.2 的码位分工）
    const denied = capOn(capabilitiesOfLevel(actor.level), key);
    return denied
      ? { allowed: false, reason: 'CAP_DISABLED', message: `「${CAP_LABEL[key]}」已被超管单独关闭` }
      : { allowed: false, reason: 'LEVEL_FORBIDDEN', message: '当前成员等级无权执行该操作' };
  }
  const scoped = OWNERSHIP_SCOPED.includes(action);
  return { allowed: true, scope: scoped && !actor.caps.editAny ? 'own' : 'any' };
}

function decideMember(actor: MemberActor, action: ActionName, ref: ResourceRef): Decision {
  // 第 1 步：档位可见性只认等级，个人授权不能把人送进更高的档（PRD 6.4）
  const visible =
    actor.level === 4 ||
    VISIBILITY_RANK[effectiveVisibility(ref)] <= VISIBLE_MAX_RANK[actor.level] ||
    (ref.visibility === 'private' && ref.ownerId === actor.uid);
  // 看不见 = 404，不用 403 泄露存在性（PRD 12.5）
  if (!visible) return deny(404, 'NOT_FOUND', '资源不存在或无权查看');

  // 第 2 步：资源级（本相册）开关，先于按人能力位——册子被超管关了这门，谁都进不来（PRD 6.5 / 7.1）
  const closed = albumCapsGate(action, ref);
  if (closed) return closed;

  const gate = capGate(actor, action);
  if (!gate.allowed) return deny(403, gate.reason, gate.message);
  if (gate.scope === 'own' && ref.ownerId !== actor.uid) return deny(403, 'NOT_OWNER', '只能操作本人上传的资源');
  return ALLOW;
}

function decideGuest(action: ActionName, ref: ResourceRef): Decision {
  if (effectiveVisibility(ref) !== 'public') return deny(404, 'NOT_FOUND', '资源不存在或无权查看');
  if (action !== Action.Preview) return deny(403, 'GUEST_FORBIDDEN', '游客仅可预览，禁止下载与任何写操作');
  return ALLOW;
}

function decideTemp(actor: Extract<Actor, { kind: 'temp' }>, action: ActionName, ref: ResourceRef): Decision {
  const target = ref.type === 'album' ? ref.id : ref.albumId;
  // 本册关掉「临时账号访问」时与不在白名单同码同文案：关掉这件事本身也不能被枚举出来（PRD 6.5）
  if (ref.albumCaps?.includes('tempAccess')) {
    return deny(404, 'NOT_IN_WHITELIST', '该资源不在临时账号授权范围内');
  }
  if (target === undefined || !actor.albumIds.includes(target)) {
    return deny(404, 'NOT_IN_WHITELIST', '该资源不在临时账号授权范围内');
  }
  // 白名单即授权，可覆盖档位（PRD 6.2）：这里不再复查 visibility，与 server 的 decideTemp 同口径
  // 其余册内开关对临时账号同样生效：白名单给的是「能进这本册」，不是里面每扇门都开
  const closed = albumCapsGate(action, ref);
  if (closed) return closed;
  // D27：拍展传图入口收回到正式成员——临时账号是只读的取图方，「传图」不再由开关授予
  if (action === Action.Upload) {
    return deny(403, 'TEMP_UPLOAD_FORBIDDEN', '临时账号只能取图，不能上传照片或文件');
  }
  const forbidden: ActionName[] = [
    Action.EditMeta,
    Action.Delete,
    Action.ChangeVisibility,
    Action.CreateShareLink,
  ];
  if (forbidden.includes(action)) {
    return deny(403, 'TEMP_FORBIDDEN', '临时账号仅可预览、下载与编辑本人上传资源的标签');
  }
  const switchOn = (() => {
    switch (action) {
      case Action.Preview:
        return actor.flags.preview;
      case Action.DownloadOriginal:
      case Action.ZipDownload:
        return actor.flags.download;
      case Action.EditTags:
        return actor.flags.editTag;
      default:
        return false;
    }
  })();
  if (!switchOn) return deny(403, 'TEMP_SWITCH_OFF', '临时账号未开通该权限开关');
  if (action === Action.EditTags && ref.uploadTempId !== actor.tempId) {
    return deny(403, 'TEMP_NOT_SELF_UPLOAD', '只能编辑本人本次上传资源的标签');
  }
  return ALLOW;
}

/**
 * 分享访客只按链接自己的口径判（快照 + allowDownload + 密码），
 * 不回查相册级开关：D25 关掉「建返图链接」只拦新建，已发出去的链接不追溯收回，
 * 与 D20「撤销个人授权不回收已建目录」同向——coser 手上那张链接不该因为内部改配置而突然打不开。
 */
function decideShare(actor: Extract<Actor, { kind: 'share' }>, action: ActionName, ref: ResourceRef): Decision {
  if (ref.type !== 'image' || !actor.imageIds.includes(ref.id)) {
    return deny(404, 'NOT_FOUND', '该图片不在分享链接范围内');
  }
  if (action === Action.Preview) return ALLOW;
  if (action === Action.DownloadOriginal || action === Action.ZipDownload) {
    return actor.allowDownload ? ALLOW : deny(403, 'SHARE_DOWNLOAD_OFF', '该分享链接未开放原图下载');
  }
  return deny(403, 'SHARE_READONLY', '分享链接仅支持浏览与下载');
}

export function decide(action: ActionName, actor: Actor, ref: ResourceRef): Decision {
  switch (actor.kind) {
    case 'member':
      return decideMember(actor, action, ref);
    case 'guest':
      return decideGuest(action, ref);
    case 'temp':
      return decideTemp(actor, action, ref);
    default:
      return decideShare(actor, action, ref);
  }
}

/** 能力位的等级默认值（PRD 6.4 那张表就是这一列）；前端只认这组位，不再自己抄规则 */
function capabilitiesOfLevel(level: UserLevel): Capabilities {
  const scope = (action: ActionName) => RESOURCE_MATRIX[action][level];
  return {
    download: scope(Action.DownloadOriginal) !== 'none',
    zip: scope(Action.ZipDownload) !== 'none',
    upload: scope(Action.Upload) !== 'none',
    editOwn: scope(Action.EditMeta) !== 'none',
    editAny: scope(Action.EditMeta) === 'any',
    delete: scope(Action.Delete) !== 'none',
    changeVisibility: scope(Action.ChangeVisibility) !== 'none',
    canSetPublic: levelCanPublish(level),
    shareLink: scope(Action.CreateShareLink) !== 'none',
    adminConsole: level >= 3,
    writeSiteSettings: level >= 4,
  };
}

/**
 * 有效能力位 = 等级默认值 + 超管的按人覆盖（PRD 6.4，D21）。
 * 「强制关」优先于默认值，L4 给自己关也拦；「强制开」只放动作，不放档位可见性。
 * 脏数据一律 fail-closed：取值不认识就忽略，保留位开不到 L1–L3 头上。
 */
export function capabilitiesFor(level: UserLevel, grant?: FeatureGrant): Capabilities {
  const base = capabilitiesOfLevel(level);
  if (!grant) return base;
  const out: Capabilities = { ...base };
  for (const key of CAP_KEYS) {
    const mode = grant[key];
    if (mode !== 'on' && mode !== 'off') continue;
    if (mode === 'on' && RESERVED_CAPS.includes(key) && level < UserLevel.SuperAdmin) continue;
    out[key] = mode === 'on';
  }
  return out;
}

/** 被个人授权改掉了等级默认值的那几位——界面据此标「非默认」，别被误当成等级自带权限 */
export function overriddenCaps(level: UserLevel, grant?: FeatureGrant): CapKey[] {
  if (!grant) return [];
  const base = capabilitiesOfLevel(level);
  const effective = capabilitiesFor(level, grant);
  return CAP_KEYS.filter((key) => base[key] !== effective[key]);
}

/**
 * 由成员行推导身份：能力位每次请求现取，不进令牌（PRD 6.4「改完最迟 60 秒全站生效」）。
 * 真接口换成守卫里的 `users.feature_grants` 读取，形状不变。
 */
export function memberActorOf(src: {
  uid: number;
  username: string;
  nickname: string;
  level: UserLevel;
  featureGrant?: FeatureGrant;
}): MemberActor {
  const grant = src.featureGrant ?? {};
  return {
    kind: 'member',
    uid: src.uid,
    username: src.username,
    nickname: src.nickname,
    level: src.level,
    featureGrant: grant,
    caps: capabilitiesFor(src.level, grant),
  };
}

export function hidesStatusTags(actor: Actor): boolean {
  return actor.kind !== 'member';
}

/** PRD 6.2 / 6.3：临时去掉内部 status；游客与分享访客只给漫展和角色 */
export function visibleTagTypes(actor: Actor): string[] {
  if (actor.kind === 'member') return ['event', 'coser', 'role', 'photographer', 'status'];
  if (actor.kind === 'temp') return ['event', 'coser', 'role', 'photographer'];
  return ['event', 'role'];
}

// ---------------- 网盘目录权限（手绘稿的 12 条规则 ＋ 规则 13 超管给个人开权限） ----------------

/**
 * 目录用途。kind 是网盘规则的唯一入口：一条规则只对应一个分支，页面不再按目录名特判。
 * 这里刻意不看 folders.visibility——档位闸门是给相册／图片用的（PRD 7.2），
 * 网盘改由「文件权限1~4」定门槛后两套闸门会打架：L3 管理员的私人文件夹按档位看不见，
 * 但规则 6 要求他拥有它。visibility 字段保留，只作展示与落库兼容。
 */
export const FolderKind = {
  /** 「工作室」：规则 2，需文件权限1 才能读取／上传／改动 */
  Workspace: 'workspace',
  /** 「拍展」：规则 3，列表里不显示，每个游客账户 ID 一个子文件夹 */
  Shoot: 'shoot',
  /** 「管理」：规则 4，位于管理员与超管之间，需文件权限2 */
  Manage: 'manage',
  /** 个人共享文件夹：规则 1/5 需文件权限3，规则 9 对他人只给读与下载 */
  Shared: 'shared',
  /** 私人文件夹：规则 6 由文件权限4 决定是否拥有，规则 8 超管删这里直接彻底删除 */
  Personal: 'personal',
  /** 「爬虫」：规则 11，挂在超管私人文件夹下，按时间建子目录放线上取回的文件 */
  Crawler: 'crawler',
  /** 垃圾箱：规则 7/12，删除先进这里，只有超管能读取和更改 */
  Trash: 'trash',
} as const;

export type FolderKind = (typeof FolderKind)[keyof typeof FolderKind];

/** 文件权限1~4：站点设置 drive.perm* 里的最低等级门槛 */
export interface DriveGates {
  perm1: number;
  perm2: number;
  perm3: number;
  perm4: number;
}

export interface FolderRef {
  id: number;
  kind: FolderKind;
  /** 归属人：共享／私人／拍展／爬虫目录的属主 uid，公共目录为 null */
  ownerUid: number | null;
}

export interface FolderPerms {
  read: boolean;
  download: boolean;
  upload: boolean;
  /** 改名、移动、建子目录 */
  modify: boolean;
  /** 移进垃圾箱（规则 7） */
  remove: boolean;
  /** 就地彻底删除：垃圾箱里的清除，以及超管的私人目录（规则 8/12） */
  purge: boolean;
}

const NO_ACCESS: FolderPerms = {
  read: false,
  download: false,
  upload: false,
  modify: false,
  remove: false,
  purge: false,
};

const grant = (over: Partial<FolderPerms>): FolderPerms => ({ ...NO_ACCESS, ...over });

const FULL: FolderPerms = grant({
  read: true,
  download: true,
  upload: true,
  modify: true,
  remove: true,
  purge: true,
});

/** 规则 3：拍展整棵子树不在目录列表里出现，靠游客账户 ID 子文件夹定位 */
export function hiddenFolderKind(kind: FolderKind): boolean {
  return kind === FolderKind.Shoot;
}

export interface FolderPermContext {
  gates: DriveGates;
  /** 临时账号的授权级联（PRD 5.5）由调用方按祖先链算好传进来，这里不碰树 */
  tempWhitelisted?: boolean;
  /** 超管单独开给这个人的文件权限档（规则 13）：开一档就绕过那一档的等级门槛 */
  grants?: DriveGrant;
}

/**
 * 规则 13：某一档文件权限对这个成员是否生效——等级够门槛，或被超管单独开过。
 * 个人授权凌驾于门槛之上，连「填 5 = 对所有人关闭」也能只对一个人敞开。
 * 垃圾箱（规则 12）与爬虫（规则 11）不走这条判定，仍只认超管。
 */
export function driveGateOpen(level: UserLevel, gate: number, granted: boolean | undefined): boolean {
  return level >= gate || !!granted;
}

/**
 * 网盘的目录档闸门（规则 1~13）。相册／图片仍走上面的 decide()，两者规则不同源，
 * 强行塞进同一张等级×操作矩阵会让规则 9 那种「他人只读」没法表达。
 */
export function folderGatePerms(actor: Actor, folder: FolderRef, ctx: FolderPermContext): FolderPerms {
  if (actor.kind === 'guest') return NO_ACCESS;
  if (actor.kind === 'share') return NO_ACCESS;

  if (actor.kind === 'temp') {
    if (!ctx.tempWhitelisted) return NO_ACCESS;
    // 白名单命中后只按开关给读／下，D27 起写档一律不给：传文件由身份决定，不看开关
    return grant({
      read: actor.flags.preview,
      download: actor.flags.download,
    });
  }

  const gates = ctx.gates;
  const isSuper = actor.level === UserLevel.SuperAdmin;
  const isOwner = folder.ownerUid !== null && folder.ownerUid === actor.uid;
  const opened = (gate: number, key: keyof DriveGrant): boolean =>
    driveGateOpen(actor.level, gate, ctx.grants?.[key]);

  switch (folder.kind) {
    case FolderKind.Trash:
      // 垃圾箱只能被超管读取和更改；往里传文件没有意义，upload 一律关
      return isSuper ? grant({ read: true, modify: true, remove: true, purge: true }) : NO_ACCESS;

    case FolderKind.Crawler:
      return isSuper ? FULL : NO_ACCESS;

    case FolderKind.Personal:
      // 规则 6：够不够文件权限4 决定这个管理员有没有私人文件夹，别人的进不来
      if (!isOwner || !opened(gates.perm4, 'perm4')) return NO_ACCESS;
      // 规则 8：超管在这里删除即彻底删除，不再经过垃圾箱
      return grant({
        read: true,
        download: true,
        upload: true,
        modify: true,
        remove: true,
        purge: isSuper,
      });

    case FolderKind.Shared:
      // 规则 5：成员及以上才拿得到共享文件夹
      if (!opened(gates.perm3, 'perm3')) return NO_ACCESS;
      // 规则 9：他人对自己的共享文件夹只读、只下载，改不了也传不了
      return isOwner
        ? grant({ read: true, download: true, upload: true, modify: true, remove: true })
        : grant({ read: true, download: true });

    case FolderKind.Manage:
      if (!opened(gates.perm2, 'perm2')) return NO_ACCESS;
      return grant({ read: true, download: true, upload: true, modify: true, remove: true });

    case FolderKind.Shoot:
      if (!opened(gates.perm1, 'perm1')) return NO_ACCESS;
      return isOwner || isSuper
        ? grant({ read: true, download: true, upload: true, modify: true, remove: true })
        : grant({ read: true, download: true });

    case FolderKind.Workspace:
    default:
      // 规则 2
      if (!opened(gates.perm1, 'perm1')) return NO_ACCESS;
      return grant({ read: true, download: true, upload: true, modify: true, remove: true });
  }
}

/**
 * 网盘最终能力位 = 目录档闸门 **AND** 有效能力位（PRD 6.4「与 D20 的分工」）。
 * 进得来某个目录不代表能下载里面的东西：`drive_perm*` 管门，`download`／`upload`／`delete`
 * 三位管手上的动作，超管按人关掉任意一位，这里就少一位——15 章 case 35 逐条对着验。
 * `modify`（改名／移动／建子目录）留在目录轴上：它是规则 9「谁的目录谁能改」，
 * 不属于 6.4 那 11 个能力位，硬挂到 editAny 上反而会让别人的只读目录被开一个口子。
 */
export function folderPerms(actor: Actor, folder: FolderRef, ctx: FolderPermContext): FolderPerms {
  const gate = folderGatePerms(actor, folder, ctx);
  if (actor.kind !== 'member') return gate;
  return {
    ...gate,
    download: gate.download && actor.caps.download,
    upload: gate.upload && actor.caps.upload,
    remove: gate.remove && actor.caps.delete,
    purge: gate.purge && actor.caps.delete,
  };
}
