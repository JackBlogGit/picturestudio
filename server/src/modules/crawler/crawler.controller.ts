import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentActor, CurrentAuditCtx } from '../../common/auth/actor.decorator';
import { RequireAdmin } from '../../common/auth/auth-metadata';
import { Actor, AdminAction } from '../../common/permission/types';
import { RequestContext } from '../audit/audit.service';
import { CrawlerService } from './crawler.service';
import {
  CreateCrawlerLinkDto,
  ListCrawlerLinkDto,
  ProbeCrawlerDto,
  SearchCrawlerDto,
  UpdateCrawlerLinkDto,
} from './dto/crawler.dto';

/**
 * PRD 10.8 站外来源登记（D28）。整组路由只认超级管理员：
 * 爬虫与备份一样不参与 D20 个人授权与 D21 能力位覆盖，L3 也进不来。
 * 采集动作会驱动外部命令与出站请求，所以检索/探页单独收紧限流。
 */
@Controller('admin/crawler')
export class CrawlerController {
  constructor(private readonly service: CrawlerService) {}

  @Post('search')
  @RequireAdmin(AdminAction.CrawlerSearch)
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  search(@Body() dto: SearchCrawlerDto, @CurrentActor() actor: Actor, @CurrentAuditCtx() ctx: RequestContext) {
    return this.service.search(dto, actor, ctx);
  }

  @Post('probe')
  @RequireAdmin(AdminAction.CrawlerSearch)
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  probe(@Body() dto: ProbeCrawlerDto, @CurrentActor() actor: Actor, @CurrentAuditCtx() ctx: RequestContext) {
    return this.service.probe(dto, actor, ctx);
  }

  @Get('links')
  @RequireAdmin(AdminAction.CrawlerSearch)
  list(@Query() query: ListCrawlerLinkDto) {
    return this.service.list(query);
  }

  @Post('links')
  @RequireAdmin(AdminAction.CrawlerManage)
  create(
    @Body() dto: CreateCrawlerLinkDto,
    @CurrentActor() actor: Actor,
    @CurrentAuditCtx() ctx: RequestContext,
  ) {
    return this.service.create(dto, actor, ctx);
  }

  @Patch('links/:id')
  @RequireAdmin(AdminAction.CrawlerManage)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCrawlerLinkDto,
    @CurrentActor() actor: Actor,
    @CurrentAuditCtx() ctx: RequestContext,
  ) {
    return this.service.updateStatus(id, dto, actor, ctx);
  }

  @Delete('links/:id')
  @RequireAdmin(AdminAction.CrawlerManage)
  remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentActor() actor: Actor,
    @CurrentAuditCtx() ctx: RequestContext,
  ) {
    return this.service.remove(id, actor, ctx);
  }
}
