/**
 * 加密空间的接口层（PRD 5.7 / D26，容器落盘名见 D29）。
 *
 * 这一层不碰密码学：派生密钥与加解密都在页面里做（utils/crypto.ts），
 * 这里只负责把密文与元数据送出去。字节走不走 JSON 是传输细节，因此分支收在这一层——
 * 页面代码无论对着 mock 还是对着真后端都长一个样，和 upload.ts 的 putChunk 同一套写法。
 *
 * 关联：上游只有 `views/VaultView.vue`；下游是 `api/mock/vault.ts`（`VITE_USE_MOCK=true`）
 * 与未来的 server 端 `VaultModule`（PRD 10.7 那十个接口）；响应类型全部取自 `types/api.ts`，
 * base64 往返用 `utils/crypto.ts` 的同一对函数，不让两边各自实现一份编码。
 *
 * 注意：① 这一层**永不经手口令**——body 里只有盐、轮数、校验子与密文，任何「把口令传上去」的字段都是设计违规；
 * ② `vaultRekey` 必须把整空间密文**一次**提交，拆成逐条替换会留下「新参数 + 旧密文」的永久不可解条目；
 * ③ mock 与真接口只在 `vaultPutFile` / `vaultGetCipher` 两处分支，其余调用两边同形，新增接口时保持这一约束；
 * ④ **进度是传输层的事**，所以 `vaultGetCipher` 的回调放在这里而不是页面里：mock 的解码本身要跑主线程，
 * 分片解码边跑边报；真接口按 `Content-Length` 报字节数。两条路都给的是「已到手字节 / 总体积」，口径一致。
 */
import { api, API_BASE, USE_MOCK } from './client';
import { ApiError } from './error';
import { getAccessToken } from './token';
import type { VaultFileView, VaultSpaceRow, VaultStatus } from '@/types/api';
import { b64ToBytes, bytesToB64 } from '@/utils/crypto';

/** 已到手字节 / 总体积；总体积未知时为 0，调用方只能显示「已取回 n 字节」 */
export type ByteProgress = (loaded: number, total: number) => void;

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
export async function vaultGetCipher(row: VaultFileView, onProgress?: ByteProgress): Promise<Uint8Array> {
  if (USE_MOCK) {
    const ack = await api.get<{ cipher: string }>(`/vault/files/${row.id}/cipher`);
    return decodeBase64(ack.cipher, onProgress);
  }
  return getRaw(row.links.cipher ?? '', onProgress);
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

function concatBytes(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 让出一个宏任务：进度条要的是「浏览器有机会画一帧」，不是等真的空闲 */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * mock 路径的 base64 → 字节。整串一次解码在几十 MB 的容器上会把主线程占住一整段，
 * 页面上一帧进度都画不出来，因此按片解、每片之间让出一次事件循环。
 * 片长必须取 4 的倍数：base64 每 4 字符恰好还原 3 字节，错开一位整串就废了。
 */
async function decodeBase64(text: string, onProgress?: ByteProgress): Promise<Uint8Array> {
  const CHUNK = 65_536;
  if (!onProgress || text.length <= CHUNK) {
    const out = b64ToBytes(text);
    onProgress?.(out.length, out.length);
    return out;
  }
  const total = Math.floor(text.length / 4) * 3;
  const parts: Uint8Array[] = [];
  let loaded = 0;
  for (let i = 0; i < text.length; i += CHUNK) {
    const part = b64ToBytes(text.slice(i, i + CHUNK));
    parts.push(part);
    loaded += part.length;
    onProgress(loaded, total);
    await yieldToUi();
  }
  return concatBytes(parts, loaded);
}

async function getRaw(url: string, onProgress?: ByteProgress): Promise<Uint8Array> {
  const res = await fetch(`${API_BASE}${url}`, { headers: { Authorization: `Bearer ${getAccessToken()}` } });
  if (!res.ok) throw new ApiError(res.status, 'CIPHER_DOWNLOAD_FAILED', `密文取回失败（${res.status}）`);
  if (!onProgress || !res.body) return new Uint8Array(await res.arrayBuffer());
  const declared = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    parts.push(value);
    loaded += value.length;
    onProgress(loaded, declared);
  }
  return concatBytes(parts, loaded);
}
