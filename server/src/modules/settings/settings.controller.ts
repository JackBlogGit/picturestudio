import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { CurrentActor, CurrentAuditCtx } from '../../common/auth/actor.decorator';
import { RequireAdmin } from '../../common/auth/auth-metadata';
import { AppError } from '../../common/http/app-error';
import { LogTargetType } from '../../entities';
import { Actor, ActorKind, AdminAction } from '../../common/permission/types';
import { AuditService, RequestContext } from '../audit/audit.service';
import { SettingsService } from './settings.service';
import { UpdateSettingsDto } from './dto/settings.dto';

@Controller('admin/settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequireAdmin(AdminAction.ReadSiteSettings)
  list() {
    return this.settings.listAll();
  }

  @Put()
  @RequireAdmin(AdminAction.WriteSiteSettings)
  async update(
    @Body() dto: UpdateSettingsDto,
    @CurrentActor() actor: Actor,
    @CurrentAuditCtx() ctx: RequestContext,
  ) {
    if (actor.kind !== ActorKind.Member) {
      throw new AppError(403, 'ADMIN_REQUIRED', '仅正式成员可修改站点配置');
    }
    await this.settings.setMany(dto.entries, actor.uid);
    await this.audit.record(actor, ctx, {
      action: 'site_settings_updated',
      targetType: LogTargetType.Site,
      detail: dto.entries.map((e) => e.key).join(','),
    });
    return { updated: dto.entries.length };
  }

  @Post('reload')
  @RequireAdmin(AdminAction.WriteSiteSettings)
  async reload() {
    await this.settings.reload();
    return { reloaded: true };
  }
}
