/**
 * mock 的第二批数据表：站点配置、分享链接、网盘、审计日志。
 * 字段形状照抄 server/sql/schema.sql（site_settings / coser_share_links / share_link_images /
 * folders / files / logs），关掉 mock 后页面代码不用改。
 */
import type { LogRow, Visibility } from '@/types/api';
import type { FolderKind } from './policy';

/** 站点配置：值一律存字符串，跟 site_settings.sval 是 TEXT/JSON 的事实一致 */
export type SettingValue = string;

export const SETTINGS: Record<string, SettingValue> = {
  'upload.max_image_size': '52428800',
  'upload.max_file_size': '2147483648',
  'upload.image_extensions':
    '[".jpg",".jpeg",".png",".webp",".heic",".tif",".tiff",".raw",".cr2",".nef",".arw"]',
  'upload.file_extensions':
    '[".jpg",".jpeg",".png",".webp",".pdf",".doc",".docx",".xls",".xlsx",".ppt",".pptx",".psd",".ai",".zip",".7z",".rar",".mp4",".mov",".preset",".xmp"]',
  'upload.blocked_extensions':
    '[".exe",".bat",".cmd",".sh",".msi",".dll",".apk",".jar",".js",".vbs",".ps1",".scr"]',
  'upload.chunk_size': '5242880',
  /**
   * 加密空间的单文件上限：mock 里密文以 base64 整份进出并在内存留存，所以这条比
   * upload.max_file_size 紧得多；真接口按分片传密文后可放宽到网盘那一档（PRD 5.7）。
   */
  'vault.max_file_size': '52428800',
  'upload.rate_limit': '{"windowMs":60000,"max":30}',
  'preview.max_width': '2048',
  'preview.thumb_width': '400',
  'preview.quality': '82',
  'watermark.enabled': 'false',
  'watermark.text': '皮克社工作室',
  'watermark.position': 'bottomRight',
  'watermark.opacity': '0.35',
  'storage.default_quota': '10737418240',
  /**
   * 网盘的「文件权限1~4」：值是允许该操作的最低成员等级，后台可改，改完对所有人同时生效。
   * 1 管「工作室」、2 管「管理」、3 决定谁有个人共享文件夹、4 决定管理员有没有私人文件夹。
   * 只想放开某一个人：走规则 13 的个人授权，落在成员那一列上，凌驾于这里的门槛且不影响别人。
   */
  'drive.perm1_workspace': '2',
  'drive.perm2_manage': '3',
  'drive.perm3_shared': '2',
  'drive.perm4_personal': '3',
  'guest.comment_enabled': 'false',
  'security.session_ttl': '{"user":86400,"temp":3600}',
  /**
   * schema.sql 的 17 项默认配置里没有「工作室简介」这一族键，首页文案目前只能在前台写死。
   * 这里先按 site.* 造出来给首页读，M5 落库时再定最终键名。
   */
  'site.title': '皮克社工作室',
  'site.intro':
    '专注漫展场照与 Cos 返图的摄影工作室，现场拍摄当天粗修、三天内精修交付。\n所有返图都按「漫展 / Coser / 角色」三级标签归档，找到自己的那组照片只需要点两下。\n原图一律经鉴权接口下发，游客与分享链接只能看到压缩预览，交付更安心。',
  /** 联系我们页的渠道列表：后台站点设置里逐行编辑，序列化后进 site_settings */
  'site.contact':
    '[{"type":"weibo","label":"微博","value":"皮克社工作室"},{"type":"bilibili","label":"B站","value":"space.bilibili.com/皮克社"},{"type":"qqgroup","label":"约稿群","value":"123456789"},{"type":"email","label":"约稿邮箱","value":"hello@pikeshe.example"}]',
};

/** 布尔配置项的小工具：值存字符串，转成 true/false 给页面用 */
export function settingBool(key: string): boolean {
  return SETTINGS[key] === 'true' || SETTINGS[key] === '1';
}

export function settingList(key: string): string[] {
  try {
    return JSON.parse(SETTINGS[key]) as string[];
  } catch {
    return [];
  }
}

export function settingNumber(key: string): number {
  return Number(SETTINGS[key]) || 0;
}

// ---------------- 分享链接 ----------------

export interface MockShareLink {
  id: number;
  shareToken: string;
  /** album=本相册内按标签命中（PRD 4.4），person=同一 Coser 跨相册汇总返图 */
  scope: 'album' | 'person';
  /** person 链接没有单一来源相册 */
  albumId: number | null;
  coserTagId: number | null;
  filterJson: string | null;
  /** 0=按标签实时命中，1=固化图片集合 */
  snapshot: 0 | 1;
  /** mock 里存明文演示口令；真接口存 bcrypt，永不回传 */
  password: string | null;
  allowDownload: 0 | 1;
  visitCount: number;
  expireTime: string;
  revoked: 0 | 1;
  createUid: number;
  createTime: string;
  lastVisitTime: string | null;
  /** snapshot=1 时固化的图片集合（share_link_images） */
  imageIds: number[];
}

export const SHARE_LINKS: MockShareLink[] = [
  {
    id: 1,
    shareToken: 'pk-youzi-cp29-a7f3',
    scope: 'album',
    albumId: 1,
    coserTagId: 4,
    filterJson: '{"coser":[4]}',
    snapshot: 0,
    password: null,
    allowDownload: 1,
    visitCount: 42,
    expireTime: '2026-11-15T23:59:59.000Z',
    revoked: 0,
    createUid: 3,
    createTime: '2026-09-26T12:00:00.000Z',
    lastVisitTime: '2026-09-30T09:12:00.000Z',
    imageIds: [],
  },
  {
    id: 2,
    shareToken: 'pk-qingye-ido-91c2',
    scope: 'album',
    albumId: 2,
    coserTagId: 5,
    filterJson: '{"coser":[5],"role":[9]}',
    snapshot: 1,
    password: 'qingye',
    allowDownload: 0,
    visitCount: 7,
    expireTime: '2026-11-01T23:59:59.000Z',
    revoked: 0,
    createUid: 2,
    createTime: '2026-08-16T03:30:00.000Z',
    lastVisitTime: '2026-09-28T14:20:00.000Z',
    imageIds: [203, 205],
  },
  {
    id: 3,
    shareToken: 'pk-expired-0001',
    scope: 'album',
    albumId: 1,
    coserTagId: 6,
    filterJson: '{"coser":[6]}',
    snapshot: 0,
    password: null,
    allowDownload: 0,
    visitCount: 15,
    expireTime: '2026-09-15T23:59:59.000Z',
    revoked: 0,
    createUid: 3,
    createTime: '2026-09-01T08:00:00.000Z',
    lastVisitTime: '2026-09-14T20:05:00.000Z',
    imageIds: [],
  },
  {
    id: 4,
    shareToken: 'pk-revoked-0002',
    scope: 'album',
    albumId: 2,
    coserTagId: 4,
    filterJson: '{"coser":[4]}',
    snapshot: 0,
    password: null,
    allowDownload: 1,
    visitCount: 3,
    expireTime: '2026-12-01T23:59:59.000Z',
    revoked: 1,
    createUid: 2,
    createTime: '2026-08-20T06:00:00.000Z',
    lastVisitTime: '2026-08-21T11:00:00.000Z',
    imageIds: [],
  },
  {
    id: 5,
    shareToken: 'pk-person-qingye-4d18',
    scope: 'person',
    albumId: null,
    coserTagId: 5,
    filterJson: '{"coser":[5]}',
    snapshot: 0,
    password: null,
    allowDownload: 0,
    visitCount: 3,
    expireTime: '2026-12-20T23:59:59.000Z',
    revoked: 0,
    createUid: 2,
    createTime: '2026-09-27T07:40:00.000Z',
    lastVisitTime: '2026-09-29T15:02:00.000Z',
    imageIds: [],
  },
];

export const shareByToken = (token: string): MockShareLink | undefined =>
  SHARE_LINKS.find((s) => s.shareToken === token);

export const shareExpired = (link: MockShareLink): boolean =>
  link.revoked === 1 || new Date(link.expireTime).getTime() < Date.now();

let shareSeq = 100;
export function nextShareToken(): string {
  shareSeq += 1;
  return `pk-new-${shareSeq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ---------------- 网盘 ----------------

export interface MockFolder {
  id: number;
  parentId: number | null;
  /** 物化路径 /1/5/12/，取子树走前缀匹配 */
  path: string;
  depth: number;
  name: string;
  description: string;
  /** 目录用途，网盘 12 条规则都挂在这个字段上（见 policy.ts 的 folderPerms） */
  kind: FolderKind;
  /** 归属人：共享／私人／拍展／爬虫目录才有，公共目录为 null */
  ownerUid: number | null;
  visibility: Visibility;
  createUid: number;
  createTime: string;
  updateTime: string;
  /** 被移进垃圾箱的目录：记下原上级，还原时移回去 */
  deletedFromId: number | null;
  deletedAt: string | null;
}

/** 规则 12：垃圾箱只有超管能读取和更改，删除的东西都落进这一棵 */
export const TRASH_FOLDER_ID = 14;

/** 规则 3：帐户 ID 目录的挂载点，整棵子树不出现在目录列表里，注册临时账号时往这里挂 */
export const SHOOT_ROOT_ID = 6;

export const FOLDERS: MockFolder[] = [
  { id: 1, parentId: null, path: '/1/', depth: 1, name: '工作室', description: '共享工程目录，文件权限1 说了算', visibility: 'member', kind: 'workspace', ownerUid: null, createUid: 1, createTime: '2026-07-01T02:00:00.000Z', updateTime: '2026-09-26T10:00:00.000Z', deletedFromId: null, deletedAt: null },
  { id: 2, parentId: 1, path: '/1/2/', depth: 2, name: '2026 CP29', description: 'CP29 交付批次', visibility: 'member', kind: 'workspace', ownerUid: null, createUid: 1, createTime: '2026-07-01T02:05:00.000Z', updateTime: '2026-09-28T10:00:00.000Z', deletedFromId: null, deletedAt: null },
  { id: 3, parentId: 2, path: '/1/2/3/', depth: 3, name: '雷电将军 · 柚子', description: '', visibility: 'member', kind: 'workspace', ownerUid: 3, createUid: 3, createTime: '2026-09-26T10:00:00.000Z', updateTime: '2026-09-29T10:00:00.000Z', deletedFromId: null, deletedAt: null },
  { id: 4, parentId: 2, path: '/1/2/4/', depth: 3, name: '初音未来 · 青野', description: '', visibility: 'member', kind: 'workspace', ownerUid: 2, createUid: 3, createTime: '2026-09-26T10:10:00.000Z', updateTime: '2026-09-26T10:10:00.000Z', deletedFromId: null, deletedAt: null },
  { id: 5, parentId: null, path: '/5/', depth: 1, name: '管理', description: '合同、票据与结算，文件权限2', visibility: 'admin', kind: 'manage', ownerUid: null, createUid: 1, createTime: '2026-04-01T02:00:00.000Z', updateTime: '2026-09-05T02:00:00.000Z', deletedFromId: null, deletedAt: null },
  // 规则 3：拍展整棵子树不在列表里出现，注册游客时往这里建同名账户 ID 目录
  { id: SHOOT_ROOT_ID, parentId: null, path: '/6/', depth: 1, name: '拍展', description: '游客账户 ID 目录的挂载点，列表不显示', visibility: 'private', kind: 'shoot', ownerUid: null, createUid: 1, createTime: '2026-06-01T02:00:00.000Z', updateTime: '2026-09-25T02:00:00.000Z', deletedFromId: null, deletedAt: null },
  { id: 7, parentId: SHOOT_ROOT_ID, path: '/6/7/', depth: 2, name: 'PK-2026-0913', description: '柚子 · CP29 现场直传', visibility: 'private', kind: 'shoot', ownerUid: 3, createUid: 3, createTime: '2026-09-26T12:00:00.000Z', updateTime: '2026-09-26T12:30:00.000Z', deletedFromId: null, deletedAt: null },
  { id: 16, parentId: SHOOT_ROOT_ID, path: '/6/16/', depth: 2, name: 'PK-2026-0920', description: '青野 · IDO 春日祭返图', visibility: 'private', kind: 'shoot', ownerUid: 2, createUid: 2, createTime: '2026-09-20T02:00:00.000Z', updateTime: '2026-09-22T02:00:00.000Z', deletedFromId: null, deletedAt: null },
  { id: 17, parentId: SHOOT_ROOT_ID, path: '/6/17/', depth: 2, name: 'PK-2026-0928', description: '柯柯 · 还没传过图', visibility: 'private', kind: 'shoot', ownerUid: 3, createUid: 3, createTime: '2026-09-28T02:00:00.000Z', updateTime: '2026-09-28T02:00:00.000Z', deletedFromId: null, deletedAt: null },
  // 规则 1：成员及以上自动有一个以自己名称命名的共享文件夹
  { id: 8, parentId: null, path: '/8/', depth: 1, name: '夜刃', description: '个人共享文件夹', visibility: 'member', kind: 'shared', ownerUid: 1, createUid: 1, createTime: '2026-05-11T02:00:00.000Z', updateTime: '2026-08-01T02:00:00.000Z', deletedFromId: null, deletedAt: null },
  { id: 9, parentId: null, path: '/9/', depth: 1, name: '白泽', description: '个人共享文件夹', visibility: 'member', kind: 'shared', ownerUid: 2, createUid: 2, createTime: '2026-05-12T02:00:00.000Z', updateTime: '2026-09-20T02:00:00.000Z', deletedFromId: null, deletedAt: null },
  { id: 10, parentId: null, path: '/10/', depth: 1, name: '阿澄', description: '个人共享文件夹', visibility: 'member', kind: 'shared', ownerUid: 3, createUid: 3, createTime: '2026-06-02T02:00:00.000Z', updateTime: '2026-09-20T02:00:00.000Z', deletedFromId: null, deletedAt: null },
  // 规则 6：私人文件夹由文件权限4 决定是否拥有
  { id: 11, parentId: null, path: '/11/', depth: 1, name: '夜刃的私人文件夹', description: '', visibility: 'private', kind: 'personal', ownerUid: 1, createUid: 1, createTime: '2026-08-08T02:00:00.000Z', updateTime: '2026-08-08T02:00:00.000Z', deletedFromId: null, deletedAt: null },
  // 规则 11：超管私人文件夹下的爬虫，按时间建子目录放线上取回的文件
  { id: 12, parentId: 11, path: '/11/12/', depth: 2, name: '爬虫', description: '线上取回的文件', visibility: 'private', kind: 'crawler', ownerUid: 1, createUid: 1, createTime: '2026-09-01T02:00:00.000Z', updateTime: '2026-09-30T02:00:00.000Z', deletedFromId: null, deletedAt: null },
  { id: 13, parentId: 12, path: '/11/12/13/', depth: 3, name: '2026-09', description: '', visibility: 'private', kind: 'crawler', ownerUid: 1, createUid: 1, createTime: '2026-09-30T02:00:00.000Z', updateTime: '2026-09-30T02:00:00.000Z', deletedFromId: null, deletedAt: null },
  { id: 15, parentId: null, path: '/15/', depth: 1, name: '白泽的私人文件夹', description: '', visibility: 'private', kind: 'personal', ownerUid: 2, createUid: 2, createTime: '2026-08-10T02:00:00.000Z', updateTime: '2026-08-10T02:00:00.000Z', deletedFromId: null, deletedAt: null },
  { id: TRASH_FOLDER_ID, parentId: null, path: '/14/', depth: 1, name: '垃圾箱', description: '彻底删除前都待在这里，只有超管能读改', visibility: 'private', kind: 'trash', ownerUid: null, createUid: 1, createTime: '2026-05-01T02:00:00.000Z', updateTime: '2026-09-30T06:00:00.000Z', deletedFromId: null, deletedAt: null },
];

export const folderById = (id: number): MockFolder | undefined =>
  FOLDERS.find((f) => f.id === id);

let folderSeq = FOLDERS.reduce((max, f) => Math.max(max, f.id), 0);
export function nextFolderId(): number {
  folderSeq += 1;
  return folderSeq;
}

/**
 * 规则 3：注册临时账号时往隐藏的「拍展」子树挂一个以帐户 ID 命名的目录。
 * 这一棵不进前台列表，所以不走 drive 的目录权限校验，由数据层直接落。
 */
export function addShootFolder(name: string, description: string, ownerUid: number): MockFolder {
  const parent = folderById(SHOOT_ROOT_ID);
  const id = nextFolderId();
  const now = new Date().toISOString();
  const folder: MockFolder = {
    id,
    parentId: SHOOT_ROOT_ID,
    path: `${parent?.path ?? `/${SHOOT_ROOT_ID}/`}${id}/`,
    depth: (parent?.depth ?? 1) + 1,
    name,
    description,
    kind: 'shoot',
    ownerUid,
    visibility: 'private',
    createUid: ownerUid,
    createTime: now,
    updateTime: now,
    deletedFromId: null,
    deletedAt: null,
  };
  FOLDERS.push(folder);
  return folder;
}

export interface MockFile {
  id: number;
  folderId: number;
  filename: string;
  /** 磁盘路径永不下发，只用于 mock 内部标识（PRD 12.3） */
  storagePath: string;
  fileSize: number;
  mimeType: string;
  md5: string;
  /** 0未生成 1已生成 2不支持 3生成失败 */
  previewStatus: 0 | 1 | 2 | 3;
  visibility: Visibility;
  uploadUid: number;
  uploadTempId: number | null;
  createTime: string;
  /** 规则 7：删除后进垃圾箱，记下原目录，还原时回到这里 */
  deletedFromId: number | null;
  deletedAt: string | null;
}

export const FILES: MockFile[] = [
  { id: 901, folderId: 3, filename: 'CP29_柚子_雷电将军_精修.psd', storagePath: 'uuid-8f21.psd', fileSize: 412_301_056, mimeType: 'image/vnd.adobe.photoshop', md5: '8f21aa00000000000000000000000901', previewStatus: 1, visibility: 'member', uploadUid: 3, uploadTempId: null, createTime: '2026-09-27T10:00:00.000Z', deletedFromId: null, deletedAt: null },
  { id: 902, folderId: 3, filename: 'CP29_柚子_交付稿.zip', storagePath: 'uuid-8f22.zip', fileSize: 1_245_410_304, mimeType: 'application/zip', md5: '8f22aa00000000000000000000000902', previewStatus: 2, visibility: 'member', uploadUid: 3, uploadTempId: null, createTime: '2026-09-28T10:00:00.000Z', deletedFromId: null, deletedAt: null },
  { id: 903, folderId: 4, filename: 'CP29_青野_初音未来.png', storagePath: 'uuid-8f23.png', fileSize: 38_901_248, mimeType: 'image/png', md5: '8f23aa00000000000000000000000903', previewStatus: 1, visibility: 'member', uploadUid: 2, uploadTempId: null, createTime: '2026-09-27T11:00:00.000Z', deletedFromId: null, deletedAt: null },
  { id: 904, folderId: 1, filename: '夜刃调色预设-v4.xmp', storagePath: 'uuid-8f24.xmp', fileSize: 24_576, mimeType: 'application/octet-stream', md5: '8f24aa00000000000000000000000904', previewStatus: 2, visibility: 'member', uploadUid: 1, uploadTempId: null, createTime: '2026-08-01T02:00:00.000Z', deletedFromId: null, deletedAt: null },
  { id: 905, folderId: 10, filename: '样片-2026春夏合集.pdf', storagePath: 'uuid-8f25.pdf', fileSize: 18_874_368, mimeType: 'application/pdf', md5: '8f25aa00000000000000000000000905', previewStatus: 1, visibility: 'member', uploadUid: 3, uploadTempId: null, createTime: '2026-09-20T02:00:00.000Z', deletedFromId: null, deletedAt: null },
  { id: 906, folderId: 10, filename: '现场花絮-15s.mp4', storagePath: 'uuid-8f26.mp4', fileSize: 96_468_352, mimeType: 'video/mp4', md5: '8f26aa00000000000000000000000906', previewStatus: 1, visibility: 'member', uploadUid: 3, uploadTempId: null, createTime: '2026-09-20T02:20:00.000Z', deletedFromId: null, deletedAt: null },
  { id: 907, folderId: 5, filename: '漫展摊位合同-CP29.pdf', storagePath: 'uuid-8f27.pdf', fileSize: 2_404_352, mimeType: 'application/pdf', md5: '8f27aa00000000000000000000000907', previewStatus: 1, visibility: 'admin', uploadUid: 1, uploadTempId: null, createTime: '2026-09-05T02:00:00.000Z', deletedFromId: null, deletedAt: null },
  { id: 908, folderId: TRASH_FOLDER_ID, filename: '试机片-参数记录.xlsx', storagePath: 'uuid-8f28.xlsx', fileSize: 1_645_568, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', md5: '8f28aa00000000000000000000000908', previewStatus: 2, visibility: 'member', uploadUid: 3, uploadTempId: null, createTime: '2026-08-08T02:00:00.000Z', deletedFromId: 10, deletedAt: '2026-09-30T06:00:00.000Z' },
  { id: 909, folderId: 2, filename: '工作室色卡.7z', storagePath: 'uuid-8f29.7z', fileSize: 5_242_880, mimeType: 'application/x-7z-compressed', md5: '8f29aa00000000000000000000000909', previewStatus: 2, visibility: 'member', uploadUid: 1, uploadTempId: null, createTime: '2026-07-02T02:00:00.000Z', deletedFromId: null, deletedAt: null },
  { id: 910, folderId: 7, filename: 'IMG_0031-直传.jpg', storagePath: 'uuid-8f2a.jpg', fileSize: 11_269_856, mimeType: 'image/jpeg', md5: '8f2aaa00000000000000000000000910', previewStatus: 1, visibility: 'private', uploadUid: 3, uploadTempId: 301, createTime: '2026-09-26T12:30:00.000Z', deletedFromId: null, deletedAt: null },
  { id: 911, folderId: 11, filename: '摊位报价草稿.xlsx', storagePath: 'uuid-8f2b.xlsx', fileSize: 1_048_576, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', md5: '8f2baa00000000000000000000000911', previewStatus: 2, visibility: 'private', uploadUid: 1, uploadTempId: null, createTime: '2026-08-08T02:20:00.000Z', deletedFromId: null, deletedAt: null },
  { id: 912, folderId: 13, filename: '线上取回-场地参考图.png', storagePath: 'uuid-8f2c.png', fileSize: 3_145_728, mimeType: 'image/png', md5: '8f2caa00000000000000000000000912', previewStatus: 1, visibility: 'private', uploadUid: 1, uploadTempId: null, createTime: '2026-09-30T02:10:00.000Z', deletedFromId: null, deletedAt: null },
  // 拍展子树：16 号目录（青野的任务）已有现场直传与精修稿，17 号目录（柯柯）故意留空
  { id: 913, folderId: 16, filename: 'IMG_3301-现场直传.jpg', storagePath: 'uuid-8f2d.jpg', fileSize: 9_437_184, mimeType: 'image/jpeg', md5: '8f2daa000000000000000000000913', previewStatus: 1, visibility: 'private', uploadUid: 2, uploadTempId: 302, createTime: '2026-09-21T02:00:00.000Z', deletedFromId: null, deletedAt: null },
  { id: 914, folderId: 16, filename: 'IDO_青野_初音未来_精修.psd', storagePath: 'uuid-8f2e.psd', fileSize: 268_435_456, mimeType: 'image/vnd.adobe.photoshop', md5: '8f2eaa000000000000000000000914', previewStatus: 1, visibility: 'private', uploadUid: 2, uploadTempId: null, createTime: '2026-09-22T02:00:00.000Z', deletedFromId: null, deletedAt: null },
];

export const fileById = (id: number): MockFile | undefined => FILES.find((f) => f.id === id);

// 从种子数据里取最大值起算，避免手改种子时新登记的 id 与已有行撞号
let fileSeq = FILES.reduce((max, f) => Math.max(max, f.id), 900);
export function nextFileId(): number {
  fileSeq += 1;
  return fileSeq;
}

/** 文件行补齐垃圾箱字段的默认值，新建时不用每处都写 */
export function fileDefaults(): Pick<MockFile, 'deletedFromId' | 'deletedAt'> {
  return { deletedFromId: null, deletedAt: null };
}

/** 祖先链，从根到自身；取子树与判级联权限都靠它 */
export function folderChain(folderId: number): MockFolder[] {
  const chain: MockFolder[] = [];
  let cursor = folderById(folderId);
  while (cursor) {
    chain.unshift(cursor);
    cursor = cursor.parentId === null ? undefined : folderById(cursor.parentId);
  }
  return chain;
}

// ---------------- 审计日志 ----------------

export type MockLog = LogRow;

export const LOGS: MockLog[] = [
  { id: 1, userType: 'user', uid: 3, tempId: null, action: 'image_upload', targetType: 'image', targetId: 109, detail: 'IMG_0031.jpg, size=11269856, type=jpeg, album=1', ip: '114.88.22.10', ua: 'iOS Safari', result: 1, createTime: '2026-09-26T10:02:00.000Z' },
  { id: 2, userType: 'temp', uid: 3, tempId: 301, action: 'image_upload', targetType: 'image', targetId: 110, detail: 'IMG_0032.jpg, size=11269856, type=jpeg, album=1', ip: '114.88.22.10', ua: 'iOS Safari', result: 1, createTime: '2026-09-26T10:05:00.000Z' },
  { id: 3, userType: 'guest', uid: null, tempId: null, action: 'share_visit', targetType: 'share', targetId: 1, detail: 'link=1, images=6', ip: '114.88.22.10', ua: 'WeChat', result: 1, createTime: '2026-09-26T12:30:00.000Z' },
  { id: 4, userType: 'user', uid: 2, tempId: null, action: 'album_create', targetType: 'album', targetId: 3, detail: '内部审稿 · 未定稿, visibility=admin', ip: '112.64.33.88', ua: 'Chrome', result: 1, createTime: '2026-09-27T02:20:00.000Z' },
  { id: 5, userType: 'user', uid: 4, tempId: null, action: 'download_original', targetType: 'image', targetId: 107, detail: 'L1 无原图下载权限', ip: '223.104.5.7', ua: 'Chrome', result: 0, createTime: '2026-09-27T08:00:00.000Z' },
  { id: 6, userType: 'user', uid: 1, tempId: null, action: 'login_failed', targetType: 'user', targetId: null, detail: 'password mismatch, ip=203.0.113.9', ip: '203.0.113.9', ua: 'curl/8.5', result: 0, createTime: '2026-09-28T01:00:00.000Z' },
  { id: 7, userType: 'user', uid: 2, tempId: null, action: 'tag_merge', targetType: 'tag', targetId: 9, detail: 'from=21 to=9, moved=4 images', ip: '112.64.33.88', ua: 'Chrome', result: 1, createTime: '2026-09-28T03:00:00.000Z' },
  { id: 8, userType: 'user', uid: 3, tempId: null, action: 'share_create', targetType: 'share', targetId: 1, detail: 'album=1, coser=4, snapshot=0, expire=2026-11-15', ip: '114.88.22.10', ua: 'Chrome', result: 1, createTime: '2026-09-26T12:00:00.000Z' },
  { id: 9, userType: 'system', uid: null, tempId: null, action: 'cron_expire_share', targetType: 'share', targetId: 3, detail: '到期自动失效 1 条', ip: '-', ua: 'scheduler', result: 1, createTime: '2026-09-16T00:05:00.000Z' },
  { id: 10, userType: 'user', uid: 1, tempId: null, action: 'settings_update', targetType: 'setting', targetId: null, detail: 'watermark.enabled=false', ip: '112.64.33.88', ua: 'Chrome', result: 1, createTime: '2026-09-29T02:00:00.000Z' },
  { id: 11, userType: 'user', uid: 3, tempId: null, action: 'temp_create', targetType: 'temp', targetId: 301, detail: 'code=PK-2026-0913, flags=preview,uploadImg,editTag', ip: '114.88.22.10', ua: 'Chrome', result: 1, createTime: '2026-09-13T02:00:00.000Z' },
  { id: 12, userType: 'user', uid: 4, tempId: null, action: 'batch_visibility', targetType: 'image', targetId: 103, detail: 'target=public, rejected=SET_PUBLIC_FORBIDDEN', ip: '223.104.5.7', ua: 'Chrome', result: 0, createTime: '2026-09-29T12:00:00.000Z' },
];

/**
 * CSV 导出要转义公式注入前缀（PRD 12.12）：以 = + - @ 打头的单元格会被
 * Excel/WPS 当公式执行，前面补单引号让它落地成文本。
 */
export function csvCell(value: string | number | null): string {
  const raw = value === null ? '' : String(value);
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export function toCsv(headers: string[], rows: (string | number | null)[][]): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}
