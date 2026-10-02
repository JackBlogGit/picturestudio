/**
 * 返图链接接口层（PRD 10.3）。管理侧要成员令牌，公开侧只带 token，
 * 两条通道的路径前缀不同，页面不需要为 mock / 真接口写分支。
 */
import { api } from './client';
import type { PublicShareView, ShareLinkView } from '@/types/api';

export interface ShareLinkInput {
  coserTagId?: number | null;
  tagIds?: number[];
  snapshot?: boolean;
  password?: string;
  allowDownload?: boolean;
  expireDays?: number;
}

export const createShareLink = (albumId: number, body: ShareLinkInput) =>
  api.post<ShareLinkView>(`/albums/${albumId}/share-links`, body);

/**
 * 返给个人：以 Coser 为主体跨相册汇总，后端从命中的可对外相册里取图。
 * coserTagId 必填，缺失或标签不是 coser 类型都会被打回。
 */
export const createPersonShareLink = (body: ShareLinkInput) =>
  api.post<ShareLinkView>('/share-links/personal', body);

export const listShareLinks = (query: { album?: number; onlyAlive?: 1 } = {}) =>
  api.get<ShareLinkView[]>('/share-links', { query });

export const revokeShareLink = (id: number) => api.delete<ShareLinkView>(`/share-links/${id}`);

/** 访客侧：口令未过时后端回 403 SHARE_PASSWORD_REQUIRED，页面据此弹密码框 */
export const getPublicShare = (token: string) => api.get<PublicShareView>(`/public/share/${encodeURIComponent(token)}`);

export const unlockShare = (token: string, password: string) =>
  api.post<{ unlocked: true }>(`/public/share/${encodeURIComponent(token)}/unlock`, { password });
