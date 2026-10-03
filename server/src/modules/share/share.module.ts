import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Album, CoserShareLink, Image, ShareLinkImage, Tag } from '../../entities';
import { TagModule } from '../tag/tag.module';
import { PublicShareController } from './public-share.controller';
import { PublicShareService } from './public-share.service';
import { ShareController } from './share.controller';
import { ShareHitService } from './share-hit';
import { ShareLinkService } from './share-link.service';
import { ShareSessionService } from './share-session';

@Module({
  imports: [
    TypeOrmModule.forFeature([CoserShareLink, ShareLinkImage, Album, Image, Tag]),
    TagModule,
    /**
     * 模块级刻意不给全站 JWT 密钥：分享子会话每次签名/验签都显式带派生密钥，
     * 这样就算有人漏传 secret，也签不出一枚能当成员令牌用的 Cookie。
     */
    JwtModule.register({}),
  ],
  controllers: [ShareController, PublicShareController],
  providers: [ShareHitService, ShareLinkService, PublicShareService, ShareSessionService],
})
export class ShareModule {}
