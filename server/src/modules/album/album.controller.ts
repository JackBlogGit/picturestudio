import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentActor, CurrentAuditCtx } from '../../common/auth/actor.decorator';
import { RequirePermission } from '../../common/auth/auth-metadata';
import { Action, Actor, ResourceType } from '../../common/permission/types';
import { RequestContext } from '../audit/audit.service';
import { AlbumService } from './album.service';
import {
  AlbumStatusDto,
  CreateAlbumDto,
  DeleteAlbumDto,
  ListAlbumDto,
  UpdateAlbumDto,
} from './dto/album.dto';

/** 相册字段直接透传即可，实体里没有敏感列 */
@Controller('albums')
export class AlbumController {
  constructor(private readonly service: AlbumService) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Query() query: ListAlbumDto) {
    return this.service.list(actor, query);
  }

  @Get(':id')
  @RequirePermission(Action.Preview, ResourceType.Album)
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.service.getById(id);
  }

  @Post()
  create(@Body() dto: CreateAlbumDto, @CurrentActor() actor: Actor, @CurrentAuditCtx() ctx: RequestContext) {
    return this.service.create(dto, actor, ctx);
  }

  @Patch(':id')
  @RequirePermission(Action.EditMeta, ResourceType.Album)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateAlbumDto,
    @CurrentActor() actor: Actor,
    @CurrentAuditCtx() ctx: RequestContext,
  ) {
    return this.service.update(id, dto, actor, ctx);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermission(Action.EditMeta, ResourceType.Album)
  changeStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AlbumStatusDto,
    @CurrentActor() actor: Actor,
    @CurrentAuditCtx() ctx: RequestContext,
  ) {
    return this.service.changeStatus(id, dto.status, actor, ctx);
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermission(Action.Delete, ResourceType.Album)
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DeleteAlbumDto,
    @CurrentActor() actor: Actor,
    @CurrentAuditCtx() ctx: RequestContext,
  ): Promise<{ deletedImages: number }> {
    const deletedImages = await this.service.remove(id, dto.confirmName, actor, ctx);
    return { deletedImages };
  }
}
