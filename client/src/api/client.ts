import type { ApiEnvelope } from '@/types/api';
import { ApiError } from './error';
import { getAccessToken } from './token';
import { handleMock } from './mock/handler';
import type { RequestOptions } from './types';

export const API_BASE = import.meta.env.VITE_API_BASE ?? '/api/v1';
export const USE_MOCK = String(import.meta.env.VITE_USE_MOCK ?? 'false') === 'true';

export { ApiError, errorText, isApiError } from './error';
export { getAccessToken, setAccessToken } from './token';

function buildUrl(path: string, query?: RequestOptions['query']): URL {
  const url = new URL(API_BASE + path, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === '') continue;
    // 后端 DTO 的 csvIds 同时接受 `tags=1,2` 与重复参数，这里统一拼逗号
    url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  return url;
}

export async function call<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  if (USE_MOCK) return handleMock(method, path, opts) as Promise<T>;

  const headers: Record<string, string> = {};
  const token = getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(buildUrl(path, opts.query), {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  let envelope: ApiEnvelope<T> | null = null;
  try {
    envelope = (await res.json()) as ApiEnvelope<T>;
  } catch {
    throw new ApiError(res.status, 'BAD_GATEWAY', `服务返回了非 JSON 响应（${res.status}）`);
  }
  if (!res.ok || envelope.code !== 'OK') {
    throw new ApiError(res.status, envelope.code, envelope.message, envelope.data);
  }
  return envelope.data;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => call<T>('GET', path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => call<T>('POST', path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown) => call<T>('PATCH', path, { body }),
  put: <T>(path: string, body?: unknown) => call<T>('PUT', path, { body }),
  delete: <T>(path: string) => call<T>('DELETE', path),
};

/**
 * 图片字节一律走鉴权接口（PRD 12.3），所以 src 就是这个 URL；
 * mock 模式没有后端可流式回字节，映射到本地演示图，保持调用点写法完全一致。
 */
export function previewSrc(url: string): string {
  if (!USE_MOCK) return url;
  const id = Number(/\/(?:images|files)\/(\d+)\/(?:preview|original|download)$/.exec(url)?.[1] ?? 0);
  return `/demo/img-${(id % 12) + 1}.webp`;
}
