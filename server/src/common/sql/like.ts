/**
 * LIKE 的方言中立转义。
 *
 * 老写法在 andWhere 的字符串字面量里垫了两层反斜杠，运行期交给 ESCAPE 的是两个反斜杠字符。
 * MySQL 会先把字面量里的双反斜杠折成一个，所以一直没暴露；SQLite **不处理反斜杠转义**，
 * 于是同一句 SQL 在 SQLite 上直接报 `ESCAPE expression must be a single character`，
 * 带关键词的搜索接口整个 500（本机开发库正是 SQLite，已用 better-sqlite3 实测复现）。
 *
 * 换成本来就不需要字面量转义的 `!`，两种方言拿到的 ESCAPE 参数逐字节相同，
 * 代价只是转义集里要多带一个 `!` 自身。
 */
export const LIKE_ESCAPE_SQL = "ESCAPE '!'";

/** 通配符与转义符自身都要垫上转义符，否则用户输入 `%` 就变成全表扫 */
export function escapeLike(keyword: string): string {
  return keyword.replace(/[!%_]/g, (char) => `!${char}`);
}

/** 两侧模糊匹配 */
export function likePattern(keyword: string): string {
  return `%${escapeLike(keyword)}%`;
}

/** 前缀匹配：帐户ID 这类「按开头找」的检索用它，能落在索引上 */
export function likePrefixPattern(keyword: string): string {
  return `${escapeLike(keyword)}%`;
}
