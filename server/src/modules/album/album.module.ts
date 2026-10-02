import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Album, Image } from '../../entities';
import { AlbumController } from './album.controller';
import { AlbumService } from './album.service';

@Module({
  imports: [TypeOrmModule.forFeature([Album, Image])],
  controllers: [AlbumController],
  providers: [AlbumService],
  exports: [AlbumService],
})
export class AlbumModule {}
