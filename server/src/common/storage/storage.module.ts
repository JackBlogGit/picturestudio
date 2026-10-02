import { Global, Module } from '@nestjs/common';
import { SettingsModule } from '../../modules/settings/settings.module';
import { FileKindService } from './file-kind.service';
import { StorageService } from './storage.service';

/** 存储与类型校验被返图、网盘、后台三处共用，注册为全局模块 */
@Global()
@Module({
  imports: [SettingsModule],
  providers: [StorageService, FileKindService],
  exports: [StorageService, FileKindService],
})
export class StorageModule {}
