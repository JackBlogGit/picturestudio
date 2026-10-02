/**
 * 公开通道（无鉴权前缀）：站点简介。
 * 响应体里不含任何内部字段，游客能拿到的和成员看到的一致（PRD 12.8）。
 */
import { api } from './client';
import type { SiteInfo } from '@/types/api';

export const getSiteInfo = () => api.get<SiteInfo>('/public/site-info');
