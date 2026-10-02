import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ActorRequest } from './actor.guard';
import { Actor } from '../permission/types';

export const CurrentActor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Actor =>
    ctx.switchToHttp().getRequest<ActorRequest>().actor,
);

export const CurrentAuditCtx = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<ActorRequest>().auditCtx,
);
