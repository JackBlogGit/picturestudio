/**
 * 与 server 响应契约一一对齐的前端类型。
 * 对照文件：common/http/response-envelope.interceptor.ts、common/http/pagination.ts、
 * modules/image/image-shape.ts、modules/auth/auth.service.ts、common/permission/permission-policy.ts
 * 改后端形状时这里必须同步。
 */

export type Visibility = 'public' | 'member' | 'admin' | 'private';

export type TagType = 'event' | 'coser' | 'role' | 'photographer' | 'status';

export const VISIBILITY_RANK: Record<Visibility, number> = {
  public: 1,
  member: 2,
  admin: 3,
  private: 4,
};

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  public: '公开',
  member: '成员可见',
  admin: '仅管理员',
  private: '私有',
};

export const TAG_TYPE_LABEL: Record<TagType, string> = {
  event: '漫展',
  coser: 'Coser',
  role: '角色',
  photographer: '摄影',
  status: '状态',
};

/** 用 as const 而不是 const enum：Vite 逐文件转译，跨文件内联不了 const enum 的成员值 */
export const AlbumStatus = {
  Normal: 1,
  Archived: 2,
  Locked: 3,
} as const;

export type AlbumStatus = (typeof AlbumStatus)[keyof typeof AlbumStatus];

export const ALBUM_STATUS_LABEL: Record<AlbumStatus, string> = {
  [AlbumStatus.Normal]: '正常',
  [AlbumStatus.Archived]: '已归档',
  [AlbumStatus.Locked]: '已锁定',
};

/** 相册所属阶段：前期 = 拍展/原片，后期 = 精修/交付 */
export type AlbumStage = 'pre' | 'post';

export const STAGE_LABEL: Record<AlbumStage, string> = {
  pre: '前期',
  post: '后期',
};

/**
 * 相册级功能开关（PRD 6.5，D25）：超管在相册后台逐册关掉某个动作。
 * 只收紧不放宽——关掉一定拦得住，打开也只是回到等级与能力位的原有判定。
 * 键序即弹窗渲染顺序。
 */
export const AlbumCapKey = {
  Upload: 'upload',
  EditTag: 'editTag',
  ChangeVisibility: 'changeVisibility',
  Download: 'download',
  Zip: 'zip',
  ShareLink: 'shareLink',
  Delete: 'delete',
  TempAccess: 'tempAccess',
} as const;

export type AlbumCapKey = (typeof AlbumCapKey)[keyof typeof AlbumCapKey];

export const ALBUM_CAP_KEYS: AlbumCapKey[] = [
  'upload',
  'editTag',
  'changeVisibility',
  'download',
  'zip',
  'shareLink',
  'delete',
  'tempAccess',
];

export const ALBUM_CAP_LABEL: Record<AlbumCapKey, string> = {
  upload: '传图',
  editTag: '打标与元数据',
  changeVisibility: '改档位',
  download: '原图下载',
  zip: '批量打包',
  shareLink: '建返图链接',
  delete: '删除图片',
  tempAccess: '临时账号访问',
};

export const ALBUM_CAP_DESC: Record<AlbumCapKey, string> = {
  upload: '往本册上传图片；关掉后谁都传不进来，锁定状态等价',
  editTag: '本册图片的标签与拍摄时间等元数据编辑',
  changeVisibility: '本册图片的可见范围修改（相册自身的档位不受这一位约束）',
  download: '本册图片的原图下载，预览不受影响',
  zip: '本册图片进批量打包，逐条以 ALBUM_CAP_CLOSED 退回',
  shareLink: '在本册新建返图链接；已存在的链接不受影响（与 D20 撤销不回收同口径）',
  delete: '删除本册图片（V1.2 前台未提供该入口，接口层已拦，M3 接线后生效）',
  tempAccess: '临时账号能否访问本册：关掉后白名单里也当它不存在（404 反枚举）',
};

/**
 * 相册开关的回显形状。`capsOff` 是有效关闭项（含父册继承，父关子也关，与 3.2 同向），
 * 详情页按它不渲染按钮；后两项只在后台功能开关弹窗里区分「本册关的」与「父册带下来的」。
 */
export interface AlbumCapsView {
  capsOff: AlbumCapKey[];
  capsOwnOff: AlbumCapKey[];
  capsInheritedOff: AlbumCapKey[];
}

export const UserLevel = {
  Trainee: 1,
  Member: 2,
  Admin: 3,
  SuperAdmin: 4,
} as const;

export type UserLevel = (typeof UserLevel)[keyof typeof UserLevel];

export const LEVEL_LABEL: Record<number, string> = {
  1: '见习成员',
  2: '普通成员',
  3: '普通管理员',
  4: '超级管理员',
};

export interface ApiEnvelope<T> {
  code: string;
  message: string;
  data: T;
  traceId: string;
}

export interface Page<T> {
  page: number;
  pageSize: number;
  total: number;
  list: T[];
}

export interface TagView {
  id: number;
  type: TagType;
  name: string;
}

/** 后端 imageView 的裁剪口径：磁盘路径永不出网 */
export interface ImageView {
  id: number;
  albumId: number;
  filename: string;
  fileSize: number;
  width: number;
  height: number;
  md5: string;
  shotTime: string | null;
  watermarked: 0 | 1;
  visibility: Visibility;
  sort: number;
  /** 游客与分享访客拿到的是 null：响应体不下发上传账号（PRD 12.8） */
  uploadUid: number | null;
  uploadTempId: number | null;
  tags: TagView[];
  createTime: string;
  links: { preview: string; original: string | null };
}

export interface AlbumView {
  id: number;
  /** 父相册 ID，顶级相册为 null。仅超级管理员可创建子相册 */
  parentId: number | null;
  name: string;
  eventName: string;
  eventDate: string;
  location: string;
  description: string;
  coverImgId: number | null;
  visibility: Visibility;
  status: AlbumStatus;
  /** 相册阶段：前期（拍展/原片）或后期（精修/交付） */
  stage: AlbumStage;
  /**
   * D25 相册级功能开关的落库形状：数组里出现即「关」，缺省即开（PRD 6.5）。
   * 存的是被关闭的键，与 albums.album_caps 的 JSON 数组一一对应；
   * 列名不叫 caps 是为了不和 Profile.capabilities（按人的能力位，PRD 6.4）混起来。
   */
  albumCaps?: AlbumCapKey[];
  createUid: number;
  createTime: string;
}

export interface Capabilities {
  download: boolean;
  zip: boolean;
  upload: boolean;
  editOwn: boolean;
  editAny: boolean;
  delete: boolean;
  changeVisibility: boolean;
  canSetPublic: boolean;
  shareLink: boolean;
  adminConsole: boolean;
  writeSiteSettings: boolean;
}

export type CapKey = keyof Capabilities;

/** 弹窗逐行渲染的顺序，与 PRD 6.4 的能力位表一致 */
export const CAP_KEYS: CapKey[] = [
  'download',
  'zip',
  'upload',
  'editOwn',
  'editAny',
  'delete',
  'changeVisibility',
  'canSetPublic',
  'shareLink',
  'adminConsole',
  'writeSiteSettings',
];

export const CAP_LABEL: Record<CapKey, string> = {
  download: '原图下载',
  zip: '批量打包',
  upload: '上传',
  editOwn: '编辑自有',
  editAny: '编辑他人',
  delete: '删除',
  changeVisibility: '改档位',
  canSetPublic: '对外发布',
  shareLink: '返图链接',
  adminConsole: '后台入口',
  writeSiteSettings: '站点配置写入',
};

export const CAP_DESC: Record<CapKey, string> = {
  download: '原图 / 原文件单件下载，不含预览',
  zip: '多选打包与 ZIP 下载（PRD 4.5）',
  upload: '传图与传文件，写档仍受 3.2 与目标可写性约束',
  editOwn: '编辑自己上传资源的标签 / 重命名 / 元数据',
  editAny: '归属范围开关：开 = 全站，关 = 编辑／删除／改档位／建链接一起退回仅自有',
  delete: '删除图片 / 文件 / 相册 / 目录',
  changeVisibility: '修改资源可见范围',
  canSetPublic: '把资源档位设为公开（对外发布）',
  shareLink: '生成 coser 返图链接（PRD 4.4）',
  adminConsole: '/admin 及其全部子页（PRD 8.2）',
  writeSiteSettings: '站点配置写入（保留位，只归超管）',
};

/** 能力位被强制开给 L1–L3 会被 409 挡下的那一位（PRD 6.4 保留位） */
export const RESERVED_CAPS: CapKey[] = ['writeSiteSettings'];

/**
 * D21 三态：跟随等级（默认，不落库）/ 强制开 / 强制关。
 * 收紧优先于等级默认值，放开只放动作——不越过档位可见性。
 */
export type CapMode = 'inherit' | 'on' | 'off';

export const CAP_MODE_LABEL: Record<CapMode, string> = {
  inherit: '跟随等级',
  on: '强制开',
  off: '强制关',
};

/**
 * users.feature_grants 的形状：键 = 能力位，缺键即跟随等级。
 * 与 D20 的 driveGrant 一样是「按人」的覆盖，不新增权限表。
 */
export type FeatureGrant = Partial<Record<CapKey, CapMode>>;

export interface TempFlags {
  preview: boolean;
  download: boolean;
  uploadImg: boolean;
  uploadFile: boolean;
  editTag: boolean;
}

export type Identity =
  | { kind: 'user'; uid: number; username: string; nickname: string; level: UserLevel }
  | { kind: 'temp'; tempId: number; displayName: string; expiresAt: string };

/** POST /auth/login 只回令牌 + 身份摘要，能力位要再打 /auth/me */
export interface LoginResult {
  accessToken: string;
  identity: Identity;
}

/**
 * GET /auth/me
 * `serverTime` 是服务端取样时刻：销毁倒计时拿它和本机时钟做一次差，改本机时间不能续命（PRD 8.5）。
 */
export type Profile =
  | {
      kind: 'user';
      uid: number;
      username: string;
      nickname: string;
      /** 工作室里的职务，页头显示「名称+职务」，共享文件夹副标题也用它（规则 1） */
      position: string;
      level: UserLevel;
      levelName: string;
      spaceQuota: number;
      usedSpace: number;
      capabilities: Capabilities;
      /** 被个人授权覆盖掉默认值的能力位（D21 回显，让本人知道这不是等级自带权限） */
      capsOverridden: CapKey[];
      serverTime: string;
    }
  | {
      kind: 'temp';
      tempId: number;
      /** 帐户ID（YK + 6 位码），自助销毁时要手动输入它的后 6 位（PRD 8.5 危险格） */
      accountId: string;
      displayName: string;
      expiresAt: string;
      ownerUid: number;
      flags: TempFlags;
      allowedAlbumIds: number[];
      allowedFolderIds: number[];
      spaceQuota: number;
      usedSpace: number;
      serverTime: string;
    };

/** 批量接口的逐条回执：不合规项回清单，不整体回滚（PRD 4.5） */
export interface RejectedItem {
  imageId: number;
  status: number;
  code: string;
  message: string;
}

export interface BatchResult {
  requested: number;
  updated: number;
  rejected: RejectedItem[];
}

export interface ImageQuery {
  tags?: number[];
  status?: number[];
  page?: number;
  pageSize?: number;
}

// ---------------- M3 交付：返图分享链接（PRD 4.4 / 10.3） ----------------

export interface ShareLinkView {
  id: number;
  shareToken: string;
  /** 拼好的对外地址，直接给 coser */
  url: string;
  /** album=本相册内按标签命中，person=同一 Coser 跨相册汇总 */
  scope: 'album' | 'person';
  /** person 链接没有单一来源相册 */
  albumId: number | null;
  albumName: string;
  /** 当前命中的相册名，跨相册链接靠它说明图从哪几册来 */
  albumNames: string[];
  coserTagId: number | null;
  coserName: string | null;
  /** 0=按标签实时命中，1=固化图片集合 */
  snapshot: 0 | 1;
  /** 真接口存 bcrypt，响应体只回「有没有」 */
  hasPassword: boolean;
  allowDownload: 0 | 1;
  visitCount: number;
  expireTime: string;
  revoked: 0 | 1;
  expired: boolean;
  imageCount: number;
  createUid: number;
  createTime: string;
  lastVisitTime: string | null;
}

export interface PublicShareView {
  shareToken: string;
  /** person 链接的 albumName 为空，页头改用 coser 名 + albumNames */
  scope: 'album' | 'person';
  albumName: string;
  albumNames: string[];
  eventName: string;
  eventDate: string;
  coserName: string;
  expireTime: string;
  allowDownload: boolean;
  needPassword: boolean;
  total: number;
  images: ImageView[];
}

// ---------------- M4 网盘：目录树与文件（PRD 5.3–5.6 / 10.4 + 网盘 12 条规则） ----------------

/**
 * 目录用途决定网盘的权限规则，与服务端 common/permission/permission-policy.ts 同构。
 * 页面按 perms 渲染按钮，不再自己判断目录名或档位。
 */
export const FolderKind = {
  Workspace: 'workspace',
  Shoot: 'shoot',
  Manage: 'manage',
  Shared: 'shared',
  Personal: 'personal',
  Crawler: 'crawler',
  Trash: 'trash',
} as const;

export type FolderKind = (typeof FolderKind)[keyof typeof FolderKind];

export const FOLDER_KIND_LABEL: Record<FolderKind, string> = {
  workspace: '工作室',
  shoot: '拍展',
  manage: '管理',
  shared: '共享',
  personal: '私人',
  crawler: '爬虫',
  trash: '垃圾箱',
};

/** 服务端按目录用途算好的能力位 */
export interface FolderPerms {
  read: boolean;
  download: boolean;
  upload: boolean;
  modify: boolean;
  remove: boolean;
  purge: boolean;
}

/**
 * 文件权限 1~4 的「个人授权」：超管单独给某个成员开启的那几档，
 * 开启后这个人绕过站点等级门槛吃到对应目录，别人不受影响。
 * 落库对应 users 表的四个开关列，不是新的一张权限表。
 */
export interface DriveGrant {
  /** 工作室 + 拍展（规则 2/3） */
  perm1: boolean;
  /** 管理目录（规则 4） */
  perm2: boolean;
  /** 自动获得以本人名称命名的共享文件夹（规则 1/5） */
  perm3: boolean;
  /** 私人文件夹（规则 6） */
  perm4: boolean;
}

export const DRIVE_GRANT_LABEL: Record<keyof DriveGrant, string> = {
  perm1: '文件权限1',
  perm2: '文件权限2',
  perm3: '文件权限3',
  perm4: '文件权限4',
};

/** 共享文件夹名字下面那一行的归属信息（规则 1：职务标签 + 等级标签） */
export interface FolderOwner {
  uid: number;
  nickname: string;
  position: string;
  levelName: string;
}

export interface FolderNode {
  id: number;
  parentId: number | null;
  name: string;
  description: string;
  depth: number;
  /** 物化路径 /1/2/3/，前端只用于展示层级 */
  path: string;
  kind: FolderKind;
  visibility: Visibility;
  ownerUid: number | null;
  owner: FolderOwner | null;
  perms: FolderPerms;
  fileCount: number;
  /** 在垃圾箱里的条目回删除时间，列表按它排序 */
  deletedAt: string | null;
  children: FolderNode[];
}

export interface FileView {
  id: number;
  folderId: number;
  filename: string;
  fileSize: number;
  mimeType: string;
  md5: string;
  /** 0未生成 1已生成 2不支持 3生成失败 */
  previewStatus: 0 | 1 | 2 | 3;
  visibility: Visibility;
  uploadUid: number | null;
  uploadTempId: number | null;
  createTime: string;
  /** 无权限时对应链接为 null，而不是整个文件不返回 */
  links: { preview: string | null; download: string | null };
  /** 删除按钮的开关：跟随所在目录的 remove 位，超管私人目录里 purge 为真 */
  canDelete: boolean;
  /** 非 null 表示这条在垃圾箱里，等待超管清除或还原 */
  deletedAt: string | null;
}

/** 规则 10：上传目的地只列当前身份有上传权的目录 */
export interface UploadTarget {
  id: number;
  name: string;
  path: string;
  depth: number;
  kind: FolderKind;
  /** 形如 工作室／2026 CP29，选项里靠它区分同名的深层目录 */
  trail: string;
  /** 不可选时给原因，例如上级是别人的共享文件夹 */
  disabledReason: string | null;
}

export interface BatchZipResult {
  requested: number;
  accepted: number;
  estimatedSize: number;
  zipUrl: string;
  rejected: { fileId: number; status: number; code: string; message: string }[];
}

/** 图片打包与文件打包同构，只是清单项用 imageId（PRD 4.5 的 POST /images/batch-zip） */
export interface ImageZipResult {
  requested: number;
  accepted: number;
  estimatedSize: number;
  zipUrl: string;
  rejected: { imageId: number; status: number; code: string; message: string }[];
}

// ---------------- 加密空间（PRD 5.7，D26 客户端信封加密） ----------------

/**
 * GET /vault/status：本空间的状态与口令派生参数。
 * salt / iterations / verifier 都是公开可下发的——拿到它们推不出口令，
 * 也没有口令就解不开任何一条密文，这是「忘记密码不可恢复」的技术前提。
 */
export interface VaultStatus {
  /** false = 还没设过口令，前端走初始化向导 */
  initialized: boolean;
  salt: string | null;
  iterations: number;
  /** 口令校验子（base64 密文容器），未初始化时为 null */
  verifier: string | null;
  /** 设口令时留下的提示语，可为空；只提示给本人，不构成任何恢复途径 */
  hint: string;
  fileCount: number;
  /** 密文总体积：配额按这一列计（PRD 5.6 的「含 private」同样适用） */
  cipherBytes: number;
  /** 明文总体积：上传时一并登记，只用于容量视图，不泄露任何内容 */
  plainBytes: number;
  quota: number;
  used: number;
  createTime: string | null;
  lastActivity: string | null;
  /** 演示层提示：mock 里预置口令的说明文案，真接口不带这一列 */
  demoTip?: string | null;
}

/** 列表条目：文件名以密文下发，本地持钥才解得开（PRD 5.7） */
export interface VaultFileView {
  id: number;
  /**
   * 文件名的密文容器（base64）。
   * null = 这条来自他人空间：超管按 3.1 有管理权，但 PRD 5.7 明确不下发文件名密文，
   * 免得「档位给的删除权」被顺手扩成「离线爆破口令的素材」。
   */
  nameCipher: string | null;
  /** 密文体积，与配额同源 */
  size: number;
  /** 原始体积，下载完成后用来核对还原是否完整 */
  plainSize: number;
  /** 客户端上报的 MIME，这里只用于条目图标；内容本身服务端读不出 */
  mimeType: string;
  createTime: string;
  /** null 表示无权取回密文（他人空间） */
  links: { cipher: string | null };
  /** 归属人本人恒为 true；他人空间里只有 L4 拿到 true，且删除是就地销毁 */
  canDelete: boolean;
}

/** POST /vault/files 的元数据登记：mock 里密文随元数据同批提交，真接口 M4 改走 raw 分片 */
export interface VaultUploadMeta {
  nameCipher: string;
  plainSize: number;
  cipherSize: number;
  mimeType: string;
  /** 原文件名的小写扩展名（不含点），只为过 5.2 黑名单，不用于拼路径 */
  ext?: string;
  /** base64 的密文容器 */
  cipher: string;
}

/**
 * GET /vault/spaces（仅 L4）：超管看得到的是「谁有多少密文、占了多少空间」，
 * 到此为止——档位给的删除权仍然有效，解密权永远拿不到。
 */
export interface VaultSpaceRow {
  uid: number;
  nickname: string;
  position: string;
  levelName: string;
  initialized: boolean;
  fileCount: number;
  cipherBytes: number;
  lastActivity: string | null;
  /** L4 可按 PRD 3.1 对他人 private 资源执行删除 */
  canPurge: boolean;
}

// ---------------- M5 公开通道与后台（PRD 8.2 / 10.5） ----------------

/** 联系方式渠道：后台 `site.contact` 存这份 JSON 数组，公开接口原样下发 */
export interface ContactChannel {
  type: 'weibo' | 'bilibili' | 'qqgroup' | 'wechat' | 'email' | 'other';
  /** 展示名，如「微博」「约稿邮箱」 */
  label: string;
  /** 账号 / 群号 / 邮箱 / 链接 */
  value: string;
}

export interface SiteInfo {
  title: string;
  introLines: string[];
  commentEnabled: boolean;
  watermarkText: string;
  contact: ContactChannel[];
}

// ---------------- 取图（PRD 18 章，第 8.4 矩阵的「取图」格） ----------------

export interface TakeGroup {
  /** album=白名单相册，task=本次工单的帐户 ID 目录 */
  kind: 'album' | 'task';
  id: number;
  name: string;
  subtitle: string;
  images: ImageView[];
}

/**
 * GET /take/pending：临时账号的待领清单。
 * 取图分两部分：前期修图（stage1）和后期返图（stage2），各自独立完成独立展示。
 * 某阶段未完成时，对应的 preGroups/postGroups 必为空——
 * 未完成不是权限问题，不能靠前端隐藏按钮来糊弄。
 */
export interface TakePending {
  code: string;
  /** 前期修图已完成 */
  preStageDone: boolean;
  /** 后期返图已完成 */
  postStageDone: boolean;
  /** allow_download 关掉时整页只读：能预览，不能存图 */
  canDownload: boolean;
  /** 前期修图阶段可领取的图组 */
  preGroups: TakeGroup[];
  /** 后期返图阶段可领取的图组 */
  postGroups: TakeGroup[];
}

export type LogUserType = 'user' | 'temp' | 'guest' | 'system';

export interface LogRow {
  id: number;
  userType: LogUserType;
  uid: number | null;
  tempId: number | null;
  action: string;
  targetType: string;
  targetId: number | null;
  detail: string;
  ip: string;
  ua: string;
  /** 1 成功 / 0 被拒 */
  result: 0 | 1;
  createTime: string;
}

export interface AdminUserRow {
  uid: number;
  username: string;
  nickname: string;
  position: string;
  level: UserLevel;
  levelName: string;
  spaceQuota: number;
  usedSpace: number;
  disabled: boolean;
  lastLogin: string | null;
  albumCount: number;
  imageCount: number;
  /** 超管单独开给这个人的文件权限档，等级本身够不到的门槛靠它补（规则 13） */
  driveGrant: DriveGrant;
  /** 超管逐项覆盖的能力位（D21），缺键即跟随等级 */
  featureGrant: FeatureGrant;
  /** 禁用账号没有能力位可言，回 null */
  capabilities: Capabilities | null;
  /** capabilities 里被覆盖的那几位（D21 回显） */
  capsOverridden: CapKey[];
}

export interface AdminTempRow {
  tempId: number;
  code: string;
  displayName: string;
  ownerUid: number;
  ownerName: string;
  expiresAt: string;
  expired: boolean;
  flags: TempFlags;
  albumIds: number[];
  folderIds: number[];
  spaceQuota: number;
  usedSpace: number;
}

/** 任务阶段标记：0 未完成 1 已完成，由任务管理页手动勾，不从文件数量推断 */
export type TaskStage = 0 | 1;

/** 任务管理页顶部的状态筛选（手绘稿 23） */
export type TaskFilter = 'stage1_open' | 'stage2_open' | 'stage1_done' | 'stage2_done' | 'all_done';

/** 任务列表 / 任务管理的一行（手绘稿 22、23） */
export interface TempTaskRow {
  tempId: number;
  /** 帐户ID：登录标识，同时也是拍展子树里的目录名（规则 3） */
  code: string;
  displayName: string;
  ownerUid: number;
  ownerName: string;
  ownerPosition: string;
  shootContent: string;
  recycling: string;
  stage1: TaskStage;
  stage2: TaskStage;
  /** 帐户 ID 目录：任务页的「进入」就落到这一棵 */
  taskFolderId: number;
  taskFolderName: string;
  /** 该目录（含子目录）里已有多少文件 */
  fileCount: number;
  usedSpace: number;
  spaceQuota: number;
  expiresAt: string;
  /** 剩余天数，负数表示已过期 */
  daysLeft: number;
  expired: boolean;
  flags: TempFlags;
  createTime: string;
}

/** POST /temp-tasks/register：手绘稿 20 的表单，选填项留空即空串 */
export interface TempRegisterPayload {
  /** 帐户ID：大写字母、数字与短横线，4~24 位，全局唯一 */
  code: string;
  password: string;
  shootContent?: string;
  recycling?: string;
  /** 帐号时长（天），到期即销毁 */
  days: number;
  spaceQuota?: number;
}

export interface AdminTagRow {
  id: number;
  type: TagType;
  name: string;
  useCount: number;
}

export interface AdminSettingRow {
  key: string;
  value: string;
  group: string;
  /** schema.sql 默认配置里没有的演示专用键，界面要标出来 */
  readOnlyNote?: string;
}

export interface DashboardData {
  counts: {
    albums: number;
    images: number;
    folders: number;
    files: number;
    tags: number;
    users: number;
    tempActive: number;
    shareAlive: number;
  };
  storage: {
    quota: number;
    used: number;
    ratio: number;
    warning: boolean;
    perUser: { uid: number; nickname: string; quota: number; used: number; ratio: number }[];
  };
  trend: { date: string; uploads: number }[];
  recentLogs: LogRow[];
  albumList: AlbumRowView[];
}

/** 后台相册行：列表接口不回张数与创建者昵称，这里补齐给管理页用；开关三段回显见 PRD 6.5 */
export interface AlbumRowView extends AlbumView, AlbumCapsView {
  imagesCount: number;
  createName: string;
  createLevel: number;
}
