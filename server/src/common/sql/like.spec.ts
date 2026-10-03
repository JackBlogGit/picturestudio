import { escapeLike, likePattern, likePrefixPattern, LIKE_ESCAPE_SQL } from './like';

/**
 * better-sqlite3 没有随包发布 .d.ts，也没有装 @types，
 * 这里只声明本测试用到的两个方法，避免为了断言一句 SQL 而引入整套类型。
 */
interface SqliteStub {
  exec(sql: string): void;
  prepare(sql: string): { all(param: string): Array<Record<string, unknown>> };
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require('better-sqlite3') as new (file: string) => SqliteStub;

/** 反斜杠用码位取，避免源码里的字面量层数把结论带偏 */
const BS = String.fromCharCode(92);

describe('LIKE 的方言中立转义', () => {
  it('两个通配符与转义符自身都被垫住', () => {
    expect(escapeLike('20%_a!b')).toBe('20!%!_a!!b');
    expect(likePattern('x%y')).toBe('%x!%y%');
    expect(likePrefixPattern('x_y')).toBe('x!_y%');
  });

  it('ESCAPE 子句能被开发库真正用的 SQLite 驱动接受', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (name TEXT)');
    db.exec("INSERT INTO t VALUES ('YK8%柚子'), ('YK8X柚子'), ('a_b'), ('axb')");

    const sql = `SELECT name FROM t WHERE name LIKE ? ${LIKE_ESCAPE_SQL}`;
    expect(db.prepare(sql).all(likePrefixPattern('YK8%'))).toEqual([{ name: 'YK8%柚子' }]);
    expect(db.prepare(sql).all(likePattern('a_b'))).toEqual([{ name: 'a_b' }]);
  });

  it('旧写法把两个反斜杠原样交给 ESCAPE，SQLite 一执行就报错', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (name TEXT)');
    db.exec("INSERT INTO t VALUES ('a_b'), ('axb')");

    // 报错在 stepping 阶段才抛：prepare 能过，一跑就炸，所以表现是搜索接口 500 而不是启动失败
    const legacy = `SELECT name FROM t WHERE name LIKE ? ESCAPE '${BS}${BS}'`;
    expect(() => db.prepare(legacy).all(`%${BS}${BS}%`)).toThrow(/ESCAPE expression must be a single character/);
    // MySQL 会把字面量里的双反斜杠折成单个，老写法在 MySQL 上一直是下面这种合法形态
    expect(db.prepare(`SELECT name FROM t WHERE name LIKE ? ESCAPE '${BS}'`).all(`%${BS}_b%`)).toEqual([
      { name: 'a_b' },
    ]);
  });
});
