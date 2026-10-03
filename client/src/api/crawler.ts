/**
 * 站外来源登记接口层（PRD 10.8 / D28）。整组路由只对 L4 超管开放，
 * 这一层不判断「能不能用」——服务端回什么码位页面就显示什么，
 * 免得前端猜权限猜出一套和后台不一样的口径。
 */
import { api } from './client';
import type {
  CrawlerLinkStatus,
  CrawlerLinkView,
  CrawlerPlatform,
  CrawlerProbeResult,
  CrawlerSearchResult,
  Page,
} from '@/types/api';

/** 与后端 CRAWLER_SEARCH_LIMITS 同值：单次检索条数上限，超了服务端按 fallback 收敛 */
export const SEARCH_LIMITS = { min: 1, max: 20, fallback: 10 } as const;

export interface CrawlerLinkInput {
  url: string;
  title?: string;
  snippet?: string;
  keyword?: string;
}

/** 检索只是取候选结果，绝不自动落库——是否登记由超管逐条点「登记」 */
export const searchCrawler = (keyword: string, limit: number = SEARCH_LIMITS.fallback) =>
  api.post<CrawlerSearchResult>('/admin/crawler/search', { keyword, limit });

/** 手敲登记前回读页面标题与首段，读不到留空由超管自己填 */
export const probeCrawler = (url: string) => api.post<CrawlerProbeResult>('/admin/crawler/probe', { url });

export const listCrawlerLinks = (
  query: { status?: CrawlerLinkStatus; platform?: CrawlerPlatform; q?: string; page?: number; pageSize?: number } = {},
) => api.get<Page<CrawlerLinkView>>('/admin/crawler/links', { query });

/** 重复登记回 409 LINK_EXISTS，data 里带已存在的 { id, status } */
export const createCrawlerLink = (body: CrawlerLinkInput) => api.post<CrawlerLinkView>('/admin/crawler/links', body);

export const updateCrawlerLinkStatus = (id: number, body: { status: CrawlerLinkStatus; note?: string }) =>
  api.patch<CrawlerLinkView>(`/admin/crawler/links/${id}`, body);

export const deleteCrawlerLink = (id: number) => api.delete<{ id: number; removed: true }>(`/admin/crawler/links/${id}`);
