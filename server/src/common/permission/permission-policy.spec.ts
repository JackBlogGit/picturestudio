import { LEVEL_LABEL, UserLevel } from '../enums/user-level.enum';
import { Visibility } from '../enums/visibility.enum';
import {
  ADMIN_MATRIX,
  RESOURCE_MATRIX,
  VISIBLE_MAX_RANK,
  canGenerateShareLinkFor,
  canManageTargetUser,
  canSetVisibility,
  capabilitiesFor,
  checkInheritance,
  decide,
  decideAdmin,
  effectiveVisibility,
} from './permission-policy';
import {
  Action,
  AdminAction,
  Actor,
  ActorKind,
  Decision,
  GuestActor,
  MemberActor,
  ResourceRef,
  ResourceType,
  Scope,
  ShareActor,
  TempActor,
  TempFlags,
} from './types';

const SELF = 100;
const OTHER = 200;
const ALBUM_ID = 10;
const ROOT_FOLDER = 1;
const IMAGE_ID = 500;

const LEVELS: UserLevel[] = [
  UserLevel.Trainee,
  UserLevel.Member,
  UserLevel.Admin,
  UserLevel.SuperAdmin,
];
const ACTIONS: Action[] = Object.values(Action);
const ADMIN_ACTIONS: AdminAction[] = Object.values(AdminAction);

function member(level: UserLevel, uid = SELF): MemberActor {
  return { kind: ActorKind.Member, uid, level };
}

const guest: GuestActor = { kind: ActorKind.Guest };

/** 缺省为「成员档、他人上传、位于成员档相册内」，各用例只覆盖自己关心的字段 */
function resource(over: Partial<ResourceRef> = {}): ResourceRef {
  return {
    type: ResourceType.Image,
    id: IMAGE_ID,
    visibility: Visibility.Member,
    ownerId: OTHER,
    albumId: ALBUM_ID,
    containerVisibilities: [Visibility.Member],
    ...over,
  };
}

function allFlags(over: Partial<TempFlags> = {}): TempFlags {
  return {
    preview: true,
    download: true,
    uploadImg: true,
    uploadFile: true,
    editTag: true,
    ...over,
  };
}

function temp(over: Partial<TempActor> = {}): TempActor {
  return {
    kind: ActorKind.Temp,
    tempId: 7,
    ownerUid: 3,
    expired: false,
    disabled: false,
    flags: allFlags(),
    quotaBytes: 0,
    usedBytes: 0,
    albumIds: [ALBUM_ID],
    folderIds: [ROOT_FOLDER],
    ...over,
  };
}

function share(over: Partial<ShareActor> = {}): ShareActor {
  return {
    kind: ActorKind.ShareVisitor,
    linkId: 20,
    imageIds: [IMAGE_ID],
    allowDownload: false,
    ...over,
  };
}

function expectAllow(decision: Decision): void {
  expect(decision).toEqual({ allowed: true });
}

function expectDeny(decision: Decision, status: number, reason: string): void {
  if (decision.allowed) throw new Error(`期望被拒(${reason})，实际放行`);
  expect(decision.status).toBe(status);
  expect(decision.reason).toBe(reason);
  expect(decision.message).toBeTruthy();
}

/**
 * 以下三张期望表按 PRD 7.2/7.3 与 6.1 手工抄录，不复用实现里的矩阵常量——
 * 若有人改动 RESOURCE_MATRIX 而忘了同步 PRD，这里会先红。
 */
const EXPECTED_SCOPE: Record<Action, Record<UserLevel, Scope>> = {
  [Action.Preview]: { 1: 'any', 2: 'any', 3: 'any', 4: 'any' },
  [Action.DownloadOriginal]: { 1: 'none', 2: 'any', 3: 'any', 4: 'any' },
  [Action.ZipDownload]: { 1: 'none', 2: 'any', 3: 'any', 4: 'any' },
  [Action.Upload]: { 1: 'any', 2: 'any', 3: 'any', 4: 'any' },
  [Action.EditMeta]: { 1: 'own', 2: 'own', 3: 'any', 4: 'any' },
  [Action.EditTags]: { 1: 'own', 2: 'own', 3: 'any', 4: 'any' },
  [Action.ChangeVisibility]: { 1: 'own', 2: 'own', 3: 'any', 4: 'any' },
  [Action.Delete]: { 1: 'none', 2: 'own', 3: 'any', 4: 'any' },
  [Action.CreateShareLink]: { 1: 'none', 2: 'own', 3: 'any', 4: 'any' },
  // PRD 17.4：登记归属范围；档位维度对它不成立，故不进下面的 7.2 全表
  [Action.TaskStageUpdate]: { 1: 'own', 2: 'own', 3: 'any', 4: 'any' },
};

/** 7.2 全表只覆盖「操作 × 档位」；工单阶段按归属判定，规则单列在 task-policy.spec */
const TIER_KEYED_ACTIONS: Action[] = ACTIONS.filter((a) => a !== Action.TaskStageUpdate);

/** 7.2 表格列头：public / member / admin / private（他人）/ private（本人） */
type TierCase = 'public' | 'member' | 'admin' | 'privateOther' | 'privateSelf';

const TIERS: Record<TierCase, { visibility: Visibility; ownerId: number }> = {
  public: { visibility: Visibility.Public, ownerId: OTHER },
  member: { visibility: Visibility.Member, ownerId: OTHER },
  admin: { visibility: Visibility.Admin, ownerId: OTHER },
  privateOther: { visibility: Visibility.Private, ownerId: OTHER },
  privateSelf: { visibility: Visibility.Private, ownerId: SELF },
};
const TIER_KEYS = Object.keys(TIERS) as TierCase[];

const EXPECTED_VISIBLE: Record<UserLevel, Record<TierCase, boolean>> = {
  1: { public: true, member: true, admin: false, privateOther: false, privateSelf: true },
  2: { public: true, member: true, admin: false, privateOther: false, privateSelf: true },
  3: { public: true, member: true, admin: true, privateOther: false, privateSelf: true },
  4: { public: true, member: true, admin: true, privateOther: true, privateSelf: true },
};

describe('PRD 7.2 授权范围矩阵', () => {
  for (const action of ACTIONS) {
    it(`${action} 的等级授权范围与 PRD 7.2 一致`, () => {
      expect(RESOURCE_MATRIX[action]).toEqual(EXPECTED_SCOPE[action]);
    });
  }

  it('可见性档位上限：L1/L2 到 member，L3 到 admin，L4 到 private', () => {
    expect(VISIBLE_MAX_RANK).toEqual({
      [UserLevel.Trainee]: 2,
      [UserLevel.Member]: 2,
      [UserLevel.Admin]: 3,
      [UserLevel.SuperAdmin]: 4,
    });
  });

  it('矩阵中不存在无人认领的等级或操作（新增 Action 必须补表）', () => {
    for (const action of ACTIONS) {
      expect(Object.keys(RESOURCE_MATRIX[action])).toHaveLength(LEVELS.length);
      for (const level of LEVELS) {
        expect(['none', 'own', 'any']).toContain(RESOURCE_MATRIX[action][level]);
      }
    }
  });
});

describe('PRD 7.2 全表：等级 × 档位归属 × 操作', () => {
  for (const level of LEVELS) {
    for (const tier of TIER_KEYS) {
      const { visibility, ownerId } = TIERS[tier];
      const ref = resource({ visibility, ownerId, containerVisibilities: [visibility] });

      for (const action of TIER_KEYED_ACTIONS) {
        const label = `${LEVEL_LABEL[level]} · ${tier} · ${action}`;
        it(label, () => {
          const visible = EXPECTED_VISIBLE[level][tier];
          if (!visible) {
            // 档位不可见一律 404，不向低等级暴露资源存在性（D1）
            expectDeny(decide(action, member(level), ref), 404, 'NOT_FOUND');
            return;
          }
          const scope = EXPECTED_SCOPE[action][level];
          const decision = decide(action, member(level), ref);
          if (scope === 'none') {
            expectDeny(decision, 403, 'LEVEL_FORBIDDEN');
          } else if (scope === 'own' && ownerId !== SELF) {
            expectDeny(decision, 403, 'NOT_OWNER');
          } else {
            expectAllow(decision);
          }
        });
      }
    }
  }

  it('网盘资源走同一套成员判定', () => {
    const folder = resource({
      type: ResourceType.Folder,
      id: ROOT_FOLDER,
      albumId: undefined,
      folderIdChain: [ROOT_FOLDER],
      visibility: Visibility.Admin,
      containerVisibilities: [Visibility.Admin],
    });
    expectDeny(decide(Action.Preview, member(UserLevel.Member), folder), 404, 'NOT_FOUND');
    expectAllow(decide(Action.Preview, member(UserLevel.Admin), folder));
    expectDeny(
      decide(Action.Delete, member(UserLevel.Member, OTHER), folder),
      404,
      'NOT_FOUND',
    );
  });

  it('L1 可下载自己上传的图？否——下载原图需 L2+（PRD 7.2 括注「需 L2+ 代下」）', () => {
    const own = resource({ visibility: Visibility.Member, ownerId: SELF });
    expectDeny(decide(Action.DownloadOriginal, member(UserLevel.Trainee), own), 403, 'LEVEL_FORBIDDEN');
    expectDeny(decide(Action.ZipDownload, member(UserLevel.Trainee), own), 403, 'LEVEL_FORBIDDEN');
    expectAllow(decide(Action.DownloadOriginal, member(UserLevel.Member), own));
  });
});

describe('PRD 3.2 继承上限', () => {
  it('effectiveVisibility 取自身与祖先链中最严的一档', () => {
    expect(
      effectiveVisibility(resource({ visibility: Visibility.Member, containerVisibilities: [Visibility.Admin] })),
    ).toBe(Visibility.Admin);
    expect(
      effectiveVisibility(resource({ visibility: Visibility.Public, containerVisibilities: [Visibility.Public, Visibility.Member] })),
    ).toBe(Visibility.Member);
    expect(effectiveVisibility(resource({ containerVisibilities: undefined }))).toBe(Visibility.Member);
  });

  it('上级为 admin 时，L2 连预览都看不到（15.6 同源规则）', () => {
    const insideAdmin = resource({
      visibility: Visibility.Member,
      containerVisibilities: [Visibility.Admin],
    });
    expectDeny(decide(Action.Preview, member(UserLevel.Member), insideAdmin), 404, 'NOT_FOUND');
    expectAllow(decide(Action.Preview, member(UserLevel.Admin), insideAdmin));
  });

  it('文件夹子树继承：链上任一祖先为 admin，即按 admin 判定', () => {
    const deep = resource({
      type: ResourceType.File,
      visibility: Visibility.Public,
      albumId: undefined,
      folderIdChain: [1, 5, 12],
      containerVisibilities: [Visibility.Member, Visibility.Admin],
    });
    expectDeny(decide(Action.Preview, member(UserLevel.Trainee), deep), 404, 'NOT_FOUND');
    expectDeny(decide(Action.Preview, member(UserLevel.Member), deep), 404, 'NOT_FOUND');
    expectAllow(decide(Action.Preview, member(UserLevel.Admin), deep));
    expectAllow(decide(Action.Preview, member(UserLevel.SuperAdmin), deep));
  });

  it('checkInheritance：子资源不得宽于父容器', () => {
    expectAllow(checkInheritance(Visibility.Member, [Visibility.Member]));
    expectAllow(checkInheritance(Visibility.Private, [Visibility.Member]));
    expectAllow(checkInheritance(Visibility.Admin, []));
    expectDeny(
      checkInheritance(Visibility.Public, [Visibility.Member]),
      409,
      'INHERITANCE_VIOLATION',
    );
    expectDeny(
      checkInheritance(Visibility.Member, [Visibility.Admin, Visibility.Private]),
      409,
      'INHERITANCE_VIOLATION',
    );
  });

  it('放宽上级必须由调用方先处理，否则 message 里要给出上级档位', () => {
    const d = checkInheritance(Visibility.Public, [Visibility.Admin]);
    if (d.allowed) throw new Error('应被拦截');
    expect(d.message).toContain(Visibility.Admin);
  });
});

describe('PRD 7.3 临时账号', () => {
  it('已销毁或已到期的账号：任何操作 401，且先于白名单判定', () => {
    const outside = resource({ albumId: 999, containerVisibilities: [Visibility.Member] });
    expectDeny(decide(Action.Preview, temp({ disabled: true }), outside), 401, 'TEMP_EXPIRED');
    expectDeny(decide(Action.Preview, temp({ expired: true }), outside), 401, 'TEMP_EXPIRED');
    expectDeny(decide(Action.Preview, temp({ disabled: true }), resource()), 401, 'TEMP_EXPIRED');
  });

  it('白名单未命中一律 404，不暴露资源存在性（7.3 第 2 步）', () => {
    const cases: Array<[Action, ResourceRef]> = [
      [Action.Preview, resource({ albumId: 999 })],
      [Action.Preview, resource({ type: ResourceType.Album, id: 999, albumId: undefined })],
      [Action.Upload, resource({ type: ResourceType.Folder, folderIdChain: [88], albumId: undefined })],
    ];
    for (const [action, ref] of cases) {
      expectDeny(decide(action, temp(), ref), 404, 'NOT_IN_WHITELIST');
    }
  });

  it('白名单为空 ⇒ 连上传也没有目标，404（15.11，统一按不暴露存在性处理）', () => {
    const bare = temp({ albumIds: [], folderIds: [] });
    expectDeny(decide(Action.Preview, bare, resource()), 404, 'NOT_IN_WHITELIST');
    expectDeny(decide(Action.Upload, bare, resource({ type: ResourceType.Album, albumId: ALBUM_ID })), 404, 'NOT_IN_WHITELIST');
  });

  it('图片命中所属相册即放行；子孙文件夹命中祖先链即放行', () => {
    expectAllow(decide(Action.Preview, temp(), resource({ albumId: ALBUM_ID })));
    expectAllow(
      decide(
        Action.Preview,
        temp(),
        resource({ type: ResourceType.File, albumId: undefined, folderIdChain: [5, ROOT_FOLDER, 12] }),
      ),
    );
  });

  it('白名单即授权：命中白名单的 private 相册对临时账号可见（6.2）', () => {
    const privateAlbum = resource({
      type: ResourceType.Album,
      id: ALBUM_ID,
      albumId: undefined,
      visibility: Visibility.Private,
      containerVisibilities: [Visibility.Private],
    });
    expectAllow(decide(Action.Preview, temp(), privateAlbum));
    expectDeny(
      decide(Action.Preview, temp({ albumIds: [] }), privateAlbum),
      404,
      'NOT_IN_WHITELIST',
    );
  });

  it('五项开关各自把关对应操作', () => {
    const img = resource();
    const folder = resource({ type: ResourceType.Folder, albumId: undefined, folderIdChain: [ROOT_FOLDER] });

    expectDeny(decide(Action.Preview, temp({ flags: allFlags({ preview: false }) }), img), 403, 'TEMP_SWITCH_OFF');
    expectAllow(decide(Action.Preview, temp(), img));

    expectDeny(decide(Action.DownloadOriginal, temp({ flags: allFlags({ download: false }) }), img), 403, 'TEMP_SWITCH_OFF');
    expectDeny(decide(Action.ZipDownload, temp({ flags: allFlags({ download: false }) }), img), 403, 'TEMP_SWITCH_OFF');
    expectAllow(decide(Action.DownloadOriginal, temp(), img));

    expectDeny(decide(Action.Upload, temp({ flags: allFlags({ uploadImg: false }) }), img), 403, 'TEMP_SWITCH_OFF');
    expectAllow(decide(Action.Upload, temp(), img));

    // 图片开关不等于文件开关：向文件夹投递只看 allow_upload_file
    expectDeny(decide(Action.Upload, temp({ flags: allFlags({ uploadFile: false }) }), folder), 403, 'TEMP_SWITCH_OFF');
    expectAllow(decide(Action.Upload, temp({ flags: allFlags({ uploadFile: true, uploadImg: false }) }), folder));
  });

  it('编辑标签需开关命中且是本人本次上传（7.3 第 3 步）', () => {
    const mine = resource({ uploadTempId: 7 });
    const others = resource({ uploadTempId: 8 });
    const byMember = resource({ uploadTempId: null });

    expectAllow(decide(Action.EditTags, temp(), mine));
    expectDeny(decide(Action.EditTags, temp(), others), 403, 'TEMP_NOT_SELF_UPLOAD');
    expectDeny(decide(Action.EditTags, temp(), byMember), 403, 'TEMP_NOT_SELF_UPLOAD');
    expectDeny(
      decide(Action.EditTags, temp({ flags: allFlags({ editTag: false }) }), mine),
      403,
      'TEMP_SWITCH_OFF',
    );
  });

  it('重命名、删除、改权限、建链接结构性禁止，与开关无关', () => {
    const fullyOpen = temp({ flags: allFlags() });
    for (const action of [Action.EditMeta, Action.Delete, Action.ChangeVisibility, Action.CreateShareLink] as Action[]) {
      expectDeny(decide(action, fullyOpen, resource({ uploadTempId: 7 })), 403, 'TEMP_FORBIDDEN');
    }
  });

  it('配额用尽后上传 413，其余操作不受影响；quota=0 表示不限', () => {
    const full = temp({ quotaBytes: 1000, usedBytes: 1000 });
    expectDeny(decide(Action.Upload, full, resource()), 413, 'QUOTA_EXCEEDED');
    expectAllow(decide(Action.Preview, full, resource()));
    expectAllow(decide(Action.Upload, temp({ quotaBytes: 0, usedBytes: 9999 }), resource()));
  });

  it('临时账号访问后台一律被 decideAdmin 拦下', () => {
    for (const action of ADMIN_ACTIONS) {
      const d = decideAdmin(temp(), action);
      expectDeny(d, 403, 'ADMIN_REQUIRED');
    }
  });
});

describe('PRD 7.4 游客', () => {
  it('网盘任何路径 401（含 public 文件夹）', () => {
    const folder = resource({
      type: ResourceType.Folder,
      albumId: undefined,
      folderIdChain: [ROOT_FOLDER],
      visibility: Visibility.Public,
      containerVisibilities: [Visibility.Public],
    });
    expectDeny(decide(Action.Preview, guest, folder), 401, 'LOGIN_REQUIRED');
    expectDeny(decide(Action.DownloadOriginal, guest, folder), 401, 'LOGIN_REQUIRED');
    expectDeny(
      decide(Action.Preview, guest, resource({ type: ResourceType.File, albumId: undefined })),
      401,
      'LOGIN_REQUIRED',
    );
  });

  it('非 public 资源 404', () => {
    for (const visibility of [Visibility.Member, Visibility.Admin, Visibility.Private]) {
      expectDeny(decide(Action.Preview, guest, resource({ visibility })), 404, 'NOT_FOUND');
    }
    expectDeny(
      decide(Action.Preview, guest, resource({ visibility: Visibility.Public, containerVisibilities: [Visibility.Member] })),
      404,
      'NOT_FOUND',
    );
  });

  it('相册放宽为 public、图片仍是 member：游客访问该图依旧 404（15.6）', () => {
    expectDeny(
      decide(
        Action.Preview,
        guest,
        resource({ visibility: Visibility.Member, containerVisibilities: [Visibility.Public] }),
      ),
      404,
      'NOT_FOUND',
    );
  });

  it('公开资源只可预览，下载与任何写操作 403（15.1）', () => {
    const publicImg = resource({ visibility: Visibility.Public, containerVisibilities: [Visibility.Public] });
    expectAllow(decide(Action.Preview, guest, publicImg));
    for (const action of [
      Action.DownloadOriginal,
      Action.ZipDownload,
      Action.Upload,
      Action.EditMeta,
      Action.EditTags,
      Action.ChangeVisibility,
      Action.Delete,
      Action.CreateShareLink,
    ] as Action[]) {
      expectDeny(decide(action, guest, publicImg), 403, 'GUEST_FORBIDDEN');
    }
  });
});

describe('PRD 4.4 分享链接访客', () => {
  it('快照集合外的图片 404，包括同相册其他 coser 的图（15.7）', () => {
    expectAllow(decide(Action.Preview, share(), resource()));
    expectDeny(decide(Action.Preview, share(), resource({ id: IMAGE_ID + 1 })), 404, 'NOT_FOUND');
    expectDeny(decide(Action.Preview, share({ imageIds: [] }), resource()), 404, 'NOT_FOUND');
    expectDeny(
      decide(Action.Preview, share(), resource({ type: ResourceType.Album, albumId: undefined })),
      404,
      'NOT_FOUND',
    );
  });

  it('原图下载由链接自身开关决定（15.8）', () => {
    expectDeny(decide(Action.DownloadOriginal, share(), resource()), 403, 'SHARE_DOWNLOAD_OFF');
    expectDeny(decide(Action.ZipDownload, share(), resource()), 403, 'SHARE_DOWNLOAD_OFF');
    expectAllow(decide(Action.DownloadOriginal, share({ allowDownload: true }), resource()));
    expectAllow(decide(Action.ZipDownload, share({ allowDownload: true }), resource()));
  });

  it('分享访客只读：任何写操作 403', () => {
    for (const action of [
      Action.Upload,
      Action.EditMeta,
      Action.EditTags,
      Action.ChangeVisibility,
      Action.Delete,
      Action.CreateShareLink,
    ] as Action[]) {
      expectDeny(decide(action, share(), resource()), 403, 'SHARE_READONLY');
    }
  });

  it('分享访客不能进后台', () => {
    expectDeny(decideAdmin(share(), AdminAction.ViewLogs), 403, 'ADMIN_REQUIRED');
  });
});

describe('PRD 6.1 后台管理矩阵', () => {
  const EXPECTED_ADMIN_MIN: Record<AdminAction, UserLevel> = {
    [AdminAction.ManageMembers]: UserLevel.Admin,
    [AdminAction.ManageTempAccounts]: UserLevel.Admin,
    [AdminAction.CreateTag]: UserLevel.Member,
    [AdminAction.MergeOrDeleteTag]: UserLevel.Admin,
    [AdminAction.ViewLogs]: UserLevel.Admin,
    [AdminAction.ReadSiteSettings]: UserLevel.Admin,
    [AdminAction.WriteSiteSettings]: UserLevel.SuperAdmin,
    [AdminAction.ReviewMessages]: UserLevel.Admin,
    [AdminAction.ShareLinkManagement]: UserLevel.Member,
    [AdminAction.CrawlerSearch]: UserLevel.SuperAdmin,
    [AdminAction.CrawlerManage]: UserLevel.SuperAdmin,
  };

  it('门槛等级与 PRD 6.1 抄录一致', () => {
    expect(ADMIN_MATRIX).toEqual(EXPECTED_ADMIN_MIN);
  });

  for (const action of ADMIN_ACTIONS) {
    for (const level of LEVELS) {
      const allowed = level >= EXPECTED_ADMIN_MIN[action];
      const label = allowed
        ? `${LEVEL_LABEL[level]} 可执行 ${action}`
        : `${LEVEL_LABEL[level]} 不可执行 ${action}`;
      it(label, () => {
        const d = decideAdmin(member(level), action);
        if (allowed) expectAllow(d);
        else expectDeny(d, 403, 'LEVEL_FORBIDDEN');
      });
    }
  }

  for (const actor of [guest, temp(), share()] as Actor[]) {
    it(`非正式成员（${actor.kind}）不可访问后台`, () => {
      for (const action of ADMIN_ACTIONS) {
        expectDeny(decideAdmin(actor, action), 403, 'ADMIN_REQUIRED');
      }
    });
  }
});

describe('PRD 12.4 / D2 边界规则', () => {
  it('L3 只能管理 L1/L2；L4 不可被任何人操作（含 L4 自己）', () => {
    expect(canManageTargetUser(UserLevel.Admin, UserLevel.Trainee)).toBe(true);
    expect(canManageTargetUser(UserLevel.Admin, UserLevel.Member)).toBe(true);
    expect(canManageTargetUser(UserLevel.Admin, UserLevel.Admin)).toBe(false);
    expect(canManageTargetUser(UserLevel.Admin, UserLevel.SuperAdmin)).toBe(false);
    expect(canManageTargetUser(UserLevel.SuperAdmin, UserLevel.Admin)).toBe(true);
    expect(canManageTargetUser(UserLevel.SuperAdmin, UserLevel.SuperAdmin)).toBe(false);
    expect(canManageTargetUser(UserLevel.Member, UserLevel.Trainee)).toBe(false);
    expect(canManageTargetUser(UserLevel.Trainee, UserLevel.Trainee)).toBe(false);
  });

  it('L1 不能把资源设为公开，其余等级不受此限', () => {
    expect(canSetVisibility(UserLevel.Trainee, Visibility.Public)).toBe(false);
    for (const target of [Visibility.Member, Visibility.Admin, Visibility.Private]) {
      expect(canSetVisibility(UserLevel.Trainee, target)).toBe(true);
    }
    for (const level of [UserLevel.Member, UserLevel.Admin, UserLevel.SuperAdmin]) {
      for (const target of [Visibility.Public, Visibility.Member, Visibility.Admin, Visibility.Private]) {
        expect(canSetVisibility(level, target)).toBe(true);
      }
    }
  });

  it('admin/private 相册禁止生成对外分享链接（D2）', () => {
    expect(canGenerateShareLinkFor(Visibility.Public)).toBe(true);
    expect(canGenerateShareLinkFor(Visibility.Member)).toBe(true);
    expect(canGenerateShareLinkFor(Visibility.Admin)).toBe(false);
    expect(canGenerateShareLinkFor(Visibility.Private)).toBe(false);
  });
});

describe('capabilitiesFor：前端能力位与后端矩阵同源', () => {
  it('逐等级固定期望值，避免矩阵改动悄悄改变前端渲染', () => {
    expect(capabilitiesFor(UserLevel.Trainee)).toEqual({
      download: false,
      zip: false,
      upload: true,
      editOwn: true,
      editAny: false,
      delete: false,
      changeVisibility: true,
      canSetPublic: false,
      shareLink: false,
      adminConsole: false,
      writeSiteSettings: false,
    });
    expect(capabilitiesFor(UserLevel.Member)).toEqual({
      download: true,
      zip: true,
      upload: true,
      editOwn: true,
      editAny: false,
      delete: true,
      changeVisibility: true,
      canSetPublic: true,
      shareLink: true,
      adminConsole: false,
      writeSiteSettings: false,
    });
    expect(capabilitiesFor(UserLevel.Admin)).toEqual({
      download: true,
      zip: true,
      upload: true,
      editOwn: true,
      editAny: true,
      delete: true,
      changeVisibility: true,
      canSetPublic: true,
      shareLink: true,
      adminConsole: true,
      writeSiteSettings: false,
    });
    expect(capabilitiesFor(UserLevel.SuperAdmin)).toEqual({
      download: true,
      zip: true,
      upload: true,
      editOwn: true,
      editAny: true,
      delete: true,
      changeVisibility: true,
      canSetPublic: true,
      shareLink: true,
      adminConsole: true,
      writeSiteSettings: true,
    });
  });

  it('L1 的能力位与 decide() 实际放行结果一致', () => {
    const l1 = member(UserLevel.Trainee, SELF);
    const own = resource({ visibility: Visibility.Member, ownerId: SELF });
    const others = resource({ visibility: Visibility.Member, ownerId: OTHER });

    expect(capabilitiesFor(UserLevel.Trainee).download).toBe(decide(Action.DownloadOriginal, l1, own).allowed);
    expect(capabilitiesFor(UserLevel.Trainee).delete).toBe(decide(Action.Delete, l1, own).allowed);
    expect(capabilitiesFor(UserLevel.Trainee).editAny).toBe(decide(Action.EditTags, l1, others).allowed);
    expect(capabilitiesFor(UserLevel.Trainee).upload).toBe(decide(Action.Upload, l1, others).allowed);
  });
});
