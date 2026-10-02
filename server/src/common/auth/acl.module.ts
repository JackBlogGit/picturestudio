import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Album,
  File,
  Folder,
  Image,
  TempAccount,
  User,
} from '../../entities';
import { ActorGuard } from './actor.guard';
import { AdminGuard, PermissionGuard } from './permission.guard';
import { ACCESS_TOKEN_TTL_SEC, TokenService } from './token.service';
import { ResourceLoader } from '../permission/resource-loader';
import { AuditModule } from '../../modules/audit/audit.module';

/**
 * 全局守卫必须在提供其依赖的那个模块里注册（APP_GUARD 用该模块的注入器实例化），
 * 否则 ActorGuard 拿不到 User/TempAccount 仓储。故三类身份鉴权与授权守卫集中在此。
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    AuditModule,
    TypeOrmModule.forFeature([User, TempAccount, Album, Image, Folder, File]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('app.jwt.secret'),
        signOptions: { algorithm: 'HS256' },
      }),
    }),
  ],
  providers: [
    TokenService,
    ResourceLoader,
    {
      provide: ACCESS_TOKEN_TTL_SEC,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.getOrThrow<number>('app.jwt.accessTokenTtlSec'),
    },
    { provide: APP_GUARD, useClass: ActorGuard },
    { provide: APP_GUARD, useClass: AdminGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
  exports: [TokenService, ResourceLoader],
})
export class AclModule {}
