/** 401/403/404/409/413 都带 code，UI 要按 code 分支而不是猜文案 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly data: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** 后端把无权与不存在统一收敛成 404，UI 也照这个口径提示（PRD 12.5） */
export function errorText(err: unknown, fallback = '操作失败，请稍后重试'): string {
  if (isApiError(err)) return err.message || fallback;
  if (err instanceof Error) return err.message || fallback;
  return fallback;
}
