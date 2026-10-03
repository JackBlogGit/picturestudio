export interface RequestOptions {
  query?: Record<string, string | number | number[] | undefined>;
  body?: unknown;
  /** 后台写操作的身份再验证口令（PRD 6.1 / D34），真接口走 X-Reauth-Password 头 */
  reauth?: string;
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
