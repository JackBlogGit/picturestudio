import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import envConfig, { Env } from './config/env.config';
import { snakeNamingStrategy } from './database/snake-column.naming-strategy';
import { AclModule } from './common/auth/acl.module';
import { AllExceptionsFilter } from './common/http/app-error';
import { ResponseEnvelopeInterceptor } from './common/http/response-envelope.interceptor';
import { StorageModule } from './common/storage/storage.module';
import { HealthController } from './health.controller';
import { AlbumModule } from './modules/album/album.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { ImageModule } from './modules/image/image.module';
import { SettingsModule } from './modules/settings/settings.module';
import { TagModule } from './modules/tag/tag.module';
import { UploadModule } from './modules/upload/upload.module';
import { TaskModule } from './modules/task/task.module';
import { TempAccountModule } from './modules/temp-account/temp-account.module';
import { CrawlerModule } from './modules/crawler/crawler.module';

const throttler = ThrottlerModule.forRoot({
  throttlers: [{ ttl: 60_000, limit: 100 }],
});

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [envConfig], envFilePath: ['.env'] }),
    TypeOrmModule.forRootAsync({
      inject: [envConfig.KEY],
      useFactory: (app: Env): TypeOrmModuleOptions => {
        const isSQLite = app.db.type === 'better-sqlite3';
        
        return {
          type: app.db.type,
          ...(isSQLite 
            ? {
                database: app.db.database,
              }
            : {
                host: app.db.host,
                port: app.db.port,
                username: app.db.user,
                password: app.db.password,
                database: app.db.name,
                charset: 'utf8mb4',
                timezone: 'local',
              }),
          // 列名走 snake_case，与 server/sql/schema.sql（DDL 唯一真源）逐字对齐；
          // TypeORM 默认只转换表名，不配这一行实体就会查询库里不存在的 camelCase 列
          namingStrategy: isSQLite ? undefined : snakeNamingStrategy(),
          autoLoadEntities: true,
          // 连不上就立刻报错，默认 10 次重试会让启动卡住半分钟
          retryAttempts: 1,
          synchronize: isSQLite, // SQLite 开发环境自动同步表结构
        };
      },
    }),
    throttler,
    ScheduleModule.forRoot(),
    StorageModule,
    AuditModule,
    AclModule,
    AuthModule,
    SettingsModule,
    TagModule,
    AlbumModule,
    ImageModule,
    UploadModule,
    TaskModule,
    TempAccountModule,
    CrawlerModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
  ],
})
export class AppModule {}
