import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { CurrentActor, CurrentAuditCtx } from '../../common/auth/actor.decorator';
import { Actor } from '../../common/permission/types';
import { RequestContext } from '../audit/audit.service';
import { UploadService } from './upload.service';
import { CompleteUploadDto, CreateUploadDto, DirectUploadDto } from './dto/upload.dto';

/**
 * 上传一律走鉴权接口，`originals/` 没有任何静态路由（PRD 12.3）。
 * 分片与直传的字节走 application/octet-stream 原始请求体，元数据走 JSON 或 query，
 * 因此不需要 multipart 解析器，客户端文件名也就没有机会参与路径拼接。
 */
// 与站点配置 upload.rate_limit 的默认值一致；@Throttle 只能接受静态值，改配置需同步改这里
@Throttle({ default: { limit: 30, ttl: 60_000 } })
@Controller('uploads')
export class UploadController {
  constructor(private readonly service: UploadService) {}

  @Post()
  create(@Body() dto: CreateUploadDto, @CurrentActor() actor: Actor, @CurrentAuditCtx() ctx: RequestContext) {
    return this.service.create(dto, actor, ctx);
  }

  /** 小图直传：一次请求完成建会话 + 单分片 + 合并落库（PRD 4.3） */
  @Post('direct')
  @HttpCode(201)
  direct(
    @Query() dto: DirectUploadDto,
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentAuditCtx() ctx: RequestContext,
  ) {
    return this.service.direct(dto, rawBody(req), actor, ctx);
  }

  @Get(':uploadId')
  status(@Param('uploadId') uploadId: string, @CurrentActor() actor: Actor) {
    return this.service.status(uploadId, actor);
  }

  @Put(':uploadId/chunk/:index')
  @HttpCode(200)
  putChunk(
    @Param('uploadId') uploadId: string,
    @Param('index', ParseIntPipe) index: number,
    @Req() req: Request,
    @CurrentActor() actor: Actor,
  ) {
    return this.service.putChunk(uploadId, index, rawBody(req), actor);
  }

  @Post(':uploadId/complete')
  @HttpCode(200)
  complete(
    @Param('uploadId') uploadId: string,
    @Body() dto: CompleteUploadDto,
    @CurrentActor() actor: Actor,
    @CurrentAuditCtx() ctx: RequestContext,
  ) {
    return this.service.complete(uploadId, dto, actor, ctx);
  }

  @Delete(':uploadId')
  @HttpCode(200)
  async abort(
    @Param('uploadId') uploadId: string,
    @CurrentActor() actor: Actor,
    @CurrentAuditCtx() ctx: RequestContext,
  ): Promise<{ uploadId: string }> {
    await this.service.abort(uploadId, actor, ctx);
    return { uploadId };
  }
}

function rawBody(req: Request): Buffer {
  const body = req.body as unknown;
  return Buffer.isBuffer(body) ? body : Buffer.alloc(0);
}
