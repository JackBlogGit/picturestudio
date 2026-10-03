/**
 * 分片上传的传输层。
 * 真实模式：字节走 raw `application/offset+octet-stream`，元数据走 JSON，全程不带 multipart，
 * 这样客户端文件名根本没有机会参与服务端路径拼接（PRD 12.2 / 12.3）。
 * mock 模式：只走会话与下标，不落字节，页面写法与真实模式保持一致。
 */
import { ApiError } from './error';
import { API_BASE, api, USE_MOCK } from './client';
import { getAccessToken } from './token';
import type { AlbumStage, ImageView } from '@/types/api';

export interface UploadSessionView {
  uploadId: string;
  albumId: number;
  filename: string;
  /** 本批图片的阶段（D31）；null = 上传时没选，由所属相册的阶段兜住 */
  stage: AlbumStage | null;
  size: number;
  chunkSize: number;
  totalChunks: number;
  uploaded: number[];
  missing: number[];
  expireTime: string;
}

export interface ChunkAck {
  uploaded: number;
  total: number;
  missing: number[];
}

export function createSession(
  albumId: number,
  file: { name: string; size: number },
  tempId?: number,
  stage?: AlbumStage | null,
): Promise<UploadSessionView> {
  return api.post<UploadSessionView>('/uploads', {
    albumId,
    filename: file.name,
    fileSize: file.size,
    tempId,
    stage,
  });
}

export async function putChunk(uploadId: string, index: number, bytes: Blob): Promise<ChunkAck> {
  if (USE_MOCK) return api.put<ChunkAck>(`/uploads/${uploadId}/chunk/${index}`);

  const res = await fetch(`${API_BASE}/uploads/${uploadId}/chunk/${index}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${getAccessToken()}`,
      'Content-Type': 'application/offset+octet-stream',
    },
    body: bytes,
  });
  const json = (await res.json().catch(() => null)) as { code?: string; message?: string; data?: unknown } | null;
  if (!res.ok || json?.code !== 'OK') {
    throw new ApiError(res.status, json?.code ?? 'UPLOAD_FAILED', json?.message ?? `分片 ${index} 上传失败`);
  }
  return json.data as ChunkAck;
}

export function completeUpload(uploadId: string, body: { md5Client?: string; force?: boolean } = {}): Promise<ImageView> {
  return api.post<ImageView>(`/uploads/${uploadId}/complete`, body);
}

export function abortUpload(uploadId: string): Promise<{ uploadId: string }> {
  return api.delete<{ uploadId: string }>(`/uploads/${uploadId}`);
}

/** 会话可查回缺失分片，用来做断点续传 */
export function uploadStatus(uploadId: string): Promise<UploadSessionView> {
  return api.get<UploadSessionView>(`/uploads/${uploadId}`);
}
