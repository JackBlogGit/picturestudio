import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 网盘权限内核缺的四类列（PRD 5.4 规则 1~12 + coser 分享链接的 person 口径）。
 *
 * 全新部署不需要它：schema.sql 已含全部新列。本迁移只服务已部署的库，
 * 每一步都先查 information_schema，重复执行是安全的空转。
 *
 * - folders.kind            —— 网盘 12 条规则全部挂在「目录用途」上，从前只能靠目录名猜
 * - folders.owner_uid       —— 规则 1/6 的归属人，共享/私人/拍展/爬虫目录才有
 * - folders/files.deleted_*  —— 规则 12 垃圾箱：记下原目录与入箱时间，还原才有着落
 * - coser_share_links.album_id 改可空 —— 「返图返给个人」的 person 链接没有单一来源相册
 */
const FOLDER_KIND_ENUM =
  "ENUM('workspace','shoot','manage','shared','personal','crawler','trash')";

export class AddDriveColumns1760400000000 implements MigrationInterface {
  readonly name = 'AddDriveColumns1760400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await this.add(queryRunner, 'folders', 'kind', `${FOLDER_KIND_ENUM} NOT NULL DEFAULT 'workspace' COMMENT '目录用途（PRD 5.4 规则 1~12）' AFTER description`);
    await this.add(queryRunner, 'folders', 'owner_uid', "INT UNSIGNED NULL COMMENT '规则 1/6 归属人，公共目录为 NULL' AFTER kind");
    await this.add(queryRunner, 'folders', 'deleted_from_id', "INT UNSIGNED NULL COMMENT '规则 12：进垃圾箱前的原上级目录' AFTER owner_uid");
    await this.add(queryRunner, 'folders', 'deleted_at', "DATETIME NULL COMMENT '规则 12：进垃圾箱的时间' AFTER deleted_from_id");
    await this.add(queryRunner, 'files', 'deleted_from_id', "INT UNSIGNED NULL COMMENT '规则 12：进垃圾箱前的原目录' AFTER ref_stage");
    await this.add(queryRunner, 'files', 'deleted_at', "DATETIME NULL COMMENT '规则 12：进垃圾箱的时间' AFTER deleted_from_id");

    // person 口径的返图链接 album_id 必须能留空，否则建链即失败
    if (await this.isNotNull(queryRunner, 'coser_share_links', 'album_id')) {
      await queryRunner.query(
        "ALTER TABLE `coser_share_links` MODIFY `album_id` INT UNSIGNED NULL COMMENT '来源相册；person 口径跨相册，故为 NULL'",
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const [table, column] of [
      ['files', 'deleted_at'],
      ['files', 'deleted_from_id'],
      ['folders', 'deleted_at'],
      ['folders', 'deleted_from_id'],
      ['folders', 'owner_uid'],
      ['folders', 'kind'],
    ] as const) {
      if (await this.hasColumn(queryRunner, table, column)) {
        await queryRunner.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
      }
    }
    // 只有当存量数据里没有 NULL 时才敢收回非空约束
    const orphans: Array<{ n: string }> = await queryRunner.query(
      'SELECT COUNT(*) AS n FROM coser_share_links WHERE album_id IS NULL',
    );
    if (Number(orphans[0]?.n ?? 0) === 0) {
      await queryRunner.query('ALTER TABLE `coser_share_links` MODIFY `album_id` INT UNSIGNED NOT NULL');
    }
  }

  private async add(
    queryRunner: QueryRunner,
    table: string,
    column: string,
    definition: string,
  ): Promise<void> {
    if (await this.hasColumn(queryRunner, table, column)) return;
    await queryRunner.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }

  private async hasColumn(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<boolean> {
    const rows: Array<{ n: string }> = await queryRunner.query(
      'SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [table, column],
    );
    return rows.length > 0;
  }

  private async isNotNull(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<boolean> {
    const rows: Array<{ n: string }> = await queryRunner.query(
      "SELECT IS_NULLABLE AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
      [table, column],
    );
    return rows[0]?.n === 'NO';
  }
}
