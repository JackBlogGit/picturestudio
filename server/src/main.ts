import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { Env } from './config/env.config';
import { MAX_CHUNK } from './modules/upload/upload.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService).getOrThrow<Env>('app');

  // 位于 Nginx 之后，否则 req.ip 全部是 127.0.0.1，限流与审计日志都会失真
  app.set('trust proxy', 1);
  app.setGlobalPrefix('api/v1');
  app.enableCors({
    origin: config.corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });

  // 分片与直传的请求体是裸 octet-stream，默认的 json/urlencoded 解析器会原样跳过，
  // 必须显式挂 raw 解析器；limit 与分片上限取同一个常量，免得两边各说各话。
  app.useBodyParser('raw', {
    type: ['application/octet-stream', 'application/offset+octet-stream'],
    limit: MAX_CHUNK,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.disable('x-powered-by');
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  await app.listen(config.port);
}

void bootstrap();
