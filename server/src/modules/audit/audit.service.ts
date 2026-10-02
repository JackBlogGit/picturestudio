import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog, LogTargetType, LogUserType } from '../../entities';
import { Actor, ActorKind, ResourceType } from '../../common/permission/types';

export interface AuditInput {
  action: string;
  targetType?: LogTargetType | ResourceType;
  targetId?: number | null;
  detail?: string;
  result?: 0 | 1;
}

export interface RequestContext {
  ip: string;
  ua: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@InjectRepository(AuditLog) private readonly repo: Repository<AuditLog>) {}

  /**
   * 审计写入失败绝不能影响主流程（日志表满了或连不上时业务仍应可用），
   * 因此这里吞掉异常只打错误日志。
   */
  async record(actor: Actor | undefined, ctx: RequestContext, input: AuditInput): Promise<void> {
    const row = this.repo.create({
      userType: this.userTypeOf(actor),
      uid: actor?.kind === ActorKind.Member ? actor.uid : null,
      tempId: actor?.kind === ActorKind.Temp ? actor.tempId : null,
      action: input.action,
      targetType: (input.targetType ?? null) as LogTargetType | null,
      targetId: input.targetId ?? null,
      detail: this.trim(input.detail ?? '', 500),
      ip: ctx.ip,
      ua: this.trim(ctx.ua, 255),
      result: input.result ?? 1,
    });
    try {
      await this.repo.insert(row);
    } catch (err) {
      this.logger.error(`审计写入失败 action=${input.action}`, err as Error);
    }
  }

  private userTypeOf(actor: Actor | undefined): LogUserType {
    if (!actor) return 'system';
    if (actor.kind === ActorKind.Member) return 'user';
    if (actor.kind === ActorKind.Temp) return 'temp';
    return 'guest';
  }

  private trim(value: string, max: number): string {
    return value.length > max ? value.slice(0, max) : value;
  }
}
