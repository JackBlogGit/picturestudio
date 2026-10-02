import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Image } from '../../entities';
import { AlbumModule } from '../album/album.module';
import { SettingsModule } from '../settings/settings.module';
import { TagModule } from '../tag/tag.module';
import { DerivativeService } from './derivative.service';
import { ImageController } from './image.controller';
import { ImageService } from './image.service';

@Module({
  imports: [SettingsModule, AlbumModule, TagModule, TypeOrmModule.forFeature([Image])],
  controllers: [ImageController],
  providers: [DerivativeService, ImageService],
  exports: [DerivativeService, ImageService],
})
export class ImageModule {}
