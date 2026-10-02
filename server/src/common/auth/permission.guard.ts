import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ADMIN_ACTION_KEY, PermissionRequirement, PERMISSION_KEY } from './auth-metadata';
import { ActorRequest } from './actor.guard';
import { AppError } from '../http/app-error';
import { AdminAction, Decision } from '../permission/types';
import { decideAdmin, decide } from '../permission/permission-policy';
import { ResourceLoader } from '../permission/resource-loader';
import { AuditService } from '../../modules/audit/audit.service';

function toError(d: Extract<Decision, { allowed: false }>): AppError {
  return new AppError(d.status, d.reason, d.message);
}

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly loader: ResourceLoader,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.get<PermissionRequirement>(
      PERMISSION_KEY,
      context.getHandler(),
    );
    if (!requirement) return true;

    const req = context.switchToHttp().getRequest<ActorRequest>();
    const rawId = req.params?.[requirement.param];
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new AppError(404, 'NOT_FOUND', '资源不存在或无权查看');
    }

    const resource = await this.loader.load(requirement.resourceType, id);
    if (!resource) {
      throw new AppError(404, 'NOT_FOUND', '资源不存在或无权查看');
    }

    const decision = decide(requirement.action, req.actor, resource);
    if (!decision.allowed) {
      await this.audit.record(req.actor, req.auditCtx, {
        action: `${requirement.action}_denied`,
        targetType: requirement.resourceType,
        targetId: id,
        detail: decision.reason,
        result: 0,
      });
      throw toError(decision);
    }
    return true;
  }
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.get<AdminAction | undefined>(
      ADMIN_ACTION_KEY,
      context.getHandler(),
    );
    if (!action) return true;

    const req = context.switchToHttp().getRequest<ActorRequest>();
    const decision = decideAdmin(req.actor, action);
    if (!decision.allowed) {
      await this.audit.record(req.actor, req.auditCtx, {
        action: `${action}_denied`,
        detail: decision.reason,
        result: 0,
      });
      throw toError(decision);
    }
    return true;
  }
}
