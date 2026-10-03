import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD 19 章附录 A 里三组「已裁决但一直没并入 DDL」的列（2026-10-02 真后端接线）。
 *
 * 全新部署不需要它：schema.sql 已含全部新列。已部署的库靠本迁移补齐，
 * 每一列都先查 information_schema 再决定是否 ALTER，重复执行是安全的空转。
 *
 * - users.position        —— 8.5 顶栏欢迎语的「职务」，此前只在 client 的 mock 里有值
 * - users.drive_perm1~4   —— D20 按人的文件权限授权，与全站等级门槛取并集
 * - users.feature_grants  —— D21 按人的 11 个能力位三态覆盖，NULL = 全部跟随等级
 * - albums.album_caps     —— D25 本册关闭的功能键（存关闭项，NULL/空数组即全开）
 * - albums.stage          —— D31 相册阶段
 * - images.img_stage      —— D31 单张返图阶段，NULL 回落到所属相册
 * - upload_sessions.stage —— D31 这一批图片在建会话时就选定的阶段
 */
export class AddGrantsAndStages1760300000000 implements MigrationInterface {
  readonly name = 'AddGrantsAndStages1760300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await this.add(queryRunner, 'users', 'position', "VARCHAR(50) NOT NULL DEFAULT '' COMMENT '职务，顶栏欢迎语用（8.5）' AFTER nickname");
    await this.add(queryRunner, 'users', 'drive_perm1', "TINYINT NOT NULL DEFAULT 0 COMMENT 'D20 文件权限1 单独开给此人：工作室+拍展' AFTER remark");
    await this.add(queryRunner, 'users', 'drive_perm2', "TINYINT NOT NULL DEFAULT 0 COMMENT 'D20 文件权限2 单独开给此人：管理目录' AFTER drive_perm1");
    await this.add(queryRunner, 'users', 'drive_perm3', "TINYINT NOT NULL DEFAULT 0 COMMENT 'D20 文件权限3 单独开给此人：个人共享文件夹' AFTER drive_perm2");
    await this.add(queryRunner, 'users', 'drive_perm4', "TINYINT NOT NULL DEFAULT 0 COMMENT 'D20 文件权限4 单独开给此人：私人文件夹' AFTER drive_perm3");
    await this.add(queryRunner, 'users', 'feature_grants', "JSON NULL COMMENT 'D21 能力位覆盖：1 强制开 / 0 强制关，缺键=跟随等级' AFTER drive_perm4");
    await this.add(queryRunner, 'albums', 'stage', "ENUM('pre','post') NOT NULL DEFAULT 'pre' COMMENT 'D31 相册阶段' AFTER status");
    await this.add(queryRunner, 'albums', 'album_caps', "JSON NULL COMMENT 'D25 本册关闭的功能键，数组中出现即关闭' AFTER stage");
    await this.add(queryRunner, 'images', 'img_stage', "ENUM('pre','post') NULL COMMENT 'D31 单图阶段，NULL 回落到 albums.stage' AFTER sort");
    await this.add(queryRunner, 'upload_sessions', 'stage', "ENUM('pre','post') NULL COMMENT 'D31 本批图片阶段，NULL 回落到 albums.stage' AFTER filename");
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const [table, column] of [
      ['upload_sessions', 'stage'],
      ['images', 'img_stage'],
      ['albums', 'album_caps'],
      ['albums', 'stage'],
      ['users', 'feature_grants'],
      ['users', 'drive_perm4'],
      ['users', 'drive_perm3'],
      ['users', 'drive_perm2'],
      ['users', 'drive_perm1'],
      ['users', 'position'],
    ] as const) {
      if (await this.hasColumn(queryRunner, table, column)) {
        await queryRunner.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
      }
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
}
