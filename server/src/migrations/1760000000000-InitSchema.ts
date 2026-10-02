import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MigrationInterface, QueryRunner } from 'typeorm';

const SCHEMA_FILE = resolve(__dirname, '..', '..', 'sql', 'schema.sql');

const TABLES_IN_DROP_ORDER = [
  'logs',
  'guestbook_messages',
  'upload_sessions',
  'files',
  'folders',
  'share_link_images',
  'coser_share_links',
  'image_tag_map',
  'temp_account_folders',
  'temp_account_albums',
  'temp_accounts',
  'images',
  'albums',
  'tags',
  'site_settings',
  'users',
];

/**
 * 建表语句的唯一来源是 server/sql/schema.sql（docs/PRD-V1.1.md 第 11 章引用同一份）。
 * 实体定义必须与该文件一致：有 MySQL 环境后跑 `npm run migration:generate`，
 * 若产出空 diff 即证明实体与 DDL 没有漂移。
 */
export class InitSchema1760000000000 implements MigrationInterface {
  readonly name = 'InitSchema1760000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const raw = readFileSync(SCHEMA_FILE, 'utf8');
    const ddl = raw
      // 库名由 DB_NAME 环境变量决定，脚本内的建库/切库语句在此剥离
      .replace(/^\s*CREATE DATABASE[^;]*;/im, '')
      .replace(/^\s*USE\s+\S+[^;]*;/im, '')
      .trim();
    if (!ddl) {
      throw new Error(`未从 ${SCHEMA_FILE} 读取到任何建表语句`);
    }
    await queryRunner.query(ddl);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of TABLES_IN_DROP_ORDER) {
      await queryRunner.query(`DROP TABLE IF EXISTS \`${table}\``);
    }
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}
