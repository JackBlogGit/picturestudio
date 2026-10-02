import { MigrationInterface, QueryRunner } from 'typeorm';
import { uniqueAccountNo } from '../common/temp-account/account-no';

/**
 * PRD-V1.2 第 19 章附录 A 的升级路径。
 *
 * 全新部署不需要它：`InitSchema` 执行的 schema.sql 已含这些列。
 * 已部署的库（例如现场先跑过 V1.1 的那台）靠本迁移补列，且每一步都做存在性判断，
 * 所以在「schema.sql 已是 V1.2」的库上重复执行是安全的空转。
 *
 * account_no 是 NOT NULL 且无默认值，直接 ADD COLUMN 在存量表上必然失败，
 * 因此顺序固定为：加列时先允许 NULL → 回填 → 改 NOT NULL → 建唯一索引。
 */
const NEW_SETTINGS: Array<{ key: string; value: string; remark: string }> = [
  { key: 'temp.default_quota', value: '10737418240', remark: '临时账号默认配额(10GB)，L1/L2 创建的账号强制取此值(PRD 6.2)' },
  { key: 'temp.max_days_for_l1_l2', value: '7', remark: 'L1/L2 创建临时账号的最长有效天数(PRD D9)' },
  { key: 'task.overdue_notify_enabled', value: 'true', remark: '逾期未交付工单是否每日告警(PRD 13 章)' },
];

export class AddTempAccountTaskFields1760100000000 implements MigrationInterface {
  readonly name = 'AddTempAccountTaskFields1760100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await this.addColumn(queryRunner, 'temp_accounts', 'account_no', 'VARCHAR(16) NULL', 'id');
    await this.addColumn(queryRunner, 'temp_accounts', 'phone', 'VARCHAR(16) NULL');
    await this.addColumn(
      queryRunner,
      'temp_accounts',
      'shooting_note',
      "VARCHAR(500) NOT NULL DEFAULT ''",
    );
    await this.addColumn(queryRunner, 'temp_accounts', 'pre_stage', 'TINYINT NOT NULL DEFAULT 0');
    await this.addColumn(queryRunner, 'temp_accounts', 'post_stage', 'TINYINT NOT NULL DEFAULT 0');
    await this.addColumn(queryRunner, 'temp_accounts', 'pre_done_time', 'DATETIME NULL');
    await this.addColumn(queryRunner, 'temp_accounts', 'post_done_time', 'DATETIME NULL');

    await this.backfillAccountNo(queryRunner);

    if (await this.columnIsNullable(queryRunner, 'temp_accounts', 'account_no')) {
      await queryRunner.query(
        "ALTER TABLE `temp_accounts` MODIFY `account_no` VARCHAR(16) NOT NULL COMMENT '唯一帐户ID：YK+6位随机码，可替代 login_name 登录'",
      );
    }
    await this.addIndex(queryRunner, 'temp_accounts', 'uk_account_no', ['account_no'], true);
    await this.addIndex(
      queryRunner,
      'temp_accounts',
      'idx_stage_query',
      ['disabled', 'pre_stage', 'post_stage', 'create_time'],
      false,
    );

    await this.addColumn(queryRunner, 'files', 'temp_account_id', 'INT UNSIGNED NULL');
    await this.addColumn(queryRunner, 'files', 'ref_stage', 'VARCHAR(8) NULL');
    await this.addIndex(queryRunner, 'files', 'idx_temp_ref', ['temp_account_id', 'ref_stage'], false);

    for (const item of NEW_SETTINGS) {
      await queryRunner.query(
        'INSERT IGNORE INTO `site_settings` (`skey`, `sval`, `remark`) VALUES (?, ?, ?)',
        [item.key, item.value, item.remark],
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DELETE FROM `site_settings` WHERE `skey` IN (?, ?, ?)',
      NEW_SETTINGS.map((s) => s.key),
    );
    for (const [table, index, columns] of [
      ['files', 'idx_temp_ref', ['temp_account_id', 'ref_stage']],
      ['temp_accounts', 'idx_stage_query', ['disabled', 'pre_stage', 'post_stage', 'create_time']],
      ['temp_accounts', 'uk_account_no', ['account_no']],
    ] as Array<[string, string, string[]]>) {
      if (await this.indexExists(queryRunner, table, index, columns)) {
        await queryRunner.query(`ALTER TABLE \`${table}\` DROP INDEX \`${index}\``);
      }
    }
    for (const column of ['ref_stage', 'temp_account_id']) {
      await this.dropColumn(queryRunner, 'files', column);
    }
    for (const column of [
      'post_done_time',
      'pre_done_time',
      'post_stage',
      'pre_stage',
      'shooting_note',
      'phone',
      'account_no',
    ]) {
      await this.dropColumn(queryRunner, 'temp_accounts', column);
    }
  }

  /** 存量行没有帐户ID，登录后门就少一条；这里逐行生成并查重，而不是在 SQL 里拼随机串 */
  private async backfillAccountNo(queryRunner: QueryRunner): Promise<void> {
    const taken: Array<{ account_no: string | null }> = await queryRunner.query(
      'SELECT `account_no` FROM `temp_accounts`',
    );
    const used = new Set(taken.map((r) => r.account_no).filter(Boolean) as string[]);
    const pending: Array<{ id: number }> = await queryRunner.query(
      'SELECT `id` FROM `temp_accounts` WHERE `account_no` IS NULL OR `account_no` = \'\'',
    );
    for (const row of pending) {
      const candidate = uniqueAccountNo(used);
      used.add(candidate);
      await queryRunner.query('UPDATE `temp_accounts` SET `account_no` = ? WHERE `id` = ?', [
        candidate,
        row.id,
      ]);
    }
  }

  private async columnExists(
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

  private async columnIsNullable(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<boolean> {
    const rows: Array<{ nullable: string }> = await queryRunner.query(
      "SELECT IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
      [table, column],
    );
    return rows[0]?.nullable === 'YES';
  }

  /** 只判断「这个索引不是以这些列为前缀存在」，避免同名不同构的索引骗过检查 */
  private async indexExists(
    queryRunner: QueryRunner,
    table: string,
    index: string,
    columns: string[],
  ): Promise<boolean> {
    const rows: Array<{ c: string }> = await queryRunner.query(
      'SELECT COLUMN_NAME AS c FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? ORDER BY SEQ_IN_INDEX',
      [table, index],
    );
    return (
      rows.length >= columns.length &&
      columns.every((column, i) => rows[i]?.c?.toLowerCase() === column.toLowerCase())
    );
  }

  private async addColumn(
    queryRunner: QueryRunner,
    table: string,
    column: string,
    definition: string,
    after?: string,
  ): Promise<void> {
    if (await this.columnExists(queryRunner, table, column)) return;
    const position = after ? ` AFTER \`${after}\`` : '';
    await queryRunner.query(
      `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}${position}`,
    );
  }

  private async dropColumn(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<void> {
    if (await this.columnExists(queryRunner, table, column)) {
      await queryRunner.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
    }
  }

  private async addIndex(
    queryRunner: QueryRunner,
    table: string,
    index: string,
    columns: string[],
    unique: boolean,
  ): Promise<void> {
    if (await this.indexExists(queryRunner, table, index, columns)) return;
    const kind = unique ? 'UNIQUE KEY' : 'KEY';
    await queryRunner.query(
      `ALTER TABLE \`${table}\` ADD ${kind} \`${index}\` (${columns.map((c) => `\`${c}\``).join(', ')})`,
    );
  }
}
