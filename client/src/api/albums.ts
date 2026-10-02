import { api } from './client';
import type { AlbumCapsView, AlbumRowView, AlbumView, Page } from '@/types/api';

/** 列表接口不回张数，逐行补一次详情；补不到就留空，卡片会显示「—」而不是假数据 */
export type AlbumRow = AlbumView & AlbumCapsView & { imagesCount?: number };

async function withCount(album: AlbumRow): Promise<AlbumRow> {
  try {
    const detail = await api.get<AlbumRow>(`/albums/${album.id}`);
    return { ...album, imagesCount: detail.imagesCount };
  } catch {
    return { ...album };
  }
}

export async function listAlbums(query: Record<string, string | number | number[] | undefined> = {}): Promise<Page<AlbumRow>> {
  const page = await api.get<Page<AlbumRow>>('/albums', { query });
  const list = await Promise.all(page.list.map(withCount));
  return { ...page, list };
}

/**
 * 获取指定相册的子相册列表（含孙级）。
 * 仅对可见该父相册的身份返回结果。
 */
export async function listChildAlbums(parentId: number): Promise<AlbumRowView[]> {
  return api.get<AlbumRowView[]>(`/albums/${parentId}/children`);
}

/**
 * 创建子相册：超级管理员专属能力。
 * 子相册 visibility 不得宽于父相册（PRD 3.2）。
 */
export async function createChildAlbum(
  parentId: number,
  body: Record<string, unknown>,
): Promise<AlbumRowView> {
  return api.post<AlbumRowView>('/albums', { parentId, ...body });
}
