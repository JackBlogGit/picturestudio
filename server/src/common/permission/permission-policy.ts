import { UserLevel } from '../enums/user-level.enum';
import { rank, Visibility } from '../enums/visibility.enum';
import {
  Action,
  AdminAction,
  Actor,
  ActorKind,
  allow,
  Decision,
  deny,
  MemberActor,
  ResourceRef,
  ResourceType,
  Scope,
  ShareActor,
  TempActor,
} from './types';

/** PRD 7.2 —— 可见性闸门的档位上限（private 由「本人」额外放行） */
export const VISIBLE_MAX_RANK: Record<UserLevel, number> = {
  [UserLevel.Trainee]: rank(Visibility.Member),
  [UserLevel.Member]: rank(Visibility.Member),
  [UserLevel.Admin]: rank(Visibility.Admin),
  [UserLevel.SuperAdmin]: rank(Visibility.Private),
};

/** PRD 7.2 —— 资源级操作 × 等级 授权范围 */
export const RESOURCE_MATRIX: Record<Action, Record<UserLevel, Scope>> = {
  [Action.Preview]: {
    [UserLevel.Trainee]: 'any',
    [UserLevel.Member]: 'any',
    [UserLevel.Admin]: 'any',
    [UserLevel.SuperAdmin]: 'any',
  },
  [Action.DownloadOriginal]: {
    [UserLevel.Trainee]: 'none',
    [UserLevel.Member]: 'any',
    [UserLevel.Admin]: 'any',
    [UserLevel.SuperAdmin]: 'any',
  },
  [Action.ZipDownload]: {
    [UserLevel.Trainee]: 'none',
    [UserLevel.Member]: 'any',
    [UserLevel.Admin]: 'any',
    [UserLevel.SuperAdmin]: 'any',
  },
  [Action.Upload]: {
    [UserLevel.Trainee]: 'any',
    [UserLevel.Member]: 'any',
    [UserLevel.Admin]: 'any',
    [UserLevel.SuperAdmin]: 'any',
  },
  [Action.EditMeta]: {
    [UserLevel.Trainee]: 'own',
    [UserLevel.Member]: 'own',
    [UserLevel.Admin]: 'any',
    [UserLevel.SuperAdmin]: 'any',
  },
  [Action.EditTags]: {
    [UserLevel.Trainee]: 'own',
    [UserLevel.Member]: 'own',
    [UserLevel.Admin]: 'any',
    [UserLevel.SuperAdmin]: 'any',
  },
  [Action.ChangeVisibility]: {
    [UserLevel.Trainee]: 'own',
    [UserLevel.Member]: 'own',
    [UserLevel.Admin]: 'any',
    [UserLevel.SuperAdmin]: 'any',
  },
  [Action.Delete]: {
    [UserLevel.Trainee]: 'none',
    [UserLevel.Member]: 'own',
    [UserLevel.Admin]: 'any',
    [UserLevel.SuperAdmin]: 'any',
  },
  [Action.CreateShareLink]: {
    [UserLevel.Trainee]: 'none',
    [UserLevel.Member]: 'own',
    [UserLevel.Admin]: 'any',
    [UserLevel.SuperAdmin]: 'any',
  },
  /**
   * PRD 17.4。这里只登记「按归属能管多宽」：工单不按档位判定，
   * 所以真正放行的是 decideTaskStage，而不是走档位闸门的 decide。
   */
  [Action.TaskStageUpdate]: {
    [UserLevel.Trainee]: 'own',
    [UserLevel.Member]: 'own',
    [UserLevel.Admin]: 'any',
    [UserLevel.SuperAdmin]: 'any',
  },
};

/** 后台管理类操作的最低等级；manage_members 另有等级上下级约束 */
export const ADMIN_MATRIX: Record<AdminAction, UserLevel> = {
  [AdminAction.ManageMembers]: UserLevel.Admin,
  [AdminAction.ManageTempAccounts]: UserLevel.Admin,
  [AdminAction.CreateTag]: UserLevel.Member,
  [AdminAction.MergeOrDeleteTag]: UserLevel.Admin,
  [AdminAction.ViewLogs]: UserLevel.Admin,
  [AdminAction.ReadSiteSettings]: UserLevel.Admin,
  [AdminAction.WriteSiteSettings]: UserLevel.SuperAdmin,
  [AdminAction.ReviewMessages]: UserLevel.Admin,
  [AdminAction.ShareLinkManagement]: UserLevel.Member,
  // D23：爬虫只认 L4，与备份同列，不参与 D20 个人授权与 D21 能力位覆盖
  [AdminAction.CrawlerSearch]: UserLevel.SuperAdmin,
  [AdminAction.CrawlerManage]: UserLevel.SuperAdmin,
};

export function effectiveVisibility(resource: ResourceRef): Visibility {
  let v = resource.visibility;
  for (const parent of resource.containerVisibilities ?? []) {
    if (rank(parent) > rank(v)) v = parent;
  }
  return v;
}

export function isTempActor(actor: Actor): actor is TempActor {
  return actor.kind === ActorKind.Temp;
}

function isMemberActor(actor: Actor): actor is MemberActor {
  return actor.kind === ActorKind.Member;
}

function isShareActor(actor: Actor): actor is ShareActor {
  return actor.kind === ActorKind.ShareVisitor;
}

function withinWhitelist(actor: TempActor, resource: ResourceRef): boolean {
  if (resource.type === ResourceType.Album || resource.type === ResourceType.Image) {
    const target = resource.type === ResourceType.Album ? resource.id : resource.albumId;
    return target !== undefined && actor.albumIds.includes(target);
  }
  const chain = resource.folderIdChain ?? [];
  return chain.some((id) => actor.folderIds.includes(id));
}

function decideMember(
  actor: MemberActor,
  action: Action,
  resource: ResourceRef,
): Decision {
  const visible =
    actor.level === UserLevel.SuperAdmin ||
    rank(effectiveVisibility(resource)) <= VISIBLE_MAX_RANK[actor.level] ||
    (resource.visibility === Visibility.Private && resource.ownerId === actor.uid);

  if (!visible) {
    return deny(404, 'NOT_FOUND', '资源不存在或无权查看');
  }

  const scope = RESOURCE_MATRIX[action][actor.level];
  if (scope === 'none') {
    return deny(403, 'LEVEL_FORBIDDEN', '当前成员等级无权执行该操作');
  }
  if (scope === 'own' && resource.ownerId !== actor.uid) {
    return deny(403, 'NOT_OWNER', '只能操作本人上传的资源');
  }
  return allow();
}

function decideGuest(action: Action, resource: ResourceRef): Decision {
  if (resource.type === ResourceType.Folder || resource.type === ResourceType.File) {
    return deny(401, 'LOGIN_REQUIRED', '网盘资源需登录后访问');
  }
  if (effectiveVisibility(resource) !== Visibility.Public) {
    return deny(404, 'NOT_FOUND', '资源不存在或无权查看');
  }
  if (action !== Action.Preview) {
    return deny(403, 'GUEST_FORBIDDEN', '游客仅可预览，禁止下载与任何写操作');
  }
  return allow();
}

function decideTemp(actor: TempActor, action: Action, resource: ResourceRef): Decision {
  if (actor.disabled || actor.expired) {
    return deny(401, 'TEMP_EXPIRED', '临时账号已失效');
  }
  if (!withinWhitelist(actor, resource)) {
    return deny(404, 'NOT_IN_WHITELIST', '该资源不在临时账号授权范围内');
  }

  const forbidden =
    action === Action.EditMeta ||
    action === Action.Delete ||
    action === Action.ChangeVisibility ||
    action === Action.CreateShareLink;
  if (forbidden) {
    return deny(403, 'TEMP_FORBIDDEN', '临时账号仅可预览、下载、上传与编辑本人上传资源的标签');
  }

  const isDrive = resource.type === ResourceType.Folder || resource.type === ResourceType.File;
  const switchOn = (() => {
    switch (action) {
      case Action.Preview:
        return actor.flags.preview;
      case Action.DownloadOriginal:
      case Action.ZipDownload:
        return actor.flags.download;
      case Action.Upload:
        return isDrive ? actor.flags.uploadFile : actor.flags.uploadImg;
      case Action.EditTags:
        return actor.flags.editTag;
      default:
        return false;
    }
  })();

  if (!switchOn) {
    return deny(403, 'TEMP_SWITCH_OFF', '临时账号未开通该权限开关');
  }
  if (action === Action.EditTags && resource.uploadTempId !== actor.tempId) {
    return deny(403, 'TEMP_NOT_SELF_UPLOAD', '只能编辑本人本次上传资源的标签');
  }
  if (action === Action.Upload && actor.quotaBytes > 0 && actor.usedBytes >= actor.quotaBytes) {
    return deny(413, 'QUOTA_EXCEEDED', '临时账号存储空间已用尽');
  }
  return allow();
}

function decideShare(actor: ShareActor, action: Action, resource: ResourceRef): Decision {
  if (resource.type !== ResourceType.Image || !actor.imageIds.includes(resource.id)) {
    return deny(404, 'NOT_FOUND', '该图片不在分享链接范围内');
  }
  if (action === Action.Preview) {
    return allow();
  }
  if (action === Action.DownloadOriginal || action === Action.ZipDownload) {
    return actor.allowDownload
      ? allow()
      : deny(403, 'SHARE_DOWNLOAD_OFF', '该分享链接未开放原图下载');
  }
  return deny(403, 'SHARE_READONLY', '分享链接仅支持浏览与下载');
}

export function decide(action: Action, actor: Actor, resource: ResourceRef): Decision {
  switch (actor.kind) {
    case ActorKind.Member:
      return decideMember(actor, action, resource);
    case ActorKind.Guest:
      return decideGuest(action, resource);
    case ActorKind.Temp:
      return decideTemp(actor, action, resource);
    case ActorKind.ShareVisitor:
      return decideShare(actor, action, resource);
  }
}

export function decideAdmin(actor: Actor, action: AdminAction): Decision {
  if (actor.kind !== ActorKind.Member) {
    return deny(403, 'ADMIN_REQUIRED', '仅正式成员可访问后台');
  }
  if (actor.level < ADMIN_MATRIX[action]) {
    return deny(403, 'LEVEL_FORBIDDEN', '成员等级不足');
  }
  return allow();
}

/** PRD 3.2 继承上限：子资源档位不得宽于父容器 */
export function checkInheritance(
  child: Visibility,
  parents: Visibility[],
): Decision {
  const tooLoose = parents.find((p) => rank(child) < rank(p));
  if (tooLoose) {
    return deny(409, 'INHERITANCE_VIOLATION', `子资源权限不得宽于上级（上级为 ${tooLoose}）`);
  }
  return allow();
}

/** L1 可建相册但不可设为公开（对外发布需 L2+，见 6.1）；建相册与改可见性两条路径都要过这里 */
export function canSetVisibility(level: UserLevel, target: Visibility): boolean {
  if (level === UserLevel.Trainee) return target !== Visibility.Public;
  return true;
}

export function canGenerateShareLinkFor(albumVisibility: Visibility): boolean {
  return albumVisibility === Visibility.Public || albumVisibility === Visibility.Member;
}

/** 供前端做权限自适应渲染；直接从矩阵推导，避免前端另抄一份规则 */
export interface Capabilities {
  download: boolean;
  zip: boolean;
  upload: boolean;
  editOwn: boolean;
  editAny: boolean;
  delete: boolean;
  changeVisibility: boolean;
  canSetPublic: boolean;
  shareLink: boolean;
  adminConsole: boolean;
  writeSiteSettings: boolean;
}

export function capabilitiesFor(level: UserLevel): Capabilities {
  const scope = (action: Action) => RESOURCE_MATRIX[action][level];
  return {
    download: scope(Action.DownloadOriginal) !== 'none',
    zip: scope(Action.ZipDownload) !== 'none',
    upload: scope(Action.Upload) !== 'none',
    editOwn: scope(Action.EditMeta) !== 'none',
    editAny: scope(Action.EditMeta) === 'any',
    delete: scope(Action.Delete) !== 'none',
    changeVisibility: scope(Action.ChangeVisibility) !== 'none',
    canSetPublic: canSetVisibility(level, Visibility.Public),
    shareLink: scope(Action.CreateShareLink) !== 'none',
    adminConsole: level >= UserLevel.Admin,
    writeSiteSettings: level >= UserLevel.SuperAdmin,
  };
}

/** manage_members 的上下级约束：L3 只能操作 L1/L2，L4 不可被任何人操作（含 L4） */
export function canManageTargetUser(actorLevel: UserLevel, targetLevel: UserLevel): boolean {
  if (targetLevel === UserLevel.SuperAdmin) return false;
  if (actorLevel === UserLevel.SuperAdmin) return true;
  if (actorLevel === UserLevel.Admin) {
    return targetLevel === UserLevel.Trainee || targetLevel === UserLevel.Member;
  }
  return false;
}
