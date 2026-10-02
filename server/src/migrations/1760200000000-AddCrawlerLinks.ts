import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD D23 爬虫模块的升级路径（2026-10-02）。
 *
 * 全新部署不需要它：schema.sql 已含 crawler_links 表与 logs.target_type 的 'crawler' 值。
 * 已部署的库靠本迁移补建，两步都做存在性判断，重复执行是安全的空转。
 */
const LOG_TARGET_ENUM =
  "ENUM('album','image','file','folder','tag','user','temp','site','link','message','crawler')";

export class AddCrawlerLinks1760200000000 implements MigrationInterface {
  readonly name = 'AddCrawlerLinks1760200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.tableExists(queryRunner, 'crawler_links'))) {
      await queryRunner.query(`
        CREATE TABLE \`crawler_links\` (
          id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
          url         VARCHAR(1000) NOT NULL COMMENT '规范化后的站外地址(去 fragment 与跟踪参数)',
          url_hash    CHAR(64)      NOT NULL COMMENT '规范化地址的 sha256，去重键',
          title       VARCHAR(255)  NOT NULL DEFAULT '' COMMENT '检索命中条目的标题',
          snippet     VARCHAR(500)  NOT NULL DEFAULT '' COMMENT '命中摘要，不存正文',
          domain      VARCHAR(255)  NOT NULL DEFAULT '' COMMENT '注册域，如 weibo.com',
          platform    ENUM('weibo','bilibili','xiaohongshu','douyin','twitter','other') NOT NULL DEFAULT 'other',
          keyword     VARCHAR(100)  NOT NULL DEFAULT '' COMMENT '登记时命中的检索词',
          source      ENUM('search','manual') NOT NULL DEFAULT 'search' COMMENT '检索登记 / 手敲粘贴',
          status      TINYINT       NOT NULL DEFAULT 0 COMMENT '0待处理 1已记录 2已联系授权 3已投诉 4已忽略',
          note        VARCHAR(500)  NOT NULL DEFAULT '' COMMENT '跟进备注',
          create_uid  INT UNSIGNED NULL COMMENT '登记人(仅 L4)',
          audit_uid   INT UNSIGNED NULL COMMENT '最后一次改跟进状态的人',
          audit_time  DATETIME NULL,
          create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY \`uk_crawler_url_hash\` (\`url_hash\`),
          KEY \`idx_crawler_status_time\` (\`status\`, \`create_time\`),
          KEY \`idx_crawler_platform\` (\`platform\`),
          CONSTRAINT \`fk_crawler_create\` FOREIGN KEY (\`create_uid\`) REFERENCES \`users\` (\`id\`) ON DELETE SET NULL,
          CONSTRAINT \`fk_crawler_audit\` FOREIGN KEY (\`audit_uid\`) REFERENCES \`users\` (\`id\`) ON DELETE SET NULL
        ) ENGINE = InnoDB COMMENT '站外来源登记（仅超管可见，不落地文件）'
      `);
    }

    // 旧库里 logs.target_type 没有 crawler 这一档，审计写入会被 MySQL 截成空值
    const current = await this.logTargetTypeDefinition(queryRunner);
    if (current && !current.includes("'crawler'")) {
      await queryRunner.query(
        `ALTER TABLE \`logs\` MODIFY \`target_type\` ${LOG_TARGET_ENUM} NULL`,
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.tableExists(queryRunner, 'crawler_links')) {
      await queryRunner.query('DROP TABLE `crawler_links`');
    }
    const current = await this.logTargetTypeDefinition(queryRunner);
    if (current?.includes("'crawler'")) {
      await queryRunner.query(
        "ALTER TABLE `logs` MODIFY `target_type` ENUM('album','image','file','folder','tag','user','temp','site','link','message') NULL",
      );
    }
  }

  private async tableExists(queryRunner: QueryRunner, table: string): Promise<boolean> {
    const rows: Array<{ n: string }> = await queryRunner.query(
      'SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [table],
    );
    return rows.length > 0;
  }

  private async logTargetTypeDefinition(queryRunner: QueryRunner): Promise<string | null> {
    const rows: Array<{ t: string }> = await queryRunner.query(
      "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'logs' AND COLUMN_NAME = 'target_type'",
    );
    return rows[0]?.t ?? null;
  }
}
