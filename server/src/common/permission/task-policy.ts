import { UserLevel } from '../enums/user-level.enum';
import { RESOURCE_MATRIX } from './permission-policy';
import {
  Action,
  Actor,
  ActorKind,
  allow,
  Decision,
  deny,
  MemberActor,
  Scope,
  TempActor,
} from './types';

/**
 * PRD 第 17 章：返图修图工单（宿主 = 临时账号，D10）的判定内核。
 *
 * 为什么不复用 decide()：7.2 矩阵的两个 ❌ 都建立在「档位」上，而工单的可见性
 * 建立在「谁是这单的 owner」上，`temp_accounts` 根本没有 visibility 列。
 * 硬塞进 ResourceRef 只会逼调用方编一个假档位出来，所以这里单列一套纯函数。
 */
export interface TaskTicket {
  tempId: number;
  ownerUid: number;
  /** 1 = 已注销（D11）。注销后阶段值保留用于追责，但不可再变更 */
  disabled: number;
  preStage: number;
  postStage: number;
}

export type StageName = 'pre' | 'post';
export type StageStatus = 0 | 1;

function isMember(actor: Actor): actor is MemberActor {
  return actor.kind === ActorKind.Member;
}

function scopeOf(level: UserLevel): Scope {
  return RESOURCE_MATRIX[Action.TaskStageUpdate][level];
}

/** 跨 owner 的工单对 L1/L2 一律 404：连「这单存在」都不暴露，与 7.2 补充第 1 点同口径 */
function memberOnTicket(actor: MemberActor, ticket: TaskTicket): Decision | null {
  const scope = scopeOf(actor.level);
  if (scope === 'none') return deny(403, 'LEVEL_FORBIDDEN', '当前身份无权操作工单');
  if (scope === 'own' && ticket.ownerUid !== actor.uid) {
    return deny(404, 'NOT_FOUND', '工单不存在或无权查看');
  }
  return null;
}

function notLoggedIn(actor: Actor): Decision | null {
  if (actor.kind === ActorKind.Guest || actor.kind === ActorKind.ShareVisitor) {
    return deny(401, 'LOGIN_REQUIRED', '返图任务需登录后访问');
  }
  return null;
}

export function decideTaskRead(actor: Actor, ticket: TaskTicket): Decision {
  const anon = notLoggedIn(actor);
  if (anon) return anon;
  if (actor.kind === ActorKind.Temp) {
    const temp = actor as TempActor;
    return temp.tempId === ticket.tempId
      ? allow()
      : deny(404, 'NOT_FOUND', '工单不存在或无权查看');
  }
  return memberOnTicket(actor as MemberActor, ticket) ?? allow();
}

/**
 * 阶段推进 / 回退的授权（PRD 17.4 表）。
 * direction 由目标值推出：置 1 是推进，置 0 是回退。
 */
export function decideTaskStage(actor: Actor, ticket: TaskTicket, target: StageStatus): Decision {
  const anon = notLoggedIn(actor);
  if (anon) return anon;

  if (actor.kind === ActorKind.Temp) {
    return deny(403, 'TASK_STAGE_READONLY', '工单阶段由发起人或管理员维护，临时账号只读');
  }

  const member = actor as MemberActor;
  const owned = memberOnTicket(member, ticket);
  if (owned) return owned;
  if (ticket.disabled === 1) {
    return deny(409, 'TASK_REVOKED', '工单已注销，阶段不可再变更');
  }
  if (target === 0 && member.level < UserLevel.Admin) {
    return deny(403, 'LEVEL_FORBIDDEN', '回退阶段仅 L3/L4 可执行');
  }
  return allow();
}

/**
 * 注销（D11）。比阶段多放一种身份：临时账号可以销毁自己（D15），
 * 但销毁别人名下的工单仍需 L3/L4。
 */
export function decideTaskRevoke(actor: Actor, ticket: TaskTicket): Decision {
  if (actor.kind === ActorKind.Guest || actor.kind === ActorKind.ShareVisitor) {
    return deny(401, 'LOGIN_REQUIRED', '需登录后访问');
  }
  if (actor.kind === ActorKind.Temp) {
    const temp = actor as TempActor;
    return temp.tempId === ticket.tempId
      ? allow()
      : deny(404, 'NOT_FOUND', '工单不存在或无权查看');
  }
  return memberOnTicket(actor as MemberActor, ticket) ?? allow();
}

/**
 * PRD 17.2 状态机：正向不可跳跃，回退不可留下「后期已完成但前期未完成」的矛盾态。
 * 与 decideTaskStage 分开，是为了让「谁能动」和「动了合不合法」各自可测。
 */
export function checkStageTransition(
  ticket: TaskTicket,
  stage: StageName,
  target: StageStatus,
): Decision {
  const current = stage === 'pre' ? ticket.preStage : ticket.postStage;
  if (current === target) return allow();

  if (target === 1) {
    if (stage === 'post' && ticket.preStage !== 1) {
      return deny(409, 'STAGE_ORDER_VIOLATION', '前期修图未完成，不能直接标记后期返图完成');
    }
    return allow();
  }

  if (stage === 'pre' && ticket.postStage === 1) {
    return deny(409, 'STAGE_ORDER_VIOLATION', '请先回退「后期返图」，再回退「前期修图」');
  }
  return allow();
}

/** PRD 17.3 筛选条：null = 该维度不加条件 */
export type TaskStageFilter =
  | 'pre_pending'
  | 'post_pending'
  | 'pre_done'
  | 'post_done'
  | 'all_done';

export const TASK_STAGE_FILTERS: Record<
  TaskStageFilter,
  { label: string; pre: 0 | 1 | null; post: 0 | 1 | null }
> = {
  pre_pending: { label: '前期未完成', pre: 0, post: null },
  post_pending: { label: '后期未完成', pre: 1, post: 0 },
  pre_done: { label: '前期已完成', pre: 1, post: null },
  post_done: { label: '后期已完成', pre: null, post: 1 },
  all_done: { label: '全部已完成', pre: 1, post: 1 },
};

export const TASK_STAGE_FILTER_VALUES = Object.keys(TASK_STAGE_FILTERS) as TaskStageFilter[];

export function isTaskStageFilter(value: unknown): value is TaskStageFilter {
  return typeof value === 'string' && value in TASK_STAGE_FILTERS;
}
