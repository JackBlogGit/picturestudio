import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { CurrentActor, CurrentAuditCtx } from '../../common/auth/actor.decorator';
import { RequireAdmin, RequirePermission } from '../../common/auth/auth-metadata';
import { Action, AdminAction, Actor, ResourceType } from '../../common/permission/types';
import { RequestContext } from '../audit/audit.service';
import { CreateShareLinkDto, ListShareLinkDto } from './dto/share.dto';
import { ShareLinkService } from './share-link.service';

/**
 * 返图链接管理侧（PRD 10.3）。建链的鉴权走相册资源闸门，
 * 跨相册汇总的「返给个人」没有相册参数，逐册权限由服务里过三道闸自己判。
 */
@Controller()
export class ShareController {
  constructor(private readonly service: ShareLinkService) {}

  @Post('albums/:albumId/share-links')
  @HttpCode(201)
  @RequirePermission(Action.CreateShareLink, ResourceType.Album, 'albumId')
  create(
    @Param('albumId', ParseIntPipe) albumId: number,
    @Body() dto: CreateShareLinkDto,
    @CurrentActor() actor: Actor,
    @CurrentAuditCtx() ctx: RequestContext,
  ) {
    return this.service.createForAlbum(albumId, dto, actor, ctx);
  }

  @Post('share-links/personal')
  @HttpCode(201)
  createPersonal(
    @Body() dto: CreateShareLinkDto,
    @CurrentActor() actor: Actor,
    @CurrentAuditCtx() ctx: RequestContext,
  ) {
    return this.service.createForPerson(dto, actor, ctx);
  }

  @Get('share-links')
  @RequireAdmin(AdminAction.ShareLinkManagement)
  list(@Query() query: ListShareLinkDto, @CurrentActor() actor: Actor) {
    return this.service.list(query, actor);
  }

  @Delete('share-links/:id')
  @RequireAdmin(AdminAction.ShareLinkManagement)
  revoke(
    @Param('id', ParseIntPipe) id: number,
    @CurrentActor() actor: Actor,
    @CurrentAuditCtx() ctx: RequestContext,
  ) {
    return this.service.revoke(id, actor, ctx);
  }
}
