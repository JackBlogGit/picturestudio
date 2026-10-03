/**
 * 真后端演示库的种子数据（`npm run seed` 写进 DB）。
 *
 * 这份数据与 `client/src/api/mock/db.ts` + `mock/tables.ts` 逐行对齐，目的只有一个：
 * 关掉 VITE_USE_MOCK 之后，同一个身份在同一页看到的内容、同一操作的回执不应该变，
 * 否则「mock 已过验收」的结论没法迁移到真后端上。改这一份时先看一眼 mock 那两份。
 *
 * 刻意不照抄的两处：
 * - 网盘文件行的体积：mock 写的是 412MB 之类的假数，真库必须等于磁盘上的真实字节，
 *   否则下载接口的 Content-Length 与实际字节不符。演示体积因此收在几十 KB 量级。
 * - 口令：mock 存明文，这里存 bcrypt 密文；演示口令统一 demo1234，由 seed 现场哈希。
 */
import { Visibility } from '../common/enums/visibility.enum';
import { UserLevel } from '../common/enums/user-level.enum';
import {
  AlbumStage,
  AlbumStatus,
  CrawlerLinkSource,
  CrawlerLinkStatus,
  CrawlerPlatform,
  FolderKind,
  MessageStatus,
  TagType,
} from '../entities';

/** 四个正式成员：id 与 mock 的 uid 一致，相册 createUid / 白名单 ownerUid 都靠它对齐 */
export const SEED_USERS = [
  { id: 1, username: 'admin', nickname: '夜刃', position: '创始人 · 摄影', level: 4, spaceQuota: 0, usedSpace: 0 },
  { id: 2, username: 'baize', nickname: '白泽', position: '后期主管', level: 3, spaceQuota: 5_368_709_120, usedSpace: 1_932_735_283 },
  { id: 3, username: 'acheng', nickname: '阿澄', position: '场照摄影', level: 2, spaceQuota: 3_221_225_472, usedSpace: 903_008_758 },
  { id: 4, username: 'xiaoman', nickname: '小满', position: '见习摄影', level: 1, spaceQuota: 1_073_741_824, usedSpace: 128_902_128 },
] as const;

/**
 * 三条临时账号覆盖任务页的三种状态：进行中（301）、两阶段都完成（302）、已过期未回收（303）。
 * accountNo 就是 mock 里的「帐户ID」，同时也是拍展子树里的目录名（规则 3）。
 */
export const SEED_TEMPS = [
  {
    id: 301,
    accountNo: 'PK-2026-0913',
    displayName: '柚子',
    ownerUid: 3,
    phone: '13800001234',
    shootingNote: 'CP29 雷电将军场照 + 棚拍返图',
    expireTime: '2026-12-31T23:59:59.000Z',
    // 下载关着，用来验证临时账号看不到原图按钮（PRD 7.3）
    allowPreview: 1,
    allowDownload: 0,
    allowEditTag: 1,
    spaceQuota: 1_073_741_824,
    usedSpace: 314_572_800,
    preStage: 1,
    postStage: 0,
    albumIds: [1, 2],
    folderIds: [7],
    createTime: '2026-09-13T02:00:00.000Z',
  },
  {
    id: 302,
    accountNo: 'PK-2026-0920',
    displayName: '青野',
    ownerUid: 2,
    phone: null as string | null,
    shootingNote: 'IDO 春日祭 初音未来专题',
    expireTime: '2026-11-30T23:59:59.000Z',
    allowPreview: 1,
    allowDownload: 1,
    allowEditTag: 1,
    spaceQuota: 1_073_741_824,
    usedSpace: 41_943_040,
    preStage: 1,
    postStage: 1,
    albumIds: [2],
    folderIds: [16],
    createTime: '2026-09-20T02:00:00.000Z',
  },
  {
    id: 303,
    accountNo: 'PK-2026-0928',
    displayName: '柯柯',
    ownerUid: 3,
    phone: null as string | null,
    shootingNote: '到期未回收，可直接注销',
    expireTime: '2026-09-30T23:59:59.000Z',
    allowPreview: 1,
    allowDownload: 1,
    allowEditTag: 0,
    spaceQuota: 1_073_741_824,
    usedSpace: 0,
    preStage: 0,
    postStage: 0,
    albumIds: [1],
    folderIds: [17],
    createTime: '2026-09-28T02:00:00.000Z',
  },
];

export const SEED_TAGS = [
  { id: 1, tagType: TagType.Event, tagName: 'CP29' },
  { id: 2, tagType: TagType.Event, tagName: 'IDO 春日祭' },
  { id: 3, tagType: TagType.Event, tagName: 'WF 模型展' },
  { id: 4, tagType: TagType.Coser, tagName: '柚子' },
  { id: 5, tagType: TagType.Coser, tagName: '青野' },
  { id: 6, tagType: TagType.Coser, tagName: '小满' },
  { id: 7, tagType: TagType.Role, tagName: '雷电将军' },
  { id: 8, tagType: TagType.Role, tagName: '芙莉莲' },
  { id: 9, tagType: TagType.Role, tagName: '初音未来' },
  { id: 10, tagType: TagType.Role, tagName: '哥伦比娅' },
  { id: 11, tagType: TagType.Photographer, tagName: '夜刃' },
  { id: 12, tagType: TagType.Photographer, tagName: '阿澄' },
  { id: 13, tagType: TagType.Status, tagName: '待修' },
  { id: 14, tagType: TagType.Status, tagName: '精修完成' },
  { id: 15, tagType: TagType.Status, tagName: '已交付' },
] as const;

export const SEED_ALBUMS = [
  { id: 1, parentId: null as number | null, name: 'CP29 · 雷电将军全场返图', eventName: 'CP29', eventDate: '2026-09-26', location: '上海世博展览馆', description: '场照 + 棚拍混排，含 3 位 coser 的返图。', coverImgId: 101, visibility: Visibility.Public, status: 1, stage: AlbumStage.Post, createUid: 3, albumCaps: null as string[] | null, createTime: '2026-09-26T09:12:00.000Z' },
  { id: 2, parentId: null, name: 'IDO 春日祭 · 芙莉莲专题', eventName: 'IDO 春日祭', eventDate: '2026-08-15', location: '杭州电竞中心', description: '只对内部开放的精修选题。', coverImgId: 201, visibility: Visibility.Member, status: 1, stage: AlbumStage.Post, createUid: 3, albumCaps: null, createTime: '2026-08-15T10:40:00.000Z' },
  { id: 3, parentId: null, name: '内部审稿 · 未定稿', eventName: 'CP29', eventDate: '2026-09-27', location: '线上', description: '调色未定，禁止外传。', coverImgId: null, visibility: Visibility.Admin, status: 1, stage: AlbumStage.Pre, createUid: 2, albumCaps: null, createTime: '2026-09-27T02:20:00.000Z' },
  { id: 4, parentId: null, name: '阿澄的个人试机片', eventName: 'WF 模型展', eventDate: '2026-07-20', location: '北京国家会议中心', description: '个人练习稿，暂不入库。', coverImgId: null, visibility: Visibility.Private, status: 1, stage: AlbumStage.Pre, createUid: 3, albumCaps: null, createTime: '2026-07-20T13:05:00.000Z' },
  { id: 5, parentId: null, name: '2025 冬季场 · 已归档', eventName: 'IDO 春日祭', eventDate: '2025-12-20', location: '杭州电竞中心', description: '历史相册，只读。', coverImgId: null, visibility: Visibility.Member, status: 2, stage: AlbumStage.Post, createUid: 1, albumCaps: null, createTime: '2025-12-20T08:00:00.000Z' },
  { id: 6, parentId: null, name: 'CP29 · 交付锁定盘', eventName: 'CP29', eventDate: '2026-09-28', location: '上海世博展览馆', description: '已交付 coser，任何改动都会被拒（PRD 4.2）。', coverImgId: null, visibility: Visibility.Member, status: 3, stage: AlbumStage.Post, createUid: 2, albumCaps: null, createTime: '2026-09-28T06:30:00.000Z' },
  // D25 的三条轴要靠子相册才验得出来（父关子也关），mock 没有子册，这里补一本
  { id: 7, parentId: 1, name: 'CP29 · 主舞台棚拍', eventName: 'CP29', eventDate: '2026-09-26', location: '上海世博展览馆', description: '棚拍分册，用来验相册级开关的继承。', coverImgId: null, visibility: Visibility.Public, status: 1, stage: AlbumStage.Post, createUid: 3, albumCaps: [], createTime: '2026-09-26T11:00:00.000Z' },
];

export interface SeedImage {
  id: number;
  albumId: number;
  filename: string;
  width: number;
  height: number;
  visibility: Visibility;
  /** D31 单图阶段：null = 未标过，投影时回落到相册阶段 */
  imgStage: AlbumStage | null;
  uploadUid: number;
  uploadTempId: number | null;
  tags: number[];
  shotTime: string | null;
  sort: number;
}

export const SEED_IMAGES: SeedImage[] = [
  { id: 101, albumId: 1, filename: 'DSC04123.jpg', width: 7008, height: 4672, visibility: Visibility.Public, imgStage: AlbumStage.Post, uploadUid: 3, uploadTempId: null, tags: [1, 4, 7, 12, 15], shotTime: '2026-09-26T06:31:00.000Z', sort: 1 },
  { id: 102, albumId: 1, filename: 'DSC04188.jpg', width: 7008, height: 4672, visibility: Visibility.Public, imgStage: AlbumStage.Post, uploadUid: 3, uploadTempId: null, tags: [1, 4, 7, 12, 14], shotTime: '2026-09-26T06:52:00.000Z', sort: 2 },
  { id: 103, albumId: 1, filename: 'IMG_2231.jpg', width: 6000, height: 4000, visibility: Visibility.Public, imgStage: AlbumStage.Post, uploadUid: 2, uploadTempId: null, tags: [1, 5, 9, 11, 13], shotTime: '2026-09-26T07:14:00.000Z', sort: 3 },
  { id: 104, albumId: 1, filename: 'IMG_2240.jpg', width: 4000, height: 6000, visibility: Visibility.Public, imgStage: null, uploadUid: 2, uploadTempId: null, tags: [1, 5, 9, 11], shotTime: null, sort: 4 },
  { id: 105, albumId: 1, filename: 'DSC04201.jpg', width: 7008, height: 4672, visibility: Visibility.Member, imgStage: null, uploadUid: 3, uploadTempId: null, tags: [1, 4, 7, 12, 13], shotTime: '2026-09-26T08:02:00.000Z', sort: 5 },
  { id: 106, albumId: 1, filename: 'DSC04255.jpg', width: 7008, height: 4672, visibility: Visibility.Private, imgStage: AlbumStage.Pre, uploadUid: 3, uploadTempId: null, tags: [1, 6, 10, 12], shotTime: '2026-09-26T08:33:00.000Z', sort: 6 },
  { id: 107, albumId: 1, filename: 'DSC04302.jpg', width: 7008, height: 4672, visibility: Visibility.Public, imgStage: AlbumStage.Post, uploadUid: 4, uploadTempId: null, tags: [1, 6, 10, 12, 13], shotTime: '2026-09-26T09:01:00.000Z', sort: 7 },
  { id: 108, albumId: 1, filename: 'DSC04310.jpg', width: 7008, height: 4672, visibility: Visibility.Member, imgStage: null, uploadUid: 1, uploadTempId: null, tags: [1, 4, 8, 11, 14], shotTime: '2026-09-26T09:18:00.000Z', sort: 8 },
  { id: 109, albumId: 1, filename: 'IMG_0031.jpg', width: 3024, height: 4032, visibility: Visibility.Public, imgStage: AlbumStage.Post, uploadUid: 3, uploadTempId: 301, tags: [1, 4, 7, 15], shotTime: null, sort: 9 },
  { id: 110, albumId: 1, filename: 'IMG_0032.jpg', width: 3024, height: 4032, visibility: Visibility.Public, imgStage: null, uploadUid: 3, uploadTempId: 301, tags: [1, 4, 7, 13], shotTime: null, sort: 10 },

  { id: 201, albumId: 2, filename: 'DSC01120.jpg', width: 6720, height: 4480, visibility: Visibility.Member, imgStage: null, uploadUid: 3, uploadTempId: null, tags: [2, 5, 8, 12, 14], shotTime: '2026-08-15T05:40:00.000Z', sort: 1 },
  { id: 202, albumId: 2, filename: 'DSC01144.jpg', width: 6720, height: 4480, visibility: Visibility.Public, imgStage: AlbumStage.Post, uploadUid: 3, uploadTempId: null, tags: [2, 5, 8, 12, 15], shotTime: '2026-08-15T06:02:00.000Z', sort: 2 },
  { id: 203, albumId: 2, filename: 'DSC01189.jpg', width: 6720, height: 4480, visibility: Visibility.Member, imgStage: null, uploadUid: 2, uploadTempId: null, tags: [2, 6, 9, 11], shotTime: '2026-08-15T06:25:00.000Z', sort: 3 },
  { id: 204, albumId: 2, filename: 'DSC01203.jpg', width: 6720, height: 4480, visibility: Visibility.Admin, imgStage: AlbumStage.Pre, uploadUid: 2, uploadTempId: null, tags: [2, 6, 9, 11, 13], shotTime: '2026-08-15T06:47:00.000Z', sort: 4 },
  { id: 205, albumId: 2, filename: 'IMG_7712.jpg', width: 4000, height: 6000, visibility: Visibility.Member, imgStage: null, uploadUid: 3, uploadTempId: 301, tags: [2, 5, 8, 14], shotTime: null, sort: 5 },
  { id: 206, albumId: 2, filename: 'IMG_7719.jpg', width: 4000, height: 6000, visibility: Visibility.Public, imgStage: AlbumStage.Post, uploadUid: 3, uploadTempId: 301, tags: [2, 5, 8, 13], shotTime: null, sort: 6 },

  { id: 301, albumId: 3, filename: 'DSC05001.jpg', width: 7008, height: 4672, visibility: Visibility.Admin, imgStage: AlbumStage.Pre, uploadUid: 2, uploadTempId: null, tags: [1, 4, 7, 11, 13], shotTime: '2026-09-27T03:10:00.000Z', sort: 1 },
  { id: 302, albumId: 3, filename: 'DSC05002.jpg', width: 7008, height: 4672, visibility: Visibility.Admin, imgStage: null, uploadUid: 2, uploadTempId: null, tags: [1, 4, 7, 11, 13], shotTime: '2026-09-27T03:22:00.000Z', sort: 2 },
  { id: 303, albumId: 3, filename: 'DSC05009.jpg', width: 7008, height: 4672, visibility: Visibility.Private, imgStage: null, uploadUid: 1, uploadTempId: null, tags: [1, 5, 10, 12], shotTime: '2026-09-27T03:55:00.000Z', sort: 3 },

  { id: 401, albumId: 4, filename: 'DSC00900.jpg', width: 6000, height: 4000, visibility: Visibility.Private, imgStage: null, uploadUid: 3, uploadTempId: null, tags: [3, 12], shotTime: '2026-07-20T07:00:00.000Z', sort: 1 },
  { id: 402, albumId: 4, filename: 'DSC00912.jpg', width: 6000, height: 4000, visibility: Visibility.Private, imgStage: AlbumStage.Pre, uploadUid: 3, uploadTempId: null, tags: [3, 12, 13], shotTime: '2026-07-20T07:24:00.000Z', sort: 2 },

  { id: 501, albumId: 5, filename: 'DSC00011.jpg', width: 6000, height: 4000, visibility: Visibility.Member, imgStage: null, uploadUid: 1, uploadTempId: null, tags: [2, 6, 9, 15], shotTime: '2025-12-20T06:10:00.000Z', sort: 1 },
  { id: 502, albumId: 5, filename: 'DSC00024.jpg', width: 6000, height: 4000, visibility: Visibility.Public, imgStage: null, uploadUid: 1, uploadTempId: null, tags: [2, 6, 9, 15], shotTime: '2025-12-20T06:40:00.000Z', sort: 2 },

  { id: 601, albumId: 6, filename: 'DSC06001.jpg', width: 7008, height: 4672, visibility: Visibility.Member, imgStage: null, uploadUid: 2, uploadTempId: null, tags: [1, 4, 7, 15], shotTime: '2026-09-28T04:00:00.000Z', sort: 1 },
  { id: 602, albumId: 6, filename: 'DSC06002.jpg', width: 7008, height: 4672, visibility: Visibility.Member, imgStage: null, uploadUid: 2, uploadTempId: null, tags: [1, 4, 7, 15], shotTime: '2026-09-28T04:12:00.000Z', sort: 2 },

  // 子相册（7）里放两张，D25 的继承与 tempAccess 反枚举才有东西可验
  { id: 701, albumId: 7, filename: 'DSC07001.jpg', width: 6000, height: 4000, visibility: Visibility.Public, imgStage: AlbumStage.Post, uploadUid: 3, uploadTempId: null, tags: [1, 4, 7, 15], shotTime: '2026-09-26T11:20:00.000Z', sort: 1 },
  { id: 702, albumId: 7, filename: 'DSC07002.jpg', width: 6000, height: 4000, visibility: Visibility.Member, imgStage: null, uploadUid: 3, uploadTempId: null, tags: [1, 4, 8, 14], shotTime: '2026-09-26T11:35:00.000Z', sort: 2 },
];

/** 网盘目录：id 与 mock 的 FOLDERS 一致，临时账号白名单 folderIds 直接引用这里的 7/16/17 */
export const SEED_FOLDERS = [
  { id: 1, parentId: null as number | null, path: '/1/', depth: 1, name: '工作室', description: '共享工程目录，文件权限1 说了算', kind: FolderKind.Workspace, ownerUid: null as number | null, visibility: Visibility.Member, createUid: 1, deletedFromId: null as number | null, deletedAt: null as string | null, createTime: '2026-07-01T02:00:00.000Z', updateTime: '2026-09-26T10:00:00.000Z' },
  { id: 2, parentId: 1, path: '/1/2/', depth: 2, name: '2026 CP29', description: 'CP29 交付批次', kind: FolderKind.Workspace, ownerUid: null, visibility: Visibility.Member, createUid: 1, deletedFromId: null, deletedAt: null, createTime: '2026-07-01T02:05:00.000Z', updateTime: '2026-09-28T10:00:00.000Z' },
  { id: 3, parentId: 2, path: '/1/2/3/', depth: 3, name: '雷电将军 · 柚子', description: '', kind: FolderKind.Workspace, ownerUid: 3, visibility: Visibility.Member, createUid: 3, deletedFromId: null, deletedAt: null, createTime: '2026-09-26T10:00:00.000Z', updateTime: '2026-09-29T10:00:00.000Z' },
  { id: 4, parentId: 2, path: '/1/2/4/', depth: 3, name: '初音未来 · 青野', description: '', kind: FolderKind.Workspace, ownerUid: 2, visibility: Visibility.Member, createUid: 3, deletedFromId: null, deletedAt: null, createTime: '2026-09-26T10:10:00.000Z', updateTime: '2026-09-26T10:10:00.000Z' },
  { id: 5, parentId: null, path: '/5/', depth: 1, name: '管理', description: '合同、票据与结算，文件权限2', kind: FolderKind.Manage, ownerUid: null, visibility: Visibility.Admin, createUid: 1, deletedFromId: null, deletedAt: null, createTime: '2026-04-01T02:00:00.000Z', updateTime: '2026-09-05T02:00:00.000Z' },
  // 规则 3：拍展整棵子树不在列表里出现，注册临时账号时往这里挂同名目录
  { id: 6, parentId: null, path: '/6/', depth: 1, name: '拍展', description: '临时账号帐户ID 目录的挂载点，列表不显示', kind: FolderKind.Shoot, ownerUid: null, visibility: Visibility.Private, createUid: 1, deletedFromId: null, deletedAt: null, createTime: '2026-06-01T02:00:00.000Z', updateTime: '2026-09-25T02:00:00.000Z' },
  { id: 7, parentId: 6, path: '/6/7/', depth: 2, name: 'PK-2026-0913', description: '柚子 · CP29 现场直传', kind: FolderKind.Shoot, ownerUid: 3, visibility: Visibility.Private, createUid: 3, deletedFromId: null, deletedAt: null, createTime: '2026-09-26T12:00:00.000Z', updateTime: '2026-09-26T12:30:00.000Z' },
  { id: 8, parentId: null, path: '/8/', depth: 1, name: '夜刃', description: '个人共享文件夹', kind: FolderKind.Shared, ownerUid: 1, visibility: Visibility.Member, createUid: 1, deletedFromId: null, deletedAt: null, createTime: '2026-05-11T02:00:00.000Z', updateTime: '2026-08-01T02:00:00.000Z' },
  { id: 9, parentId: null, path: '/9/', depth: 1, name: '白泽', description: '个人共享文件夹', kind: FolderKind.Shared, ownerUid: 2, visibility: Visibility.Member, createUid: 2, deletedFromId: null, deletedAt: null, createTime: '2026-05-12T02:00:00.000Z', updateTime: '2026-09-20T02:00:00.000Z' },
  { id: 10, parentId: null, path: '/10/', depth: 1, name: '阿澄', description: '个人共享文件夹', kind: FolderKind.Shared, ownerUid: 3, visibility: Visibility.Member, createUid: 3, deletedFromId: null, deletedAt: null, createTime: '2026-06-02T02:00:00.000Z', updateTime: '2026-09-20T02:00:00.000Z' },
  // 规则 6：私人文件夹由文件权限4 决定是否拥有
  { id: 11, parentId: null, path: '/11/', depth: 1, name: '夜刃的私人文件夹', description: '', kind: FolderKind.Personal, ownerUid: 1, visibility: Visibility.Private, createUid: 1, deletedFromId: null, deletedAt: null, createTime: '2026-08-08T02:00:00.000Z', updateTime: '2026-08-08T02:00:00.000Z' },
  // 规则 11：超管私人文件夹下的爬虫，按时间建子目录
  { id: 12, parentId: 11, path: '/11/12/', depth: 2, name: '爬虫', description: '线上取回的文件', kind: FolderKind.Crawler, ownerUid: 1, visibility: Visibility.Private, createUid: 1, deletedFromId: null, deletedAt: null, createTime: '2026-09-01T02:00:00.000Z', updateTime: '2026-09-30T02:00:00.000Z' },
  { id: 13, parentId: 12, path: '/11/12/13/', depth: 3, name: '2026-09', description: '', kind: FolderKind.Crawler, ownerUid: 1, visibility: Visibility.Private, createUid: 1, deletedFromId: null, deletedAt: null, createTime: '2026-09-30T02:00:00.000Z', updateTime: '2026-09-30T02:00:00.000Z' },
  // 规则 12：垃圾箱只有超管能读改
  { id: 14, parentId: null, path: '/14/', depth: 1, name: '垃圾箱', description: '彻底删除前都待在这里，只有超管能读改', kind: FolderKind.Trash, ownerUid: null, visibility: Visibility.Private, createUid: 1, deletedFromId: null, deletedAt: null, createTime: '2026-05-01T02:00:00.000Z', updateTime: '2026-09-30T06:00:00.000Z' },
  { id: 15, parentId: null, path: '/15/', depth: 1, name: '白泽的私人文件夹', description: '', kind: FolderKind.Personal, ownerUid: 2, visibility: Visibility.Private, createUid: 2, deletedFromId: null, deletedAt: null, createTime: '2026-08-10T02:00:00.000Z', updateTime: '2026-08-10T02:00:00.000Z' },
  { id: 16, parentId: 6, path: '/6/16/', depth: 2, name: 'PK-2026-0920', description: '青野 · IDO 春日祭返图', kind: FolderKind.Shoot, ownerUid: 2, visibility: Visibility.Private, createUid: 2, deletedFromId: null, deletedAt: null, createTime: '2026-09-20T02:00:00.000Z', updateTime: '2026-09-22T02:00:00.000Z' },
  { id: 17, parentId: 6, path: '/6/17/', depth: 2, name: 'PK-2026-0928', description: '柯柯 · 还没传过图', kind: FolderKind.Shoot, ownerUid: 3, visibility: Visibility.Private, createUid: 3, deletedFromId: null, deletedAt: null, createTime: '2026-09-28T02:00:00.000Z', updateTime: '2026-09-28T02:00:00.000Z' },
];

export interface SeedFile {
  id: number;
  folderId: number;
  filename: string;
  /** 演示体积：真库的 file_size 必须等于磁盘字节，所以收在 KB 量级（mock 的 412MB 是假的） */
  bytes: number;
  mimeType: string;
  previewStatus: number;
  visibility: Visibility;
  uploadUid: number;
  uploadTempId: number | null;
  tempAccountId: number | null;
  refStage: string | null;
  deletedFromId: number | null;
  deletedAt: string | null;
  createTime: string;
}

export const SEED_FILES: SeedFile[] = [
  { id: 901, folderId: 3, filename: 'CP29_柚子_雷电将军_精修.psd', bytes: 48_120, mimeType: 'image/vnd.adobe.photoshop', previewStatus: 1, visibility: Visibility.Member, uploadUid: 3, uploadTempId: null, tempAccountId: null, refStage: null, deletedFromId: null, deletedAt: null, createTime: '2026-09-27T10:00:00.000Z' },
  { id: 902, folderId: 3, filename: 'CP29_柚子_交付稿.zip', bytes: 24_576, mimeType: 'application/zip', previewStatus: 2, visibility: Visibility.Member, uploadUid: 3, uploadTempId: null, tempAccountId: null, refStage: null, deletedFromId: null, deletedAt: null, createTime: '2026-09-28T10:00:00.000Z' },
  { id: 903, folderId: 4, filename: 'CP29_青野_初音未来.png', bytes: 18_240, mimeType: 'image/png', previewStatus: 1, visibility: Visibility.Member, uploadUid: 2, uploadTempId: null, tempAccountId: null, refStage: null, deletedFromId: null, deletedAt: null, createTime: '2026-09-27T11:00:00.000Z' },
  { id: 904, folderId: 1, filename: '夜刃调色预设-v4.xmp', bytes: 2_048, mimeType: 'application/octet-stream', previewStatus: 2, visibility: Visibility.Member, uploadUid: 1, uploadTempId: null, tempAccountId: null, refStage: null, deletedFromId: null, deletedAt: null, createTime: '2026-08-01T02:00:00.000Z' },
  { id: 905, folderId: 10, filename: '样片-2026春夏合集.pdf', bytes: 32_768, mimeType: 'application/pdf', previewStatus: 1, visibility: Visibility.Member, uploadUid: 3, uploadTempId: null, tempAccountId: null, refStage: null, deletedFromId: null, deletedAt: null, createTime: '2026-09-20T02:00:00.000Z' },
  { id: 906, folderId: 10, filename: '现场花絮-15s.mp4', bytes: 40_960, mimeType: 'video/mp4', previewStatus: 1, visibility: Visibility.Member, uploadUid: 3, uploadTempId: null, tempAccountId: null, refStage: null, deletedFromId: null, deletedAt: null, createTime: '2026-09-20T02:20:00.000Z' },
  { id: 907, folderId: 5, filename: '漫展摊位合同-CP29.pdf', bytes: 12_288, mimeType: 'application/pdf', previewStatus: 1, visibility: Visibility.Admin, uploadUid: 1, uploadTempId: null, tempAccountId: null, refStage: null, deletedFromId: null, deletedAt: null, createTime: '2026-09-05T02:00:00.000Z' },
  // 规则 12：这一条已经在垃圾箱里，记下原目录 10，用来验「还原回到哪」
  { id: 908, folderId: 14, filename: '试机片-参数记录.xlsx', bytes: 6_144, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', previewStatus: 2, visibility: Visibility.Member, uploadUid: 3, uploadTempId: null, tempAccountId: null, refStage: null, deletedFromId: 10, deletedAt: '2026-09-30T06:00:00.000Z', createTime: '2026-08-08T02:00:00.000Z' },
  { id: 909, folderId: 2, filename: '工作室色卡.7z', bytes: 8_192, mimeType: 'application/x-7z-compressed', previewStatus: 2, visibility: Visibility.Member, uploadUid: 1, uploadTempId: null, tempAccountId: null, refStage: null, deletedFromId: null, deletedAt: null, createTime: '2026-07-02T02:00:00.000Z' },
  { id: 910, folderId: 7, filename: 'IMG_0031-直传.jpg', bytes: 20_480, mimeType: 'image/jpeg', previewStatus: 1, visibility: Visibility.Private, uploadUid: 3, uploadTempId: 301, tempAccountId: 301, refStage: 'pre', deletedFromId: null, deletedAt: null, createTime: '2026-09-26T12:30:00.000Z' },
  { id: 911, folderId: 11, filename: '摊位报价草稿.xlsx', bytes: 4_096, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', previewStatus: 2, visibility: Visibility.Private, uploadUid: 1, uploadTempId: null, tempAccountId: null, refStage: null, deletedFromId: null, deletedAt: null, createTime: '2026-08-08T02:20:00.000Z' },
  { id: 912, folderId: 13, filename: '线上取回-场地参考图.png', bytes: 16_384, mimeType: 'image/png', previewStatus: 1, visibility: Visibility.Private, uploadUid: 1, uploadTempId: null, tempAccountId: null, refStage: null, deletedFromId: null, deletedAt: null, createTime: '2026-09-30T02:10:00.000Z' },
  { id: 913, folderId: 16, filename: 'IMG_3301-现场直传.jpg', bytes: 20_480, mimeType: 'image/jpeg', previewStatus: 1, visibility: Visibility.Private, uploadUid: 2, uploadTempId: 302, tempAccountId: 302, refStage: 'pre', deletedFromId: null, deletedAt: null, createTime: '2026-09-21T02:00:00.000Z' },
  { id: 914, folderId: 16, filename: 'IDO_青野_初音未来_精修.psd', bytes: 48_120, mimeType: 'image/vnd.adobe.photoshop', previewStatus: 1, visibility: Visibility.Private, uploadUid: 2, uploadTempId: null, tempAccountId: 302, refStage: 'post', deletedFromId: null, deletedAt: null, createTime: '2026-09-22T02:00:00.000Z' },
];

/** 五种分享链接覆盖 `/s/:token` 的全部分支：可下载、带密码+快照、已过期、已注销、person 口径 */
export const SEED_SHARE_LINKS = [
  { id: 1, shareToken: 'pk-youzi-cp29-a7f3', albumId: 1, coserTagId: 4, filterJson: { coser: [4] }, snapshot: 0, password: null as string | null, allowDownload: 1, visitCount: 42, expireTime: '2026-11-15T23:59:59.000Z', revoked: 0, createUid: 3, createTime: '2026-09-26T12:00:00.000Z', lastVisitTime: '2026-09-30T09:12:00.000Z', imageIds: [] as number[] },
  { id: 2, shareToken: 'pk-qingye-ido-91c2', albumId: 2, coserTagId: 5, filterJson: { coser: [5], role: [9] }, snapshot: 1, password: 'qingye', allowDownload: 0, visitCount: 7, expireTime: '2026-11-01T23:59:59.000Z', revoked: 0, createUid: 2, createTime: '2026-08-16T03:30:00.000Z', lastVisitTime: '2026-09-28T14:20:00.000Z', imageIds: [203, 205] },
  { id: 3, shareToken: 'pk-expired-0001', albumId: 1, coserTagId: 6, filterJson: { coser: [6] }, snapshot: 0, password: null, allowDownload: 0, visitCount: 15, expireTime: '2026-09-15T23:59:59.000Z', revoked: 0, createUid: 3, createTime: '2026-09-01T08:00:00.000Z', lastVisitTime: '2026-09-14T20:05:00.000Z', imageIds: [] },
  { id: 4, shareToken: 'pk-revoked-0002', albumId: 2, coserTagId: 4, filterJson: { coser: [4] }, snapshot: 0, password: null, allowDownload: 1, visitCount: 3, expireTime: '2026-12-01T23:59:59.000Z', revoked: 1, createUid: 2, createTime: '2026-08-20T06:00:00.000Z', lastVisitTime: '2026-08-21T11:00:00.000Z', imageIds: [] },
  { id: 5, shareToken: 'pk-person-qingye-4d18', albumId: null, coserTagId: 5, filterJson: { coser: [5] }, snapshot: 0, password: null, allowDownload: 0, visitCount: 3, expireTime: '2026-12-20T23:59:59.000Z', revoked: 0, createUid: 2, createTime: '2026-09-27T07:40:00.000Z', lastVisitTime: '2026-09-29T15:02:00.000Z', imageIds: [] },
];

/** 站点配置：与 mock 的 SETTINGS 逐键相同，后台「站点设置」页与上传闸门都读这一份 */
export const SEED_SETTINGS: Record<string, { value: string; remark: string }> = {
  'upload.max_image_size': { value: '52428800', remark: '单张原图上限（字节）' },
  'upload.max_file_size': { value: '2147483648', remark: '网盘单文件上限（字节）' },
  'upload.image_extensions': { value: '[".jpg",".jpeg",".png",".webp",".heic",".tif",".tiff",".raw",".cr2",".nef",".arw"]', remark: '图片扩展名白名单' },
  'upload.file_extensions': { value: '[".jpg",".jpeg",".png",".webp",".pdf",".doc",".docx",".xls",".xlsx",".ppt",".pptx",".psd",".ai",".zip",".7z",".rar",".mp4",".mov",".preset",".xmp"]', remark: '网盘扩展名白名单' },
  'upload.blocked_extensions': { value: '[".exe",".bat",".cmd",".sh",".msi",".dll",".apk",".jar",".js",".vbs",".ps1",".scr"]', remark: '黑名单，优先级高于白名单' },
  'upload.chunk_size': { value: '5242880', remark: '分片大小（字节）' },
  'vault.max_file_size': { value: '52428800', remark: 'D26 加密空间单文件上限，比网盘紧' },
  'upload.rate_limit': { value: '{"windowMs":60000,"max":30}', remark: '上传接口限流' },
  'preview.max_width': { value: '2048', remark: '预览图最长边' },
  'preview.thumb_width': { value: '400', remark: '缩略图最长边' },
  'preview.quality': { value: '82', remark: '派生图质量' },
  'watermark.enabled': { value: 'false', remark: '预览图水印开关' },
  'watermark.text': { value: '皮克社工作室', remark: '水印文字' },
  'watermark.position': { value: 'bottomRight', remark: '水印位置' },
  'watermark.opacity': { value: '0.35', remark: '水印不透明度' },
  'storage.default_quota': { value: '10737418240', remark: '新建账号默认配额' },
  'drive.perm1_workspace': { value: '2', remark: '文件权限1 的最低等级门槛' },
  'drive.perm2_manage': { value: '3', remark: '文件权限2 的最低等级门槛' },
  'drive.perm3_shared': { value: '2', remark: '文件权限3 的最低等级门槛' },
  'drive.perm4_personal': { value: '3', remark: '文件权限4 的最低等级门槛' },
  'guest.comment_enabled': { value: 'false', remark: '是否开放游客留言' },
  'security.session_ttl': { value: '{"user":86400,"temp":3600}', remark: '会话时长（秒）' },
  'temp.default_quota': { value: '1073741824', remark: '临时账号默认配额' },
  'temp.max_days_for_l1_l2': { value: '7', remark: 'D9：L1/L2 开号的最大天数' },
  'task.overdue_notify_enabled': { value: 'true', remark: '16 章逾期提醒' },
  'site.title': { value: '皮克社工作室', remark: '站名' },
  'site.intro': {
    value:
      '专注漫展场照与 Cos 返图的摄影工作室，现场拍摄当天粗修、三天内精修交付。\n所有返图都按「漫展 / Coser / 角色」三级标签归档，找到自己的那组照片只需要点两下。\n原图一律经鉴权接口下发，游客与分享链接只能看到压缩预览，交付更安心。',
    remark: '首页简介',
  },
  'site.contact': {
    value:
      '[{"type":"weibo","label":"微博","value":"皮克社工作室"},{"type":"bilibili","label":"B站","value":"space.bilibili.com/皮克社"},{"type":"qqgroup","label":"约稿群","value":"123456789"},{"type":"email","label":"约稿邮箱","value":"hello@pikeshe.example"}]',
    remark: 'D22：联系我们页的渠道列表',
  },
};

export const SEED_MESSAGES = [
  { id: 1, nickname: '柚子', content: 'CP29 那组雷电将军太喜欢了，已经设成头像了！', albumId: 1, status: 1, auditUid: 1, createTime: '2026-09-27T10:20:00.000Z', auditTime: '2026-09-27T12:00:00.000Z' },
  { id: 2, nickname: '青野', content: 'IDO 的初音未来什么时候出第二批精修？', albumId: 2, status: 1, auditUid: 1, createTime: '2026-08-20T06:00:00.000Z', auditTime: '2026-08-20T09:00:00.000Z' },
  { id: 3, nickname: '路人甲', content: '请问还接约稿吗，想拍一套 WF 的哥伦比娅。', albumId: null, status: 1, auditUid: 2, createTime: '2026-09-28T14:00:00.000Z', auditTime: '2026-09-28T15:00:00.000Z' },
  { id: 4, nickname: '广告代发', content: '加微信 xxx 低价代充', albumId: null, status: 2, auditUid: 1, createTime: '2026-09-29T02:00:00.000Z', auditTime: '2026-09-29T02:30:00.000Z' },
  { id: 5, nickname: '小林', content: '现场那天下着雨还拍得这么稳，佩服。', albumId: 1, status: 0, auditUid: null, createTime: '2026-09-30T08:00:00.000Z', auditTime: null },
];

/** 站外来源登记（D28，只有 L4 看得见），三条覆盖三个跟进状态 */
export const SEED_CRAWLER_LINKS = [
  { id: 1, url: 'https://weibo.com/u/100001#/pk-cp29-rain', title: 'CP29 场照 雷电将军', snippet: '柚子 cos 的雷电将军场照，含工作室水印', domain: 'weibo.com', platform: CrawlerPlatform.Weibo, keyword: '皮克社 CP29', source: CrawlerLinkSource.Search, status: 1, note: '转载未标注来源，待联系', createUid: 1 },
  { id: 2, url: 'https://space.bilibili.com/100002/video/BV1xx', title: 'IDO 春日祭 初音未来 图集', snippet: '视频简介里写了「图源工作室」', domain: 'space.bilibili.com', platform: CrawlerPlatform.Bilibili, keyword: '皮克社 青野', source: CrawlerLinkSource.Search, status: 2, note: '已授权，注明出处', createUid: 1 },
  { id: 3, url: 'https://www.example-other.net/gallery/42', title: '搬运相册', snippet: '', domain: 'example-other.net', platform: CrawlerPlatform.Other, keyword: '皮克社', source: CrawlerLinkSource.Manual, status: 3, note: '已提交投诉', createUid: 1 },
];
