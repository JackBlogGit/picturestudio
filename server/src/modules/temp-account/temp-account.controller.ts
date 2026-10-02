import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { CurrentActor, CurrentAuditCtx } from '../../common/auth/actor.decorator';
import { Actor } from '../../common/permission/types';
import { RequestContext } from '../audit/audit.service';
import { CreateTempAccountDto, ListTempAccountDto } from './dto/temp-account.dto';
import { TempAccountService } from './temp-account.service';

/**
 * PRD 6.2 临时账号（同时是第 17 章工单的宿主）。
 * 路径按 6.2 的表单对照表挂在 /temp-accounts 下，10.5 的 /admin/temp-accounts 是同一组能力的后台叫法。
 */
@Controller('temp-accounts')
export class TempAccountController {
  constructor(private readonly service: TempAccountService) {}

  @Get('schema')
  schema(@CurrentActor() actor: Actor) {
    return this.service.schema(actor);
  }

  @Get('next-account-no')
  nextAccountNo(@CurrentActor() actor: Actor) {
    return this.service.nextAccountNo(actor);
  }

  @Get()
  list(@CurrentActor() actor: Actor, @Query() query: ListTempAccountDto) {
    return this.service.list(actor, query);
  }

  /** 响应体里的 password / accessToken 只在创建这一次出现 */
  @Post()
  @HttpCode(201)
  create(
    @Body() dto: CreateTempAccountDto,
    @CurrentActor() actor: Actor,
    @CurrentAuditCtx() ctx: RequestContext,
  ) {
    return this.service.create(dto, actor, ctx);
  }
}
