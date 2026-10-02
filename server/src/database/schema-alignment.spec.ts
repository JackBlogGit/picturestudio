import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getMetadataArgsStorage } from 'typeorm';
import { snakeCaseName } from './snake-column.naming-strategy';

/** 只喂装饰器元数据，不连库：本机没有 MySQL，靠这份静态比对守住「实体 ↔ DDL」这条缝 */
import '../entities';

const SCHEMA_FILE = resolve(__dirname, '..', '..', 'sql', 'schema.sql');
const SQL = readFileSync(SCHEMA_FILE, 'utf8');

const NON_COLUMN = /^(PRIMARY\s+KEY|UNIQUE\s+KEY|KEY|INDEX|CONSTRAINT|FOREIGN\s+KEY|CHECK|FULLTEXT)\b/i;

interface ParsedTable {
  columns: Set<string>;
  indexes: Set<string>;
}

/** 解析 CREATE TABLE 块：列名与索引名分开存，供两个方向的一致性断言使用 */
function parseSchema(sql: string): Map<string, ParsedTable> {
  const tables = new Map<string, ParsedTable>();
  const block = /CREATE TABLE (\w+) \(([\s\S]*?)\n\) ENGINE/g;
  for (const match of sql.matchAll(block)) {
    const [, table, body] = match;
    const parsed: ParsedTable = { columns: new Set(), indexes: new Set() };
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim().replace(/,$/, '');
      if (!line || line.startsWith('--')) continue;
      const index = /^(?:UNIQUE\s+KEY|KEY|INDEX)\s+(\w+)/i.exec(line);
      if (index) {
        parsed.indexes.add(index[1]);
        continue;
      }
      if (NON_COLUMN.test(line)) continue;
      const column = /^`?(\w+)`?\s/.exec(line);
      if (column) parsed.columns.add(column[1]);
    }
    tables.set(table, parsed);
  }
  return tables;
}

const DDL = parseSchema(SQL);

function entityTables(): Map<string, string[]> {
  const storage = getMetadataArgsStorage();
  const out = new Map<string, string[]>();
  const columnsByTarget = new Map<string, string[]>();
  const targetKey = (target: Function | string): string =>
    typeof target === 'string' ? target : target.name;
  const push = (target: Function | string, column: string): void => {
    const key = targetKey(target);
    const list = columnsByTarget.get(key) ?? [];
    list.push(column);
    columnsByTarget.set(key, list);
  };

  for (const col of storage.columns) {
    push(col.target, snakeCaseName(col.options.name ?? col.propertyName));
  }
  for (const join of storage.joinColumns) {
    if (join.name) push(join.target, snakeCaseName(join.name));
  }
  for (const table of storage.tables) {
    if (!table.name) continue;
    out.set(table.name, columnsByTarget.get(targetKey(table.target)) ?? []);
  }
  return out;
}

const ENTITIES = entityTables();

describe('实体 ↔ schema.sql 列名对齐（M2.5 DDL 合入的前置）', () => {
  it('解析到了建表语句，否则本文件等于没测', () => {
    expect(DDL.size).toBeGreaterThanOrEqual(16);
    expect(ENTITIES.size).toBe(DDL.size);
  });

  it('每个实体列都能在 DDL 里找到同名物理列', () => {
    const drift: string[] = [];
    for (const [table, columns] of ENTITIES) {
      const ddl = DDL.get(table);
      if (!ddl) {
        drift.push(`${table} 在 schema.sql 里不存在`);
        continue;
      }
      for (const column of columns) {
        if (!ddl.columns.has(column)) drift.push(`${table}.${column}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it('DDL 的每一列都被实体建模（新增列忘了改实体会在这里暴露）', () => {
    const missing: string[] = [];
    for (const [table, ddl] of DDL) {
      const mapped = new Set(ENTITIES.get(table) ?? []);
      for (const column of ddl.columns) {
        if (!mapped.has(column)) missing.push(`${table}.${column}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('实体声明的索引名在 DDL 里都有对应实现', () => {
    const storage = getMetadataArgsStorage();
    const drift: string[] = [];
    const tableOf = new Map<string, string>();
    for (const t of storage.tables) {
      if (t.name) tableOf.set(typeof t.target === 'string' ? t.target : t.target.name, t.name);
    }
    for (const idx of storage.indices) {
      const table = tableOf.get(typeof idx.target === 'string' ? idx.target : idx.target.name);
      if (!table || !idx.name) continue;
      if (!DDL.get(table)?.indexes.has(idx.name)) drift.push(`${table}#${idx.name}`);
    }
    expect(drift).toEqual([]);
  });
});

describe('V1.2 附录 A 增量已落进 DDL', () => {
  const temp = DDL.get('temp_accounts');

  it.each([
    'account_no',
    'phone',
    'shooting_note',
    'pre_stage',
    'post_stage',
    'pre_done_time',
    'post_done_time',
  ])('temp_accounts 有列 %s', (column) => {
    expect(temp?.columns.has(column)).toBe(true);
  });

  it('工单列表查询用的复合索引与两个唯一键都在', () => {
    expect(temp?.indexes.has('idx_stage_query')).toBe(true);
    expect(temp?.indexes.has('uk_account_no')).toBe(true);
    expect(temp?.indexes.has('uk_login_name')).toBe(true);
  });

  it('files 能挂工单附件', () => {
    expect(DDL.get('files')?.columns.has('temp_account_id')).toBe(true);
    expect(DDL.get('files')?.columns.has('ref_stage')).toBe(true);
    expect(DDL.get('files')?.indexes.has('idx_temp_ref')).toBe(true);
  });

  it.each(['temp.default_quota', 'temp.max_days_for_l1_l2', 'task.overdue_notify_enabled'])(
    '站点配置种子含 %s',
    (key) => {
      expect(SQL).toContain(`('${key}'`);
    },
  );
});

describe('snakeCaseName', () => {
  it.each([
    ['accountNo', 'account_no'],
    ['preDoneTime', 'pre_done_time'],
    ['md5Client', 'md5_client'],
    ['id', 'id'],
    ['skey', 'skey'],
    ['ownerUid', 'owner_uid'],
  ])('%s → %s', (input, expected) => {
    expect(snakeCaseName(input)).toBe(expected);
  });
});
