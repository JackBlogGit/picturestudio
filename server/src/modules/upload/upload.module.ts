import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Image, UploadSession } from '../../entities';
import { AlbumModule } from '../album/album.module';
import { ImageModule } from '../image/image.module';
import { SettingsModule } from '../settings/settings.module';
import { UploadController } from './upload.controller';
import { UploadMaintenance } from './upload.maintenance';
import { UploadService } from './upload.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([UploadSession, Image]),
    SettingsModule,
    AlbumModule,
    ImageModule,
  ],
  controllers: [UploadController],
  providers: [UploadService, UploadMaintenance],
  exports: [UploadService],
})
export class UploadModule {}
