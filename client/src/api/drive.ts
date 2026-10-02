/**
 * 网盘接口层（PRD 10.4 + 网盘 12 条规则）。目录走 /drive/folders，文件元数据走 /drive/files；
 * 页面按目录回执里的 perms 渲染按钮，删除是「进垃圾箱」，彻底删除要另外调 purge，
 * 规则 8/12 的区别由服务端判定，前端不自己猜哪个目录能直接清掉。
 */
import { api } from './client';
import type { BatchZipResult, FileView, FolderNode, Page, UploadTarget } from '@/types/api';

export type DriveSort = 'time' | 'name' | 'size' | 'type';

export const driveTree = () => api.get<FolderNode[]>('/drive/tree');

export const listFiles = (query: {
  folder?: number;
  deep?: 0 | 1;
  /** 不带 folder 时默认只在全盘搜索里返回文件；后台总览要显式要全盘清单 */
  all?: 0 | 1;
  kw?: string;
  type?: string;
  sort?: DriveSort;
  order?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
} = {}) => api.get<Page<FileView>>('/drive/files', { query });

/** 规则 10：上传目的地只回有上传权的目录 */
export const uploadTargets = () => api.get<UploadTarget[]>('/drive/upload-targets');

export const createFolder = (body: { name: string; parentId: number | null; description?: string }) =>
  api.post<FolderNode>('/drive/folders', body);

/** 目录的档位与用途都由上级继承，这里只改名字、说明和位置 */
export const updateFolder = (
  id: number,
  body: { name?: string; description?: string; parentId?: number | null },
) => api.patch<FolderNode>(`/drive/folders/${id}`, body);

export interface DeleteReceipt {
  id: number;
  /** false = 只是进了垃圾箱，还能还原（规则 7） */
  purged: boolean;
}

export const deleteFolder = (id: number) =>
  api.delete<DeleteReceipt & { movedFolders: number; movedFiles: number }>(`/drive/folders/${id}`);

export const restoreFolder = (id: number) => api.post<FolderNode>(`/drive/folders/${id}/restore`);

export const purgeFolder = (id: number) =>
  api.delete<{ id: number; purged: true; folders: number; files: number }>(`/drive/folders/${id}/purge`);

export const deleteFile = (id: number) => api.delete<DeleteReceipt>(`/drive/files/${id}`);

export const restoreFile = (id: number) => api.post<FileView>(`/drive/files/${id}/restore`);

export const purgeFile = (id: number) => api.delete<{ id: number; purged: true }>(`/drive/files/${id}/purge`);

/** 真接口是先 tus 分片上传再登记元数据，这里只提交元数据，校验口径不变 */
export const uploadFileMeta = (body: { folderId: number; filename: string; fileSize: number; mimeType: string }) =>
  api.post<FileView>('/drive/files', body);

export const batchZipFiles = (fileIds: number[]) => api.post<BatchZipResult>('/drive/files/batch-zip', { fileIds });
