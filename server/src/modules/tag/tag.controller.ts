import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentActor, CurrentAuditCtx } from '../../common/auth/actor.decorator';
import { RequireAdmin } from '../../common/auth/auth-metadata';
import { AppError } from '../../common/http/app-error';
import { AdminAction, Actor, ActorKind } from '../../common/permission/types';
import { RequestContext } from '../audit/audit.service';
import { CreateTagDto, ListTagDto, MergeTagDto, RenameTagDto, SuggestTagDto } from './dto/tag.dto';
import { TagService } from './tag.service';
import { Tag } from '../../entities';

/** 对外只暴露打标需要的字段，创建人与频次属于后台信息 */
function publicTag(tag: Tag): { id: number; type: Tag['tagType']; name: string } {
  return { id: tag.id, type: tag.tagType, name: tag.tagName };
}

@Controller('tags')
export class TagController {
  constructor(private readonly service: TagService) {}

  @Get('suggest')
  async suggest(@CurrentActor() actor: Actor, @Query() dto: SuggestTagDto) {
    if (actor.kind === ActorKind.Guest) {
      throw new AppError(401, 'LOGIN_REQUIRED', '需登录后使用标签补全');
    }
    const rows = await this.service.suggest(actor, dto.type, dto.q);
    return rows.map(publicTag);
  }

  @Get()
  @RequireAdmin(AdminAction.MergeOrDeleteTag)
  async list(@Query() dto: ListTagDto) {
    const rows = await this.service.list(dto);
    return rows.map((t) => ({ ...publicTag(t), alias: t.alias, useCount: t.useCount, merged: t.mergedInto }));
  }

  @Post()
  @RequireAdmin(AdminAction.CreateTag)
  create(@Body() dto: CreateTagDto, @CurrentActor() actor: Actor, @CurrentAuditCtx() ctx: RequestContext) {
    return this.service.create(dto, actor, ctx).then(publicTag);
  }

  @Patch(':id')
  @RequireAdmin(AdminAction.CreateTag)
  rename(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RenameTagDto,
    @CurrentActor() actor: Actor,
    @CurrentAuditCtx() ctx: RequestContext,
  ) {
    return this.service.rename(id, dto.name, dto.alias, actor, ctx).then(publicTag);
  }

  @Post(':id/merge')
  @HttpCode(200)
  @RequireAdmin(AdminAction.MergeOrDeleteTag)
  merge(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MergeTagDto,
    @CurrentActor() actor: Actor,
    @CurrentAuditCtx() ctx: RequestContext,
  ) {
    return this.service.merge(id, dto.targetId, actor, ctx).then(publicTag);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireAdmin(AdminAction.MergeOrDeleteTag)
  remove(@Param('id', ParseIntPipe) id: number, @CurrentActor() actor: Actor, @CurrentAuditCtx() ctx: RequestContext) {
    return this.service.remove(id, actor, ctx);
  }
}
