import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentActor, CurrentAuditCtx } from '../../common/auth/actor.decorator';
import { RequirePermission } from '../../common/auth/auth-metadata';
import { Action, Actor, ResourceType } from '../../common/permission/types';
import { RequestContext } from '../audit/audit.service';
import { ImageService } from './image.service';
import { BatchTagsDto, BatchVisibilityDto, ListImageDto, UpdateImageDto } from './dto/image.dto';

/**
 * 图片字节只有 preview / original 两个鉴权出口，磁盘路径从不出网（PRD 12.3）；
 * 两者分开是为了让「能看」不等于「能拿走原图」（PRD 7.2 里 403 只用于动作被禁）。
 *
 * 批量路由必须声明在 `images/:id` 之前，否则 batch-visibility 会被 :id 抢先匹配。
 */
@Controller()
export class ImageController {
  constructor(private readonly service: ImageService) {}

  @Get('albums/:albumId/images')
  @RequirePermission(Action.Preview, ResourceType.Album, 'albumId')
  list(
    @Param('albumId', ParseIntPipe) albumId: number,
    @Query() query: ListImageDto,
    @CurrentActor() actor: Actor,
  ) {
    return this.service.listInAlbum(albumId, query, actor);
  }

  @Post('images/batch-tags')
  @HttpCode(200)
  batchTags(@Body() dto: BatchTagsDto, @CurrentActor() actor: Actor, @CurrentAuditCtx() ctx: RequestContext) {
    return this.service.batchTags(dto, actor, ctx);
  }

  @Patch('images/batch-visibility')
  batchVisibility(
    @Body() dto: BatchVisibilityDto,
    @CurrentActor() actor: Actor,
    @CurrentAuditCtx() ctx: RequestContext,
  ) {
    return this.service.batchVisibility(dto, actor, ctx);
  }

  @Get('images/:id/preview')
  @RequirePermission(Action.Preview, ResourceType.Image)
  preview(@Param('id', ParseIntPipe) id: number) {
    return this.service.preview(id);
  }

  @Get('images/:id/original')
  @RequirePermission(Action.DownloadOriginal, ResourceType.Image)
  original(@Param('id', ParseIntPipe) id: number) {
    return this.service.original(id);
  }

  @Patch('images/:id')
  @RequirePermission(Action.EditMeta, ResourceType.Image)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateImageDto,
    @CurrentActor() actor: Actor,
    @CurrentAuditCtx() ctx: RequestContext,
  ) {
    return this.service.update(id, dto, actor, ctx);
  }
}
