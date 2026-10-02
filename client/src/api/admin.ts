/**
 * 后台接口层（PRD 10.5）。权限在服务端收口：L3 起进，L3 只能操作 L1/L2，
 * 站点设置仅 L4 可写，所以这里的类型不区分角色，页面按 capabilities 决定按钮。
 */
import { api } from './client';
import type {
  AdminSettingRow,
  AdminTagRow,
  AdminTempRow,
  AdminUserRow,
  AlbumCapKey,
  AlbumRowView,
  AlbumStage,
  DashboardData,
  DriveGrant,
  FeatureGrant,
  LogRow,
  Page,
  TempFlags,
  UserLevel,
  Visibility,
} from '@/types/api';
export const getDashboard = () => api.get<DashboardData>('/admin/dashboard');

export const listAdminAlbums = (query: { visibility?: string; status?: number; stage?: string; keyword?: string; page?: number; pageSize?: number } = {}) =>
  api.get<Page<AlbumRowView>>('/admin/albums', { query });

// ---------------- 成员 ----------------

export const listUsers = (query: { level?: number; keyword?: string } = {}) =>
  api.get<AdminUserRow[]>('/admin/users', { query });

export const createUser = (body: {
  username: string;
  nickname: string;
  position?: string;
  level: UserLevel;
  spaceQuota?: number;
  password: string;
}) => api.post<AdminUserRow>('/admin/users', body);

export const updateUser = (
  uid: number,
  body: {
    /** 仅超级管理员可修改账号名，留空或不传即不改 */
    username?: string;
    nickname?: string;
    position?: string;
    level?: UserLevel;
    spaceQuota?: number;
    disabled?: boolean;
    confirmTransfer?: boolean;
  },
) => api.patch<AdminUserRow>(`/admin/users/${uid}`, body);

export const deleteUser = (uid: number) => api.delete<{ uid: number; removed: true }>(`/admin/users/${uid}`);

/** 规则 13：只有超管能给单个人开启文件权限1~4，四个开关整份提交 */
export const updateUserDriveGrants = (uid: number, grant: DriveGrant) =>
  api.put<AdminUserRow>(`/admin/users/${uid}/drive-grants`, grant);

/** D21：超管逐项给某个人覆盖能力位；整份替换，缺键 = inherit */
export const updateUserFeatureGrants = (uid: number, grant: FeatureGrant) =>
  api.put<AdminUserRow>(`/admin/users/${uid}/feature-grants`, grant);

export const resetPassword = (uid: number, newPassword: string) =>
  api.put<{ uid: number; reset: true }>(`/admin/users/${uid}/password`, { newPassword });

// ---------------- 临时账号 ----------------

export const listTemps = (query: { onlyAlive?: 1; keyword?: string } = {}) =>
  api.get<AdminTempRow[]>('/admin/temp-accounts', { query });

export const createTemp = (body: {
  displayName: string;
  ownerUid?: number;
  days?: number;
  flags?: Partial<TempFlags>;
  albumIds?: number[];
  folderIds?: number[];
  spaceQuota?: number;
}) => api.post<AdminTempRow>('/admin/temp-accounts', body);

export const updateTemp = (
  tempId: number,
  body: { displayName?: string; flags?: Partial<TempFlags>; albumIds?: number[]; folderIds?: number[]; spaceQuota?: number; addDays?: number },
) => api.patch<AdminTempRow>(`/admin/temp-accounts/${tempId}`, body);

/** D22：仅超管，改帐户ID（同步改「拍展」下的同名目录名）与登录口令，两项都可单独改 */
export const updateTempCredentials = (tempId: number, body: { code?: string; password?: string }) =>
  api.put<AdminTempRow>(`/admin/temp-accounts/${tempId}/credentials`, body);

export const destroyTemp = (tempId: number) => api.delete<{ tempId: number; removed: true }>(`/admin/temp-accounts/${tempId}`);

// ---------------- 标签库 ----------------

export const listTags = (query: { type?: string; keyword?: string } = {}) => api.get<AdminTagRow[]>('/admin/tags', { query });

export const createTag = (body: { type: string; name: string }) => api.post<AdminTagRow>('/admin/tags', body);

export const renameTag = (id: number, name: string) => api.patch<AdminTagRow>(`/admin/tags/${id}`, { name });

export const mergeTag = (fromId: number, toId: number) =>
  api.post<{ fromId: number; toId: number; moved: number }>(`/admin/tags/${fromId}/merge`, { toId });

export const deleteTag = (id: number) => api.delete<{ id: number; cleaned: number }>(`/admin/tags/${id}`);

// ---------------- 相册写操作（前台后台共用同一组路由） ----------------

export const createAlbum = (body: {
  name: string;
  eventName?: string;
  eventDate?: string;
  location?: string;
  description?: string;
  visibility: Visibility;
  stage?: AlbumStage;
}) => api.post<AlbumRowView>('/albums', body);

export const updateAlbum = (
  id: number,
  body: Partial<Pick<AlbumRowView, 'name' | 'eventName' | 'eventDate' | 'location' | 'description' | 'visibility' | 'stage' | 'coverImgId'>>,
) => api.patch<AlbumRowView>(`/albums/${id}`, body);

export const deleteAlbum = (id: number) => api.delete<{ id: number; removedImages: number }>(`/albums/${id}`);

/** 2 已归档 / 3 已锁定 / 1 恢复正常 */
export const setAlbumStatus = (id: number, status: number) => api.patch<AlbumRowView>(`/albums/${id}/status`, { status });

/** D25：超管逐册关掉功能，传的是「已关闭」的键集，整份替换所以走 PUT（PRD 6.5 / 10.5） */
export const updateAlbumCaps = (id: number, caps: AlbumCapKey[]) =>
  api.put<AlbumRowView>(`/admin/albums/${id}/caps`, { caps });

// ---------------- 日志审计 ----------------

export const listLogs = (query: {
  userType?: string;
  uid?: number;
  action?: string;
  result?: 0 | 1;
  from?: string;
  to?: string;
  keyword?: string;
  page?: number;
  pageSize?: number;
} = {}) => api.get<Page<LogRow>>('/admin/logs', { query });

export const exportLogs = (query: Parameters<typeof listLogs>[0] = {}) =>
  api.get<{ filename: string; csv: string }>('/admin/logs/export', { query });

// ---------------- 站点设置 ----------------

export const listSettings = () => api.get<AdminSettingRow[]>('/admin/settings');

export const updateSettings = (settings: Record<string, string>) =>
  api.put<AdminSettingRow[]>('/admin/settings', { settings });
