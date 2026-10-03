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

/**
 * 后台写操作的身份再验证口令（PRD 6.1 / D34）：页面提交前放进来，本次提交的每个写请求都带上，
 * 提交一结束就清掉。只存内存，不落 localStorage / sessionStorage，也不进任何请求体。
 */
let reauthPassword = '';

export function setReauthPassword(password: string): void {
  reauthPassword = password;
}

export function clearReauthPassword(): void {
  reauthPassword = '';
}

export async function call<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  // 显式传了 opts.reauth 以它为准（验收脚本要能在内核层直接验一次闸门），否则用页面提交前放进内存的那一份
  const reauth = method === 'GET' ? '' : opts.reauth || reauthPassword;
  if (USE_MOCK) return handleMock(method, path, { ...opts, reauth }) as Promise<T>;

  const headers: Record<string, string> = {};
  const token = getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (reauth) headers['X-Reauth-Password'] = reauth;

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
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => call<T>('PATCH', path, { ...opts, body }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => call<T>('PUT', path, { ...opts, body }),
  delete: <T>(path: string, opts?: RequestOptions) => call<T>('DELETE', path, opts),
};

/**
 * 图片字节一律走鉴权接口（PRD 12.3），所以 src 就是这个 URL；
 * <img src> 发不出 Authorization 头，真后端模式下把令牌挂在 ?t= 上（只对 GET 生效）。
 * mock 模式没有后端可流式回字节，映射到本地演示图，保持调用点写法完全一致。
 */
export function previewSrc(url: string): string {
  if (USE_MOCK) {
    const id = Number(/\/(?:images|files)\/(\d+)\/(?:preview|original|download)$/.exec(url)?.[1] ?? 0);
    return `/demo/img-${(id % 12) + 1}.webp`;
  }
  const token = getAccessToken();
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;
}
