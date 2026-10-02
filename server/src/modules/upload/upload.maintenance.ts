import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UploadService } from './upload.service';

/**
 * PRD 5.3：会话 24 小时过期、碎片定时清理。
 * 只清数据库里已过期且未完成的会话，正在传的分片不受影响。
 */
@Injectable()
export class UploadMaintenance {
  private readonly logger = new Logger(UploadMaintenance.name);

  constructor(private readonly uploads: UploadService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupStaleSessions(): Promise<void> {
    try {
      await this.uploads.cleanupExpired();
    } catch (err) {
      this.logger.error('过期上传会话清理失败', err as Error);
    }
  }
}
