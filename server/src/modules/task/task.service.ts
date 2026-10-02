import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { UserLevel } from '../../common/enums/user-level.enum';
import { clampPaging, Page, pagedList } from '../../common/http/pagination';
import { AppError } from '../../common/http/app-error';
import { unwrapDecision } from '../../common/permission/actor-guards';
import { Actor, ActorKind } from '../../common/permission/types';
import {
  TASK_STAGE_FILTERS,
  TASK_STAGE_FILTER_VALUES,
  TaskStageFilter,
  TaskTicket,
  checkStageTransition,
  decideTaskRevoke,
  decideTaskStage,
} from '../../common/permission/task-policy';
import { maskPhone } from '../../common/temp-account/phone-mask';
import { LogTargetType, TempAccount, User } from '../../entities';
import { AuditService, RequestContext } from '../audit/audit.service';
import { ListTaskDto, TASK_SORT_COLUMNS, UpdateTaskStageDto } from './dto/task.dto';

/** 列表行：阶段 + 归属 + 署名信息，手机号按身份决定脱敏与否 */
export interface TaskView {
  tempId: number;
  accountNo: string;
  loginName: string | null;
  displayName: string;
  phone: string | null;
  shootingNote: string;
  ownerUid: number;
  ownerName: string;
  expireTime: Date;
  disabled: number;
  preStage: number;
  postStage: number;
  preDoneTime: Date | null;
  postDoneTime: Date | null;
  createTime: Date;
}

/** 筛选条角标：5 个筛选值各自计数 + 总数（PRD 10.6） */
export type TaskStatistics = { total: number } & Record<TaskStageFilter, number>;

/** 搜索词短于 2 字符时不发前缀查询，与 17.3 的输入约定一致 */
export const MIN_SEARCH_LENGTH = 2;

function asTicket(row: TempAccount): TaskTicket {
  return {
    tempId: row.id,
    ownerUid: row.ownerUid,
    disabled: row.disabled,
    preStage: row.preStage,
    postStage: row.postStage,
  };
}

/**
 * 17.3 的 WHERE 条件由 TASK_STAGE_FILTERS 直接翻译，
 * 这样「徽标计数」与「列表结果」不可能各说一套。
 */
function stageConditionSql(filter: TaskStageFilter): string {
  const cond = TASK_STAGE_FILTERS[filter];
  const parts: string[] = [];
  if (cond.pre !== null) parts.push(`t.preStage = ${cond.pre}`);
  if (cond.post !== null) parts.push(`t.postStage = ${cond.post}`);
  return parts.length ? parts.join(' AND ') : '1 = 1';
}

/** LIKE 前缀匹配：通配符必须转义，否则用户输入 % 就变成全表扫 */
function prefixParam(keyword: string): string {
  return `${keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

@Injectable()
export class TaskService {
  constructor(
    @InjectRepository(TempAccount) private readonly temps: Repository<TempAccount>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly audit: AuditService,
  ) {}

  async list(actor: Actor, query: ListTaskDto): Promise<Page<TaskView>> {
    const { skip, take, page, pageSize } = clampPaging(query);
    const qb = this.scoped(actor);

    if (query.stage) qb.andWhere(stageConditionSql(query.stage));

    const kw = query.q?.trim();
    if (kw && kw.length >= MIN_SEARCH_LENGTH) {
      qb.andWhere(
        "(t.accountNo LIKE :kw ESCAPE '\\\\' OR t.loginName LIKE :kw ESCAPE '\\\\' OR t.displayName LIKE :kw ESCAPE '\\\\')",
        { kw: prefixParam(kw) },
      );
    }

    const column = TASK_SORT_COLUMNS[query.by ?? 'create_time'];
    qb.orderBy(column, query.sort === 'asc' ? 'ASC' : 'DESC').addOrderBy('t.id', 'DESC');

    const [rows, total] = await qb.skip(skip).take(take).getManyAndCount();
    const owners = await this.ownersOf(rows);
    return pagedList(rows.map((r) => this.toView(r, owners, actor)), total, page, pageSize);
  }

  async statistics(actor: Actor): Promise<TaskStatistics> {
    const qb = this.scoped(actor);
    qb.select('COUNT(t.id)', 'total');
    for (const filter of TASK_STAGE_FILTER_VALUES) {
      qb.addSelect(`SUM(CASE WHEN ${stageConditionSql(filter)} THEN 1 ELSE 0 END)`, filter);
    }
    const raw = await qb.getRawOne<Record<string, string | number | null>>();
    const num = (value: string | number | null | undefined): number => Number(value ?? 0);

    const stats = { total: num(raw?.total) } as TaskStatistics;
    for (const filter of TASK_STAGE_FILTER_VALUES) stats[filter] = num(raw?.[filter]);
    return stats;
  }

  /**
   * 推进 / 回退阶段（PRD 17.2）。先判「谁能动」，再判「动了合不合法」，
   * 两步分别对应 decideTaskStage 与 checkStageTransition，出错口径也不同。
   */
  async updateStage(
    tempId: number,
    dto: UpdateTaskStageDto,
    actor: Actor,
    ctx: RequestContext,
  ): Promise<TaskView> {
    const row = await this.loadTicket(tempId);
    const ticket = asTicket(row);

    unwrapDecision(decideTaskStage(actor, ticket, dto.status));
    unwrapDecision(checkStageTransition(ticket, dto.stage, dto.status));

    const current = dto.stage === 'pre' ? row.preStage : row.postStage;
    if (current === dto.status) return this.singleView(row, actor);

    const reverting = dto.status === 0;
    const reason = dto.reason?.trim() ?? '';
    if (reverting && !reason) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'REASON_REQUIRED', '回退阶段必须填写原因');
    }

    const doneTime = reverting ? null : new Date();
    const patch =
      dto.stage === 'pre'
        ? { preStage: dto.status, preDoneTime: doneTime }
        : { postStage: dto.status, postDoneTime: doneTime };
    await this.temps.update({ id: row.id }, patch);
    Object.assign(row, patch);

    await this.audit.record(actor, ctx, {
      action: reverting ? 'task_stage_reopened' : 'task_stage_updated',
      targetType: LogTargetType.Temp,
      targetId: row.id,
      detail: reverting
        ? `${dto.stage}=0, reason=${reason}`
        : `${dto.stage}=1, ${dto.stage}_done_time=${(doneTime ?? new Date()).toISOString()}`,
      result: 1,
    });
    return this.singleView(row, actor);
  }

  /**
   * 注销（D11）：只置 disabled=1，阶段值与已上传资源一律保留。
   * 临时账号自助销毁走 POST /auth/temp-destroy（D15），不在这个入口。
   */
  async revoke(tempId: number, actor: Actor, ctx: RequestContext): Promise<TaskView> {
    const row = await this.loadTicket(tempId);
    unwrapDecision(decideTaskRevoke(actor, asTicket(row)));
    if (row.disabled === 1) return this.singleView(row, actor);

    await this.temps.update({ id: row.id }, { disabled: 1 });
    row.disabled = 1;
    await this.audit.record(actor, ctx, {
      action: 'task_revoked',
      targetType: LogTargetType.Temp,
      targetId: row.id,
      detail: `account_no=${row.accountNo}, disabled=1`,
      result: 1,
    });
    return this.singleView(row, actor);
  }

  private async loadTicket(tempId: number): Promise<TempAccount> {
    const row = await this.temps.findOne({ where: { id: tempId } });
    if (!row) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', '工单不存在或无权查看');
    return row;
  }

  /**
   * 查询基座：档位维度对工单不成立，可见性只看 owner。
   * 默认排除已注销（17.3），注销项是行操作而不是筛选值。
   */
  private scoped(actor: Actor) {
    if (actor.kind === ActorKind.Member) {
      const qb = this.temps.createQueryBuilder('t').where('t.disabled = 0');
      if (actor.level <= UserLevel.Member) {
        qb.andWhere('t.ownerUid = :uid', { uid: actor.uid });
      }
      return qb;
    }
    if (actor.kind === ActorKind.Temp) {
      // 临时账号只读自己那张工单（17.4），到期/注销后由 ActorGuard 拦在 401
      return this.temps
        .createQueryBuilder('t')
        .where('t.disabled = 0')
        .andWhere('t.id = :tempId', { tempId: actor.tempId });
    }
    throw new AppError(HttpStatus.UNAUTHORIZED, 'LOGIN_REQUIRED', '返图任务需登录后访问');
  }

  private async ownersOf(rows: TempAccount[]): Promise<Map<number, string>> {
    const ids = [...new Set(rows.map((r) => r.ownerUid))];
    if (!ids.length) return new Map();
    const owners = await this.users.find({
      where: { id: In(ids) },
      select: { id: true, username: true, nickname: true },
    });
    return new Map(owners.map((u) => [u.id, u.nickname || u.username]));
  }

  private toView(row: TempAccount, owners: Map<number, string>, actor: Actor): TaskView {
    return {
      tempId: row.id,
      accountNo: row.accountNo,
      loginName: row.loginName,
      displayName: row.displayName,
      phone: this.showPhone(actor, row.ownerUid) ? row.phone : maskPhone(row.phone),
      shootingNote: row.shootingNote,
      ownerUid: row.ownerUid,
      ownerName: owners.get(row.ownerUid) ?? `#${row.ownerUid}`,
      expireTime: row.expireTime,
      disabled: row.disabled,
      preStage: row.preStage,
      postStage: row.postStage,
      preDoneTime: row.preDoneTime,
      postDoneTime: row.postDoneTime,
      createTime: row.createTime,
    };
  }

  private async singleView(row: TempAccount, actor: Actor): Promise<TaskView> {
    const owners = await this.ownersOf([row]);
    return this.toView(row, owners, actor);
  }

  /** 完整手机号只对工单 owner 本人与 L3/L4 放行（PRD 6.2） */
  private showPhone(actor: Actor, ownerUid: number): boolean {
    if (actor.kind !== ActorKind.Member) return false;
    return actor.uid === ownerUid || actor.level >= UserLevel.Admin;
  }
}
