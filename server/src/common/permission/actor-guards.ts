import { HttpStatus } from '@nestjs/common';
import { AppError } from '../http/app-error';
import { Actor, ActorKind, Decision, MemberActor } from './types';

/** 仅正式成员可执行的写操作入口：一次判定同时把类型收窄 */
export function requireMember(actor: Actor, verb: string): MemberActor {
  if (actor.kind !== ActorKind.Member) {
    throw new AppError(HttpStatus.FORBIDDEN, 'MEMBER_ONLY', `临时账号与游客不能${verb}`);
  }
  return actor;
}

export function decisionError(decision: Extract<Decision, { allowed: false }>): AppError {
  return new AppError(decision.status, decision.reason, decision.message);
}

/** 服务内自己跑 decide() 时用：不允许即抛出与守卫完全一致的 401/403/404/409/413 */
export function unwrapDecision(decision: Decision): void {
  if (!decision.allowed) throw decisionError(decision);
}

export function memberUid(actor: Actor): number | null {
  return actor.kind === ActorKind.Member ? actor.uid : null;
}
