export interface Page<T> {
  page: number;
  pageSize: number;
  total: number;
  list: T[];
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** PRD 第 10 章统一分页结构 { page, pageSize, total, list } */
export function pagedList<T>(list: T[], total: number, page = 1, pageSize = DEFAULT_PAGE_SIZE): Page<T> {
  return { page, pageSize, total, list };
}

/** 脏值退回默认档位，不能把 NaN 变成「每页 1 条」 */
function positiveInt(value: number | undefined, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.trunc(num) : fallback;
}

/** 页码越界一律收敛而不是报错，前端翻页组件才好写 */
export function clampPaging(input?: { page?: number; pageSize?: number }): {
  skip: number;
  take: number;
  page: number;
  pageSize: number;
} {
  const page = positiveInt(input?.page, 1);
  const pageSize = Math.min(positiveInt(input?.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  return { skip: (page - 1) * pageSize, take: pageSize, page, pageSize };
}
