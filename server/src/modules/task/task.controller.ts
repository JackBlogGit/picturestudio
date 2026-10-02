import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentActor, CurrentAuditCtx } from '../../common/auth/actor.decorator';
import { Actor } from '../../common/permission/types';
import { RequestContext } from '../audit/audit.service';
import { ListTaskDto, RevokeTaskDto, UpdateTaskStageDto } from './dto/task.dto';
import { TaskService } from './task.service';

/**
 * PRD 10.6 返图修图任务。工单宿主是临时账号（D10），可见性只看 owner 而非档位，
 * 所以这里不挂 @RequirePermission，判定统一在 TaskService 里跑 task-policy 纯函数。
 */
@Controller('tasks')
export class TaskController {
  constructor(private readonly service: TaskService) {}

  /** 必须排在 :tempId 之前，否则 statistics 会被当成工单号 */
  @Get('statistics')
  statistics(@CurrentActor() actor: Actor) {
    return this.service.statistics(actor);
  }

  @Get()
  list(@CurrentActor() actor: Actor, @Query() query: ListTaskDto) {
    return this.service.list(actor, query);
  }

  @Patch(':tempId/stage')
  @HttpCode(200)
  updateStage(
    @Param('tempId', ParseIntPipe) tempId: number,
    @Body() dto: UpdateTaskStageDto,
    @CurrentActor() actor: Actor,
    @CurrentAuditCtx() ctx: RequestContext,
  ) {
    return this.service.updateStage(tempId, dto, actor, ctx);
  }

  @Post(':tempId/revoke')
  @HttpCode(200)
  revoke(
    @Param('tempId', ParseIntPipe) tempId: number,
    @Body() dto: RevokeTaskDto,
    @CurrentActor() actor: Actor,
    @CurrentAuditCtx() ctx: RequestContext,
  ) {
    return this.service.revoke(tempId, actor, ctx);
  }
}
