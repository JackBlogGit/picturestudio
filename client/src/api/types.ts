export interface RequestOptions {
  query?: Record<string, string | number | number[] | undefined>;
  body?: unknown;
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
