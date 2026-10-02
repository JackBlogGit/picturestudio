/**
 * mock 模式的数据源：字段形状严格照抄后端 imageView / albumView，
 * 这样关掉 VITE_USE_MOCK 之后页面代码一行都不用改。
 * 演示身份覆盖 游客 / L1 / L2 / L3 / L4 / 临时账号，用来肉眼验证档位裁剪与按钮隐藏。
 */
import type { AlbumStage, AlbumView, DriveGrant, FeatureGrant, ImageView, TagView, TaskStage, TempFlags } from '@/types/api';
import { AlbumStatus, LEVEL_LABEL, UserLevel } from '@/types/api';
import type { Actor } from './policy';
import { memberActorOf } from './policy';
import { addShootFolder } from './tables';

export interface MockUser {
  uid: number;
  username: string;
  nickname: string;
  /** 工作室里的职务，页头与共享文件夹副标题显示（手绘稿 20/25 的「名称+职务」） */
  position: string;
  level: UserLevel;
  spaceQuota: number;
  usedSpace: number;
  /** users.status：1 正常 0 禁用 */
  disabled?: boolean;
  lastLogin?: string | null;
  /** 规则 13：超管单独开给这个人的文件权限档，缺省 = 四档全关，只看等级门槛 */
  driveGrant?: DriveGrant;
  /** D21：超管逐项覆盖的 11 个功能能力位，缺键即跟随等级，只挂在本人 uid 上 */
  featureGrant?: FeatureGrant;
}

export interface MockTemp {
  tempId: number;
  /** 手绘稿 20 的「帐户ID」：登录用的唯一标识，同时是拍展子树里的目录名（规则 3） */
  code: string;
  displayName: string;
  /** 演示库存明文，真接口存 hash；/auth/temp-token 按这一列比密码 */
  password: string;
  ownerUid: number;
  expiresAt: string;
  /** 注册页的选填项：这次拍摄拍什么、后期怎么回收（手绘稿 20） */
  shootContent: string;
  recycling: string;
  flags: TempFlags;
  albumIds: number[];
  folderIds: number[];
  /** 注册时在隐藏的「拍展」子树里挂的帐户 ID 目录，注销账号也不跟着删，留作交付凭证 */
  taskFolderId: number;
  /** 前期返图是否完成：任务管理页手动勾，不由文件数量推断 */
  stage1: TaskStage;
  /** 后期返图是否完成 */
  stage2: TaskStage;
  spaceQuota: number;
  usedSpace: number;
  createTime: string;
}

export const USERS: MockUser[] = [
  { uid: 1, username: 'admin', nickname: '夜刃', position: '创始人 · 摄影', level: UserLevel.SuperAdmin, spaceQuota: 0, usedSpace: 0 },
  { uid: 2, username: 'baize', nickname: '白泽', position: '后期主管', level: UserLevel.Admin, spaceQuota: 5_368_709_120, usedSpace: 1_932_735_283 },
  { uid: 3, username: 'acheng', nickname: '阿澄', position: '场照摄影', level: UserLevel.Member, spaceQuota: 3_221_225_472, usedSpace: 903_008_758 },
  { uid: 4, username: 'xiaoman', nickname: '小满', position: '见习摄影', level: UserLevel.Trainee, spaceQuota: 1_073_741_824, usedSpace: 128_902_128 },
];

/** 四档全关的空授权：账号没写过 driveGrant 时按它判，判定结果等同于只看等级门槛 */
export const NO_DRIVE_GRANT: DriveGrant = { perm1: false, perm2: false, perm3: false, perm4: false };

/** 规则 13：取超管单独开给某个人的文件权限档（账号不存在也回空授权，不抛错） */
export function driveGrantOf(uid: number): DriveGrant {
  return USERS.find((u) => u.uid === uid)?.driveGrant ?? NO_DRIVE_GRANT;
}

const ALL_FLAGS: TempFlags = { preview: true, download: true, uploadImg: true, uploadFile: false, editTag: true };

/**
 * 临时账号走 /auth/temp-token，密码就是注册页填的那一列（演示库明文存）。
 * 三条种子覆盖任务页的三种状态：进行中、全部已完成、已过期未回收。
 */
export const TEMPS: MockTemp[] = [
  {
    tempId: 301,
    // 帐户ID 与「拍展／PK-2026-0913」目录同名（规则 3）
    code: 'PK-2026-0913',
    displayName: '柚子',
    password: 'demo1234',
    ownerUid: 3,
    expiresAt: '2026-12-31T23:59:59.000Z',
    shootContent: 'CP29 雷电将军场照 + 棚拍返图',
    recycling: '精修完把 PSD 源文件传回同一个目录',
    // 下载关着，用来验证临时账号看不到原图按钮（PRD 7.3）
    flags: { ...ALL_FLAGS, download: false, uploadFile: false },
    albumIds: [1, 2],
    folderIds: [7],
    taskFolderId: 7,
    stage1: 1,
    stage2: 0,
    spaceQuota: 1_073_741_824,
    usedSpace: 314_572_800,
    createTime: '2026-09-13T02:00:00.000Z',
  },
  {
    tempId: 302,
    code: 'PK-2026-0920',
    displayName: '青野',
    password: 'demo1234',
    ownerUid: 2,
    expiresAt: '2026-11-30T23:59:59.000Z',
    shootContent: 'IDO 春日祭 初音未来专题',
    recycling: '',
    flags: { ...ALL_FLAGS },
    albumIds: [2],
    folderIds: [16],
    taskFolderId: 16,
    stage1: 1,
    stage2: 1,
    spaceQuota: 1_073_741_824,
    usedSpace: 41_943_040,
    createTime: '2026-09-20T02:00:00.000Z',
  },
  {
    // 已过期且两阶段都没完成：任务管理页的注销对象
    tempId: 303,
    code: 'PK-2026-0928',
    displayName: '柯柯',
    password: 'demo1234',
    ownerUid: 3,
    expiresAt: '2026-09-30T23:59:59.000Z',
    shootContent: '',
    recycling: '到期未回收，可直接注销',
    flags: { ...ALL_FLAGS, editTag: false },
    albumIds: [1],
    folderIds: [17],
    taskFolderId: 17,
    stage1: 0,
    stage2: 0,
    spaceQuota: 1_073_741_824,
    usedSpace: 0,
    createTime: '2026-09-28T02:00:00.000Z',
  },
];

let tempSeq = TEMPS.reduce((max, t) => Math.max(max, t.tempId), 300);

/** 帐户ID：PK-年-月日，当天重号就补序号；它同时也是拍展子树里的目录名（规则 3） */
export function nextAccountCode(): string {
  const now = new Date();
  const base = `PK-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  if (!TEMPS.some((t) => t.code === base)) return base;
  let seq = 2;
  while (TEMPS.some((t) => t.code === `${base}-${seq}`)) seq += 1;
  return `${base}-${seq}`;
}

/** 去掉 I/O/0/1 这类容易念错的字符，口令要手抄给 coser */
const PASSWORD_POOL = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newTempPassword(): string {
  return Array.from({ length: 8 }, () => PASSWORD_POOL[Math.floor(Math.random() * PASSWORD_POOL.length)]).join('');
}

export interface TempSeed {
  code: string;
  displayName: string;
  password: string;
  ownerUid: number;
  days: number;
  shootContent: string;
  recycling: string;
  /** 开关由调用方算全，这里不做默认值，免得后台与注册页两条路各长出一套 */
  flags: TempFlags;
  albumIds: number[];
  /** 额外白名单：后台建账号时可以顺带放开已有的共享目录，注册页传空数组 */
  folderIds: number[];
  spaceQuota: number;
}

/**
 * 建一个临时账号：落 TEMPS 行，并按规则 3 在隐藏的「拍展」子树里挂一个以帐户 ID 命名的目录。
 * 后台创建与前台注册共用这一份，两处的目录口径不会分叉。
 */
export function addTemp(seed: TempSeed): MockTemp {
  const folder = addShootFolder(seed.code, `${seed.displayName} · ${seed.shootContent || '拍展返图'}`, seed.ownerUid);
  const temp: MockTemp = {
    tempId: tempSeq + 1,
    code: seed.code,
    displayName: seed.displayName,
    password: seed.password,
    ownerUid: seed.ownerUid,
    expiresAt: new Date(Date.now() + seed.days * 86_400_000).toISOString(),
    shootContent: seed.shootContent,
    recycling: seed.recycling,
    flags: seed.flags,
    albumIds: [...seed.albumIds],
    folderIds: [...seed.folderIds, folder.id],
    taskFolderId: folder.id,
    stage1: 0,
    stage2: 0,
    spaceQuota: seed.spaceQuota,
    usedSpace: 0,
    createTime: new Date().toISOString(),
  };
  tempSeq += 1;
  TEMPS.push(temp);
  return temp;
}

/**
 * 配额归属：成员算自己，临时账号算这个临时账号本身，游客与分享访客没有归属（返回 null）。
 * 返回的是读写同一行的活视图，add()/release() 之后 used/quota 立刻跟着变，与后端 bumpQuota 同口径。
 */
export function quotaOwner(actor: Actor): {
  used: number;
  quota: number;
  add(n: number): void;
  release(n: number): void;
} | null {
  if (actor.kind === 'member') {
    const user = USERS.find((u) => u.uid === actor.uid);
    if (!user) return null;
    return {
      get used() {
        return user.usedSpace;
      },
      get quota() {
        return user.spaceQuota;
      },
      add(n: number) {
        user.usedSpace += n;
      },
      release(n: number) {
        user.usedSpace = Math.max(0, user.usedSpace - n);
      },
    };
  }
  if (actor.kind === 'temp') {
    const temp = TEMPS.find((t) => t.tempId === actor.tempId);
    if (!temp) return null;
    return {
      get used() {
        return temp.usedSpace;
      },
      get quota() {
        return temp.spaceQuota;
      },
      add(n: number) {
        temp.usedSpace += n;
      },
      release(n: number) {
        temp.usedSpace = Math.max(0, temp.usedSpace - n);
      },
    };
  }
  return null;
}

/**
 * 彻底删除要归还配额，但手上只有文件行，没有当时的 Actor。
 * 演示库的 usedSpace 是手写的种子值，所以下限夹在 0，不减成负数。
 */
export function releaseFileQuota(file: { uploadUid: number; uploadTempId: number | null; fileSize: number }): void {
  const row =
    file.uploadTempId !== null
      ? TEMPS.find((t) => t.tempId === file.uploadTempId)
      : USERS.find((u) => u.uid === file.uploadUid);
  if (!row) return;
  row.usedSpace = Math.max(0, row.usedSpace - file.fileSize);
}

export const TAGS: TagView[] = [
  { id: 1, type: 'event', name: 'CP29' },
  { id: 2, type: 'event', name: 'IDO 春日祭' },
  { id: 3, type: 'event', name: 'WF 模型展' },
  { id: 4, type: 'coser', name: '柚子' },
  { id: 5, type: 'coser', name: '青野' },
  { id: 6, type: 'coser', name: '小满' },
  { id: 7, type: 'role', name: '雷电将军' },
  { id: 8, type: 'role', name: '芙莉莲' },
  { id: 9, type: 'role', name: '初音未来' },
  { id: 10, type: 'role', name: '哥伦比娅' },
  { id: 11, type: 'photographer', name: '夜刃' },
  { id: 12, type: 'photographer', name: '阿澄' },
  { id: 13, type: 'status', name: '待修' },
  { id: 14, type: 'status', name: '精修完成' },
  { id: 15, type: 'status', name: '已交付' },
];

export const tagById = (id: number): TagView | undefined => TAGS.find((t) => t.id === id);

export const ALBUMS: AlbumView[] = [
  {
    id: 1,
    parentId: null,
    name: 'CP29 · 雷电将军全场返图',
    eventName: 'CP29',
    eventDate: '2026-09-26',
    location: '上海世博展览馆',
    description: '场照 + 棚拍混排，含 3 位 coser 的返图。',
    coverImgId: 101,
    visibility: 'public',
    status: AlbumStatus.Normal,
    stage: 'post',
    createUid: 3,
    createTime: '2026-09-26T09:12:00.000Z',
  },
  {
    id: 2,
    parentId: null,
    name: 'IDO 春日祭 · 芙莉莲专题',
    eventName: 'IDO 春日祭',
    eventDate: '2026-08-15',
    location: '杭州电竞中心',
    description: '只对内部开放的精修选题。',
    coverImgId: 201,
    visibility: 'member',
    status: AlbumStatus.Normal,
    stage: 'post',
    createUid: 3,
    createTime: '2026-08-15T10:40:00.000Z',
  },
  {
    id: 3,
    parentId: null,
    name: '内部审稿 · 未定稿',
    eventName: 'CP29',
    eventDate: '2026-09-27',
    location: '线上',
    description: '调色未定，禁止外传。',
    coverImgId: null,
    visibility: 'admin',
    status: AlbumStatus.Normal,
    stage: 'pre',
    createUid: 2,
    createTime: '2026-09-27T02:20:00.000Z',
  },
  {
    id: 4,
    parentId: null,
    name: '阿澄的个人试机片',
    eventName: 'WF 模型展',
    eventDate: '2026-07-20',
    location: '北京国家会议中心',
    description: '个人练习稿，暂不入库。',
    coverImgId: null,
    visibility: 'private',
    status: AlbumStatus.Normal,
    stage: 'pre',
    createUid: 3,
    createTime: '2026-07-20T13:05:00.000Z',
  },
  {
    id: 5,
    parentId: null,
    name: '2025 冬季场 · 已归档',
    eventName: 'IDO 春日祭',
    eventDate: '2025-12-20',
    location: '杭州电竞中心',
    description: '历史相册，只读。',
    coverImgId: null,
    visibility: 'member',
    status: AlbumStatus.Archived,
    stage: 'post',
    createUid: 1,
    createTime: '2025-12-20T08:00:00.000Z',
  },
  {
    id: 6,
    parentId: null,
    name: 'CP29 · 交付锁定盘',
    eventName: 'CP29',
    eventDate: '2026-09-28',
    location: '上海世博展览馆',
    description: '已交付 coser，任何改动都会被拒（PRD 4.2）。',
    coverImgId: null,
    visibility: 'member',
    status: AlbumStatus.Locked,
    stage: 'post',
    createUid: 2,
    createTime: '2026-09-28T06:30:00.000Z',
  },
];

/** 图片行的原始数据：tags 用 ID，落库前后再裁档位与可见标签 */
export interface ImageSeed {
  id: number;
  albumId: number;
  filename: string;
  width: number;
  height: number;
  megapixels: number;
  /** 上传演示带真实字节数；预置行没有它，由 megapixels 推算体积 */
  bytes?: number;
  visibility: ImageView['visibility'];
  uploaderUid: number;
  uploaderTempId: number | null;
  tags: number[];
  shotTime: string | null;
  sort: number;
}

const SEEDS: ImageSeed[] = [
  { id: 101, albumId: 1, filename: 'DSC04123.jpg', width: 7008, height: 4672, megapixels: 42.1, visibility: 'public', uploaderUid: 3, uploaderTempId: null, tags: [1, 4, 7, 12, 15], shotTime: '2026-09-26T06:31:00.000Z', sort: 1 },
  { id: 102, albumId: 1, filename: 'DSC04188.jpg', width: 7008, height: 4672, megapixels: 33.6, visibility: 'public', uploaderUid: 3, uploaderTempId: null, tags: [1, 4, 7, 12, 14], shotTime: '2026-09-26T06:52:00.000Z', sort: 2 },
  { id: 103, albumId: 1, filename: 'IMG_2231.jpg', width: 6000, height: 4000, megapixels: 24.0, visibility: 'public', uploaderUid: 2, uploaderTempId: null, tags: [1, 5, 9, 11, 13], shotTime: '2026-09-26T07:14:00.000Z', sort: 3 },
  { id: 104, albumId: 1, filename: 'IMG_2240.jpg', width: 4000, height: 6000, megapixels: 24.0, visibility: 'public', uploaderUid: 2, uploaderTempId: null, tags: [1, 5, 9, 11], shotTime: null, sort: 4 },
  { id: 105, albumId: 1, filename: 'DSC04201.jpg', width: 7008, height: 4672, megapixels: 42.1, visibility: 'member', uploaderUid: 3, uploaderTempId: null, tags: [1, 4, 7, 12, 13], shotTime: '2026-09-26T08:02:00.000Z', sort: 5 },
  { id: 106, albumId: 1, filename: 'DSC04255.jpg', width: 7008, height: 4672, megapixels: 38.9, visibility: 'private', uploaderUid: 3, uploaderTempId: null, tags: [1, 6, 10, 12], shotTime: '2026-09-26T08:33:00.000Z', sort: 6 },
  { id: 107, albumId: 1, filename: 'DSC04302.jpg', width: 7008, height: 4672, megapixels: 41.0, visibility: 'public', uploaderUid: 4, uploaderTempId: null, tags: [1, 6, 10, 12, 13], shotTime: '2026-09-26T09:01:00.000Z', sort: 7 },
  { id: 108, albumId: 1, filename: 'DSC04310.jpg', width: 7008, height: 4672, megapixels: 39.4, visibility: 'member', uploaderUid: 1, uploaderTempId: null, tags: [1, 4, 8, 11, 14], shotTime: '2026-09-26T09:18:00.000Z', sort: 8 },
  { id: 109, albumId: 1, filename: 'IMG_0031.jpg', width: 3024, height: 4032, megapixels: 12.2, visibility: 'public', uploaderUid: 3, uploaderTempId: 301, tags: [1, 4, 7, 15], shotTime: null, sort: 9 },
  { id: 110, albumId: 1, filename: 'IMG_0032.jpg', width: 3024, height: 4032, megapixels: 12.2, visibility: 'public', uploaderUid: 3, uploaderTempId: 301, tags: [1, 4, 7, 13], shotTime: null, sort: 10 },

  { id: 201, albumId: 2, filename: 'DSC01120.jpg', width: 6720, height: 4480, megapixels: 30.1, visibility: 'member', uploaderUid: 3, uploaderTempId: null, tags: [2, 5, 8, 12, 14], shotTime: '2026-08-15T05:40:00.000Z', sort: 1 },
  { id: 202, albumId: 2, filename: 'DSC01144.jpg', width: 6720, height: 4480, megapixels: 29.7, visibility: 'public', uploaderUid: 3, uploaderTempId: null, tags: [2, 5, 8, 12, 15], shotTime: '2026-08-15T06:02:00.000Z', sort: 2 },
  { id: 203, albumId: 2, filename: 'DSC01189.jpg', width: 6720, height: 4480, megapixels: 31.4, visibility: 'member', uploaderUid: 2, uploaderTempId: null, tags: [2, 6, 9, 11], shotTime: '2026-08-15T06:25:00.000Z', sort: 3 },
  { id: 204, albumId: 2, filename: 'DSC01203.jpg', width: 6720, height: 4480, megapixels: 28.8, visibility: 'admin', uploaderUid: 2, uploaderTempId: null, tags: [2, 6, 9, 11, 13], shotTime: '2026-08-15T06:47:00.000Z', sort: 4 },
  { id: 205, albumId: 2, filename: 'IMG_7712.jpg', width: 4000, height: 6000, megapixels: 24.0, visibility: 'member', uploaderUid: 3, uploaderTempId: 301, tags: [2, 5, 8, 14], shotTime: null, sort: 5 },
  { id: 206, albumId: 2, filename: 'IMG_7719.jpg', width: 4000, height: 6000, megapixels: 24.0, visibility: 'public', uploaderUid: 3, uploaderTempId: 301, tags: [2, 5, 8, 13], shotTime: null, sort: 6 },

  { id: 301, albumId: 3, filename: 'DSC05001.jpg', width: 7008, height: 4672, megapixels: 40.2, visibility: 'admin', uploaderUid: 2, uploaderTempId: null, tags: [1, 4, 7, 11, 13], shotTime: '2026-09-27T03:10:00.000Z', sort: 1 },
  { id: 302, albumId: 3, filename: 'DSC05002.jpg', width: 7008, height: 4672, megapixels: 39.8, visibility: 'admin', uploaderUid: 2, uploaderTempId: null, tags: [1, 4, 7, 11, 13], shotTime: '2026-09-27T03:22:00.000Z', sort: 2 },
  { id: 303, albumId: 3, filename: 'DSC05009.jpg', width: 7008, height: 4672, megapixels: 41.7, visibility: 'private', uploaderUid: 1, uploaderTempId: null, tags: [1, 5, 10, 12], shotTime: '2026-09-27T03:55:00.000Z', sort: 3 },

  { id: 401, albumId: 4, filename: 'DSC00900.jpg', width: 6000, height: 4000, megapixels: 24.0, visibility: 'private', uploaderUid: 3, uploaderTempId: null, tags: [3, 12], shotTime: '2026-07-20T07:00:00.000Z', sort: 1 },
  { id: 402, albumId: 4, filename: 'DSC00912.jpg', width: 6000, height: 4000, megapixels: 24.0, visibility: 'private', uploaderUid: 3, uploaderTempId: null, tags: [3, 12, 13], shotTime: '2026-07-20T07:24:00.000Z', sort: 2 },

  { id: 501, albumId: 5, filename: 'DSC00011.jpg', width: 6000, height: 4000, megapixels: 22.5, visibility: 'member', uploaderUid: 1, uploaderTempId: null, tags: [2, 6, 9, 15], shotTime: '2025-12-20T06:10:00.000Z', sort: 1 },
  { id: 502, albumId: 5, filename: 'DSC00024.jpg', width: 6000, height: 4000, megapixels: 23.1, visibility: 'public', uploaderUid: 1, uploaderTempId: null, tags: [2, 6, 9, 15], shotTime: '2025-12-20T06:40:00.000Z', sort: 2 },

  { id: 601, albumId: 6, filename: 'DSC06001.jpg', width: 7008, height: 4672, megapixels: 42.0, visibility: 'member', uploaderUid: 2, uploaderTempId: null, tags: [1, 4, 7, 15], shotTime: '2026-09-28T04:00:00.000Z', sort: 1 },
  { id: 602, albumId: 6, filename: 'DSC06002.jpg', width: 7008, height: 4672, megapixels: 41.3, visibility: 'member', uploaderUid: 2, uploaderTempId: null, tags: [1, 4, 7, 15], shotTime: '2026-09-28T04:12:00.000Z', sort: 2 },
];

/** 演示库是可写的：批量打标与改档位直接改这份内存数据，刷新页面即回到初始状态 */
export const IMAGES: ImageSeed[] = SEEDS.map((s) => ({ ...s, tags: [...s.tags] }));

export const imageById = (id: number): ImageSeed | undefined => IMAGES.find((i) => i.id === id);
export const albumById = (id: number): AlbumView | undefined => ALBUMS.find((a) => a.id === id);

export function imagesOfAlbum(albumId: number): ImageSeed[] {
  return IMAGES.filter((i) => i.albumId === albumId);
}

/** 排序口径与后端一致：sort ASC 再 id DESC */
export function sortSeeds(rows: ImageSeed[]): ImageSeed[] {
  return [...rows].sort((a, b) => a.sort - b.sort || b.id - a.id);
}

/** 上传演示：合并完成后往内存表里追加一行，id 从当前最大值继续排 */
export function addImage(albumId: number, filename: string, size: number, uploaderUid: number, uploaderTempId: number | null): ImageSeed {
  const id = Math.max(...IMAGES.map((i) => i.id)) + 1;
  const album = albumById(albumId);
  const seed: ImageSeed = {
    id,
    albumId,
    filename,
    width: 6000,
    height: 4000,
    megapixels: Number((size / 900_000).toFixed(1)) || 24,
    bytes: size,
    // 新图档位继承相册，绝不上浮（PRD 3.2）
    visibility: album?.visibility ?? 'member',
    uploaderUid,
    uploaderTempId,
    tags: [],
    shotTime: null,
    sort: imagesOfAlbum(albumId).length + 1,
  };
  IMAGES.push(seed);
  return seed;
}

let albumSeq = 6;

/** 后台新建相册：档位由调用方校验过继承与 L1 不可公开后才进来 */
export function addAlbum(input: {
  /** null = 顶级相册 */
  parentId: number | null;
  name: string;
  eventName: string;
  eventDate: string;
  location: string;
  description: string;
  visibility: AlbumView['visibility'];
  stage: AlbumStage;
  createUid: number;
}): AlbumView {
  albumSeq += 1;
  const album: AlbumView = {
    id: albumSeq,
    parentId: input.parentId,
    name: input.name,
    eventName: input.eventName,
    eventDate: input.eventDate,
    location: input.location,
    description: input.description,
    coverImgId: null,
    visibility: input.visibility,
    status: AlbumStatus.Normal,
    stage: input.stage,
    createUid: input.createUid,
    createTime: new Date().toISOString(),
  };
  ALBUMS.push(album);
  return album;
}

export function patchAlbum(id: number, patch: Partial<AlbumView>): AlbumView | undefined {
  const album = albumById(id);
  if (!album) return undefined;
  Object.assign(album, patch);
  return album;
}

/**
 * 级联删除：相册没了，它下面的图片行也从内存表消失（真接口是 ON DELETE CASCADE）。
 * 同时递归删除所有子相册及其图片，与 schema.sql 的 parent_id ON DELETE CASCADE 对齐。
 */
export function removeAlbum(id: number): ImageSeed[] {
  // 先递归收集所有后代相册 ID（包括自己）
  const allIds: number[] = [];
  const queue = [id];
  while (queue.length) {
    const current = queue.shift()!;
    allIds.push(current);
    const children = ALBUMS.filter((a) => a.parentId === current);
    for (const child of children) queue.push(child.id);
  }

  // 倒序删除子相册，最后删自己
  const removed: ImageSeed[] = [];
  for (const albumId of allIds) {
    const albumImages = imagesOfAlbum(albumId);
    removed.push(...albumImages);
    for (const seed of albumImages) {
      const at = IMAGES.indexOf(seed);
      if (at >= 0) IMAGES.splice(at, 1);
    }
  }
  // 先删子相册再删父相册
  for (const albumId of [...allIds].reverse()) {
    const at = ALBUMS.findIndex((a) => a.id === albumId);
    if (at >= 0) ALBUMS.splice(at, 1);
  }
  return removed;
}

export function renameTag(id: number, name: string): void {
  const tag = tagById(id);
  if (tag) tag.name = name;
}

/** 合并重复标签：把 from 的图片引用换到 to 上并去掉 from，返回迁移了多少张 */
export function mergeTag(fromId: number, toId: number): number {
  let moved = 0;
  for (const seed of IMAGES) {
    if (!seed.tags.includes(fromId)) continue;
    seed.tags = seed.tags.filter((t) => t !== fromId || t === toId);
    if (!seed.tags.includes(toId)) seed.tags.push(toId);
    seed.tags = [...new Set(seed.tags)];
    moved += 1;
  }
  const at = TAGS.findIndex((t) => t.id === fromId);
  if (at >= 0) TAGS.splice(at, 1);
  return moved;
}

export function deleteTag(id: number): number {
  let cleaned = 0;
  for (const seed of IMAGES) {
    if (seed.tags.includes(id)) {
      seed.tags = seed.tags.filter((t) => t !== id);
      cleaned += 1;
    }
  }
  const at = TAGS.findIndex((t) => t.id === id);
  if (at >= 0) TAGS.splice(at, 1);
  return cleaned;
}

/** 标签使用频次：后台标签库按 use_count 排序，冗余标签靠它清理（PRD 4.6） */
export function tagUseCount(id: number): number {
  return IMAGES.filter((s) => s.tags.includes(id)).length;
}

export function userActor(uid: number): Actor {
  const user = USERS.find((u) => u.uid === uid);
  if (!user) return { kind: 'guest' };
  return memberActorOf({
    uid: user.uid,
    username: user.username,
    nickname: user.nickname,
    level: user.level,
    featureGrant: user.featureGrant,
  });
}

export function levelName(level: UserLevel): string {
  return LEVEL_LABEL[level] ?? `L${level}`;
}
