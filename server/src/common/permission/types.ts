import { UserLevel } from '../enums/user-level.enum';
import { Visibility } from '../enums/visibility.enum';

export enum ActorKind {
  Member = 'member',
  Temp = 'temp',
  Guest = 'guest',
  ShareVisitor = 'share',
}

export enum ResourceType {
  Album = 'album',
  Image = 'image',
  Folder = 'folder',
  File = 'file',
}

export enum Action {
  Preview = 'preview',
  DownloadOriginal = 'download_original',
  ZipDownload = 'zip_download',
  Upload = 'upload',
  EditMeta = 'edit_meta',
  EditTags = 'edit_tags',
  ChangeVisibility = 'change_visibility',
  Delete = 'delete',
  CreateShareLink = 'create_share_link',
  /** PRD 17.4：推进/回退返图工单阶段。判定看工单归属与等级，不看档位，故走 decideTaskStage 而非 decide */
  TaskStageUpdate = 'task_stage_update',
}

export enum AdminAction {
  ManageMembers = 'manage_members',
  ManageTempAccounts = 'manage_temp_accounts',
  CreateTag = 'create_tag',
  MergeOrDeleteTag = 'merge_or_delete_tag',
  ViewLogs = 'view_logs',
  ReadSiteSettings = 'read_site_settings',
  WriteSiteSettings = 'write_site_settings',
  ReviewMessages = 'review_messages',
  ShareLinkManagement = 'share_link_management',
  /** D28 爬虫：站外检索与页面元数据读取，仅超管 */
  CrawlerSearch = 'crawler_search',
  /** D28 爬虫：外链登记表的登记、状态流转与删除，仅超管 */
  CrawlerManage = 'crawler_manage',
}

export type Scope = 'none' | 'own' | 'any';

export interface MemberActor {
  kind: ActorKind.Member;
  uid: number;
  level: UserLevel;
}

/** PRD 6.2 的临时账号开关；D27 起上传两开关作废——写档能力由身份决定，临时账号只能取图 */
export interface TempFlags {
  preview: boolean;
  download: boolean;
  editTag: boolean;
}

export interface TempActor {
  kind: ActorKind.Temp;
  tempId: number;
  ownerUid: number;
  expired: boolean;
  disabled: boolean;
  flags: TempFlags;
  quotaBytes: number;
  usedBytes: number;
  albumIds: number[];
  folderIds: number[];
}

export interface GuestActor {
  kind: ActorKind.Guest;
}

export interface ShareActor {
  kind: ActorKind.ShareVisitor;
  linkId: number;
  imageIds: number[];
  allowDownload: boolean;
}

export type Actor = MemberActor | TempActor | GuestActor | ShareActor;

export interface ResourceRef {
  type: ResourceType;
  id: number;
  visibility: Visibility;
  ownerId: number;
  albumId?: number;
  folderIdChain?: number[];
  uploadTempId?: number | null;
  /** 相册或祖先文件夹的档位，用于 3.2 继承上限 */
  containerVisibilities?: Visibility[];
}

export type DenyStatus = 401 | 403 | 404 | 409 | 413;

export type Decision =
  | { allowed: true }
  | { allowed: false; status: DenyStatus; reason: string; message: string };

export const allow = (): Decision => ({ allowed: true });
export const deny = (status: DenyStatus, reason: string, message: string): Decision => ({
  allowed: false,
  status,
  reason,
  message,
});
