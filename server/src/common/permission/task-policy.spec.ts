import { LEVEL_LABEL, UserLevel } from '../enums/user-level.enum';
import { ActorKind, Decision, GuestActor, MemberActor, ShareActor, TempActor } from './types';
import {
  TASK_STAGE_FILTER_VALUES,
  TASK_STAGE_FILTERS,
  TaskStageFilter,
  TaskTicket,
  checkStageTransition,
  decideTaskRead,
  decideTaskRevoke,
  decideTaskStage,
  isTaskStageFilter,
} from './task-policy';

const SELF = 100;
const OTHER = 200;
const TEMP_ID = 7;
/** 另一个临时账号，用来验证「不能碰别人的工单」 */
const OTHER_TEMP_ID = 99;

const LEVELS: UserLevel[] = [
  UserLevel.Trainee,
  UserLevel.Member,
  UserLevel.Admin,
  UserLevel.SuperAdmin,
];

function member(level: UserLevel, uid = SELF): MemberActor {
  return { kind: ActorKind.Member, uid, level };
}

const guest: GuestActor = { kind: ActorKind.Guest };
const shareVisitor: ShareActor = {
  kind: ActorKind.ShareVisitor,
  linkId: 1,
  imageIds: [1],
  allowDownload: false,
};

function temp(tempId = TEMP_ID, ownerUid = SELF): TempActor {
  return {
    kind: ActorKind.Temp,
    tempId,
    ownerUid,
    expired: false,
    disabled: false,
    flags: {
      preview: true,
      download: false,
      editTag: false,
    },
    quotaBytes: 0,
    usedBytes: 0,
    albumIds: [],
    folderIds: [],
  };
}

/** 缺省为「本人名下、未注销、两阶段均未完成」，各用例只覆盖自己关心的字段 */
function ticket(over: Partial<TaskTicket> = {}): TaskTicket {
  return {
    tempId: TEMP_ID,
    ownerUid: SELF,
    disabled: 0,
    preStage: 0,
    postStage: 0,
    ...over,
  };
}

function expectDeny(decision: Decision, status: number, reason: string): void {
  if (decision.allowed) throw new Error(`期望被拒(${reason})，实际放行`);
  expect(decision.status).toBe(status);
  expect(decision.reason).toBe(reason);
  expect(decision.message).toBeTruthy();
}

function expectAllow(decision: Decision): void {
  if (!decision.allowed) throw new Error(`期望放行，实际 ${decision.status} ${decision.reason}`);
  expect(decision.allowed).toBe(true);
}

/**
 * 以下期望表按 PRD 17.3/17.4 手工抄录，不复用实现里的常量——
 * 若有人改了 TASK_STAGE_FILTERS 或 RESOURCE_MATRIX 而忘了同步 PRD，这里会先红。
 */
describe('PRD 17.4 工单阶段授权：等级 × 归属 × 方向', () => {
  const cases: Array<{
    level: UserLevel;
    owned: boolean;
    target: 0 | 1;
    want: 'allow' | '404' | '403';
  }> = [
    // L1/L2：只能动自己登记的单
    { level: 1, owned: true, target: 1, want: 'allow' },
    { level: 1, owned: true, target: 0, want: '403' },
    { level: 1, owned: false, target: 1, want: '404' },
    { level: 1, owned: false, target: 0, want: '404' },
    { level: 2, owned: true, target: 1, want: 'allow' },
    { level: 2, owned: true, target: 0, want: '403' },
    { level: 2, owned: false, target: 1, want: '404' },
    { level: 2, owned: false, target: 0, want: '404' },
    // L3/L4：全站的单都能动，含回退
    { level: 3, owned: true, target: 1, want: 'allow' },
    { level: 3, owned: true, target: 0, want: 'allow' },
    { level: 3, owned: false, target: 1, want: 'allow' },
    { level: 3, owned: false, target: 0, want: 'allow' },
    { level: 4, owned: true, target: 1, want: 'allow' },
    { level: 4, owned: true, target: 0, want: 'allow' },
    { level: 4, owned: false, target: 1, want: 'allow' },
    { level: 4, owned: false, target: 0, want: 'allow' },
  ];

  for (const c of cases) {
    const label = `${LEVEL_LABEL[c.level]} · ${c.owned ? '本人' : '他人'} · 置${c.target}`;
    it(`${label} → ${c.want}`, () => {
      const actor = member(c.level);
      const ref = ticket({ ownerUid: c.owned ? SELF : OTHER });
      const decision = decideTaskStage(actor, ref, c.target);
      if (c.want === 'allow') {
        expectAllow(decision);
        return;
      }
      if (c.want === '404') {
        // 跨 owner 不暴露存在性，与 7.2 补充第 1 点同口径
        expectDeny(decision, 404, 'NOT_FOUND');
        return;
      }
      expectDeny(decision, 403, 'LEVEL_FORBIDDEN');
    });
  }

  it('未登录身份一律 401，且先于归属判定', () => {
    for (const actor of [guest, shareVisitor]) {
      expectDeny(decideTaskStage(actor, ticket(), 1), 401, 'LOGIN_REQUIRED');
      expectDeny(decideTaskStage(actor, ticket({ ownerUid: OTHER }), 1), 401, 'LOGIN_REQUIRED');
    }
  });

  it('临时账号只读：改任何阶段回 403 TASK_STAGE_READONLY（D11 之外的第二道锁）', () => {
    for (const target of [0, 1] as const) {
      expectDeny(decideTaskStage(temp(), ticket(), target), 403, 'TASK_STAGE_READONLY');
      expectDeny(
        decideTaskStage(temp(), ticket({ preStage: 1, postStage: 1 }), target),
        403,
        'TASK_STAGE_READONLY',
      );
    }
  });

  it('已注销工单（D11）阶段冻结：L4 也回 409，但读仍放行以便追责', () => {
    const revoked = ticket({ disabled: 1 });
    for (const level of LEVELS) {
      expectDeny(decideTaskStage(member(level), revoked, 1), 409, 'TASK_REVOKED');
    }
    expectAllow(decideTaskRead(member(4), revoked));
  });

  it('注销工单对 L1/L2 的他人仍然先 404，不给「已注销」这一信息', () => {
    expectDeny(
      decideTaskStage(member(1), ticket({ ownerUid: OTHER, disabled: 1 }), 1),
      404,
      'NOT_FOUND',
    );
  });
});

describe('PRD 17.4 工单可见性：L1/L2 只见自己 owner 的单', () => {
  for (const level of LEVELS) {
    const own = ticket();
    const others = ticket({ ownerUid: OTHER });
    it(`${LEVEL_LABEL[level]}：本人工单可见；他人工单${level <= UserLevel.Member ? ' 404' : ' 可见'}`, () => {
      expectAllow(decideTaskRead(member(level), own));
      if (level <= UserLevel.Member) {
        expectDeny(decideTaskRead(member(level), others), 404, 'NOT_FOUND');
      } else {
        expectAllow(decideTaskRead(member(level), others));
      }
    });
  }

  it('临时账号只能读自己那张工单', () => {
    expectAllow(decideTaskRead(temp(), ticket()));
    expectDeny(decideTaskRead(temp(OTHER_TEMP_ID), ticket()), 404, 'NOT_FOUND');
  });

  it('未登录 401', () => {
    expectDeny(decideTaskRead(guest, ticket()), 401, 'LOGIN_REQUIRED');
    expectDeny(decideTaskRead(shareVisitor, ticket()), 401, 'LOGIN_REQUIRED');
  });
});

describe('PRD 17.4 注销（D11 / D15）', () => {
  it('L1/L2 只能注销自己的单，他人 404', () => {
    expectAllow(decideTaskRevoke(member(1), ticket()));
    expectAllow(decideTaskRevoke(member(2), ticket()));
    expectDeny(decideTaskRevoke(member(1), ticket({ ownerUid: OTHER })), 404, 'NOT_FOUND');
  });

  it('L3/L4 可注销任意单', () => {
    for (const level of [3, 4] as UserLevel[]) {
      expectAllow(decideTaskRevoke(member(level), ticket()));
      expectAllow(decideTaskRevoke(member(level), ticket({ ownerUid: OTHER })));
    }
  });

  it('D15：临时账号可自毁，但不能碰别人的单', () => {
    expectAllow(decideTaskRevoke(temp(), ticket()));
    expectDeny(decideTaskRevoke(temp(OTHER_TEMP_ID), ticket()), 404, 'NOT_FOUND');
  });

  it('未登录 401', () => {
    expectDeny(decideTaskRevoke(guest, ticket()), 401, 'LOGIN_REQUIRED');
  });
});

describe('PRD 17.2 状态机：不可跳跃、不可留下矛盾态', () => {
  const transitions: Array<{
    pre: 0 | 1;
    post: 0 | 1;
    stage: 'pre' | 'post';
    target: 0 | 1;
    want: 'allow' | 409;
  }> = [
    { pre: 0, post: 0, stage: 'pre', target: 1, want: 'allow' },
    { pre: 0, post: 0, stage: 'post', target: 1, want: 409 }, // 跳跃推进
    { pre: 0, post: 0, stage: 'pre', target: 0, want: 'allow' }, // 幂等
    { pre: 0, post: 1, stage: 'post', target: 1, want: 'allow' },
    { pre: 1, post: 0, stage: 'post', target: 1, want: 'allow' },
    { pre: 1, post: 0, stage: 'pre', target: 0, want: 'allow' },
    { pre: 1, post: 1, stage: 'post', target: 0, want: 'allow' },
    { pre: 1, post: 1, stage: 'pre', target: 0, want: 409 }, // 回退顺序
    { pre: 0, post: 1, stage: 'pre', target: 1, want: 'allow' },
  ];

  for (const t of transitions) {
    const label = `pre=${t.pre} post=${t.post} → ${t.stage}=${t.target}`;
    it(label, () => {
      const decision = checkStageTransition(ticket({ preStage: t.pre, postStage: t.post }), t.stage, t.target);
      if (t.want === 'allow') expectAllow(decision);
      else expectDeny(decision, 409, 'STAGE_ORDER_VIOLATION');
    });
  }

  it('权限与合法性各自独立：L1 对自己的单有权限，但跳跃仍 409', () => {
    const ref = ticket({ preStage: 0, postStage: 0 });
    expectAllow(decideTaskStage(member(1), ref, 1));
    expectDeny(checkStageTransition(ref, 'post', 1), 409, 'STAGE_ORDER_VIOLATION');
  });
});

describe('PRD 17.3 筛选条：5 个值与 SQL 条件逐一对得上', () => {
  /** 把筛选条件还原成谓词，null 维度视为不加条件 */
  function matches(filter: TaskStageFilter, pre: number, post: number): boolean {
    const c = TASK_STAGE_FILTERS[filter];
    return (c.pre === null || c.pre === pre) && (c.post === null || c.post === post);
  }

  /** 17.3 的 SQL 谓词逐条手抄成「(pre,post) → 是否命中」 */
  const EXPECTED: Record<TaskStageFilter, Array<[number, number]>> = {
    pre_pending: [[0, 0], [0, 1]],
    post_pending: [[1, 0]],
    pre_done: [[1, 0], [1, 1]],
    post_done: [[0, 1], [1, 1]],
    all_done: [[1, 1]],
  };

  const STATES: Array<[number, number]> = [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ];

  it('筛选值恰好 5 个，且都有中文名（前台徽标直接用 label）', () => {
    expect(TASK_STAGE_FILTER_VALUES).toHaveLength(5);
    for (const value of TASK_STAGE_FILTER_VALUES) {
      expect(TASK_STAGE_FILTERS[value].label).toBeTruthy();
    }
  });

  for (const [name, states] of Object.entries(EXPECTED) as Array<[TaskStageFilter, Array<[number, number]>]>) {
    it(`${name}（${TASK_STAGE_FILTERS[name].label}）命中的状态与 17.3 一致`, () => {
      const actual = STATES.filter(([pre, post]) => matches(name, pre, post));
      expect(actual).toEqual(states);
    });
  }

  it('all_done 是 pre_done 与 post_done 的交集，post_pending 不等于 pre_done', () => {
    expect(matches('all_done', 1, 0)).toBe(false);
    expect(matches('post_pending', 0, 1)).toBe(false); // 未跳跃的单不可能出现该态，谓词本身也不认
    expect(matches('pre_done', 0, 1)).toBe(false);
    expect(matches('post_done', 0, 1)).toBe(true);
  });

  it('isTaskStageFilter 只认这 5 个值，其余交给 DTO 拦', () => {
    for (const value of TASK_STAGE_FILTER_VALUES) {
      expect(isTaskStageFilter(value)).toBe(true);
    }
    for (const bad of ['done', 'pending', '', 'ALL_DONE', 1, null, undefined, {}]) {
      expect(isTaskStageFilter(bad)).toBe(false);
    }
  });
});
