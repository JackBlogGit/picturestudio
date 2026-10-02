/**
 * 加密空间的接口层（PRD 5.7 / D26）。
 *
 * 这一层不碰密码学：派生密钥与加解密都在页面里做（utils/crypto.ts），
 * 这里只负责把密文与元数据送出去。字节走不走 JSON 是传输细节，因此分支收在这一层——
 * 页面代码无论对着 mock 还是对着真后端都长一个样，和 upload.ts 的 putChunk 同一套写法。
 */
import { api, API_BASE, USE_MOCK } from './client';
import { ApiError } from './error';
import { getAccessToken } from './token';
import type { VaultFileView, VaultSpaceRow, VaultStatus } from '@/types/api';
import { b64ToBytes, bytesToB64 } from '@/utils/crypto';

/** 未解锁时只给密文与体积；owner 只在超管查他人空间时带 */
export const vaultStatus = (owner?: number) =>
  api.get<VaultStatus>('/vault/status', { query: owner ? { owner } : {} });

export const vaultFiles = (owner?: number) =>
  api.get<VaultFileView[]>('/vault/files', { query: owner ? { owner } : {} });

export const vaultSpaces = () => api.get<VaultSpaceRow[]>('/vault/spaces');

export interface VaultSecretPayload {
  /** base64 的 16 字节随机盐 */
  salt: string;
  iterations: number;
  /** 口令校验子（base64 密文容器）；口令本身从不出现在这里 */
  verifier: string;
  hint?: string;
}

export const vaultSetup = (body: VaultSecretPayload) => api.post<VaultStatus>('/vault/setup', body);

/** 一条重封好的密文：id 定位旧条目，其余字段整份覆盖 */
export interface VaultRekeyItem {
  id: number;
  nameCipher: string;
  cipherSize: number;
  /** base64 的密文容器 */
  cipher: string;
}

/**
 * 改口令 = 一次请求带走全部重封条目。
 * mock 与真接口共用这份 JSON：拆成「先换参数、再逐条 raw 重传」会在中途失败时留下
 * 空间已是新密钥、某条密文还是旧密钥的中间态，那条就永久解不出来了。
 */
export const vaultRekey = (body: VaultSecretPayload & { files: VaultRekeyItem[] }) =>
  api.post<VaultStatus>('/vault/rekey', body);

export interface VaultPutInput {
  /** 文件名的密文容器（base64） */
  nameCipher: string;
  plainSize: number;
  mimeType: string;
  /** 小写扩展名（不含点），只为过 5.2 黑名单 */
  ext: string;
}

/** 提交一条密文：mock 把 base64 混在元数据里一次提交，真接口改走 raw 分片 */
export async function vaultPutFile(input: VaultPutInput, cipher: Uint8Array): Promise<VaultFileView> {
  if (USE_MOCK) {
    return api.post<VaultFileView>('/vault/files', {
      ...input,
      cipherSize: cipher.length,
      cipher: bytesToB64(cipher),
    });
  }
  const row = await api.post<VaultFileView>('/vault/files', { ...input, cipherSize: cipher.length });
  await putRaw(row.links.cipher ?? '', cipher);
  return row;
}

/** 取回密文；他人空间的条目在接口层就被拒（PRD 5.7 不给超管离线爆破的素材） */
export async function vaultGetCipher(row: VaultFileView): Promise<Uint8Array> {
  if (USE_MOCK) {
    const ack = await api.get<{ cipher: string }>(`/vault/files/${row.id}/cipher`);
    return b64ToBytes(ack.cipher);
  }
  return getRaw(row.links.cipher ?? '');
}

export const vaultDeleteFile = (id: number) => api.delete<{ id: number; purged: true }>(`/vault/files/${id}`);

/** 忘记口令的唯一出路：整空间销毁 */
export const vaultDestroySpace = () => api.post<{ uid: number; purged: number }>('/vault/destroy', {});

async function putRaw(url: string, bytes: Uint8Array): Promise<void> {
  const res = await fetch(`${API_BASE}${url}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${getAccessToken()}`, 'Content-Type': 'application/octet-stream' },
    body: bytes as BodyInit,
  });
  if (!res.ok) throw new ApiError(res.status, 'CIPHER_UPLOAD_FAILED', `密文提交失败（${res.status}）`);
}

async function getRaw(url: string): Promise<Uint8Array> {
  const res = await fetch(`${API_BASE}${url}`, { headers: { Authorization: `Bearer ${getAccessToken()}` } });
  if (!res.ok) throw new ApiError(res.status, 'CIPHER_DOWNLOAD_FAILED', `密文取回失败（${res.status}）`);
  return new Uint8Array(await res.arrayBuffer());
}
