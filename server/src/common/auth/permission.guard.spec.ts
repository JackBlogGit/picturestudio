import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditService } from '../../modules/audit/audit.service';
import { UserLevel } from '../enums/user-level.enum';
import { Visibility } from '../enums/visibility.enum';
import { AppError } from '../http/app-error';
import { ResourceLoader } from '../permission/resource-loader';
import {
  Actor,
  ActorKind,
  AdminAction,
  Action,
  MemberActor,
  ResourceRef,
  ResourceType,
} from '../permission/types';
import { ActorRequest } from './actor.guard';
import { ADMIN_ACTION_KEY, PermissionRequirement, PERMISSION_KEY } from './auth-metadata';
import { AdminGuard, PermissionGuard } from './permission.guard';

const SELF = 100;
const OTHER = 200;
const IMAGE_ID = 500;

function image(over: Partial<ResourceRef> = {}): ResourceRef {
  return {
    type: ResourceType.Image,
    id: IMAGE_ID,
    visibility: Visibility.Member,
    ownerId: OTHER,
    albumId: 10,
    containerVisibilities: [Visibility.Member],
    ...over,
  };
}

function member(level: UserLevel, uid = SELF): MemberActor {
  return { kind: ActorKind.Member, uid, level };
}

interface Setup {
  requirement?: PermissionRequirement;
  adminAction?: AdminAction;
  resource?: ResourceRef | null;
  actor: Actor;
  params?: Record<string, string>;
}

function build({ requirement, adminAction, resource = null, actor, params = {} }: Setup) {
  const meta = new Map<string, unknown>();
  if (requirement) meta.set(PERMISSION_KEY, requirement);
  if (adminAction) meta.set(ADMIN_ACTION_KEY, adminAction);

  const reflector = { get: (key: string) => meta.get(key) } as unknown as Reflector;
  const loader = { load: jest.fn(async () => resource) } as unknown as ResourceLoader;
  const audit = { record: jest.fn(async () => undefined) } as unknown as AuditService;
  const req = { actor, auditCtx: { ip: '198.51.100.4', ua: 'jest' }, params } as unknown as ActorRequest;
  const ctx = {
    getHandler: () => undefined,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;

  return {
    ctx,
    req,
    audit,
    loader,
    permission: new PermissionGuard(reflector, loader, audit),
    admin: new AdminGuard(reflector, audit),
  };
}

async function failure(promise: Promise<boolean>): Promise<AppError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

const downloadRequirement: PermissionRequirement = {
  action: Action.DownloadOriginal,
  resourceType: ResourceType.Image,
  param: 'id',
};

describe('PermissionGuard', () => {
  it('未标注 @RequirePermission 的接口直接放行，且不产生查库', async () => {
    const t = build({ actor: member(UserLevel.Trainee) });
    await expect(t.permission.canActivate(t.ctx)).resolves.toBe(true);
    expect(t.loader.load).not.toHaveBeenCalled();
  });

  const badParams: Record<string, string>[] = [{}, { id: 'abc' }, { id: '0' }, { id: '-3' }, { id: '1.5' }];
  for (const params of badParams) {
    it(`路由参数 ${JSON.stringify(params)} 不是合法主键 → 404 且不查库`, async () => {
      const t = build({ requirement: downloadRequirement, actor: member(UserLevel.SuperAdmin), params });
      const err = await failure(t.permission.canActivate(t.ctx));
      expect(err.getStatus()).toBe(404);
      expect(err.code).toBe('NOT_FOUND');
      expect(t.loader.load).not.toHaveBeenCalled();
    });
  }

  it('资源不存在 → 404，与无权访问同码，不泄露存在性', async () => {
    const t = build({ requirement: downloadRequirement, actor: member(UserLevel.SuperAdmin), params: { id: '500' }, resource: null });
    expect((await failure(t.permission.canActivate(t.ctx))).getStatus()).toBe(404);
  });

  it('按声明的 resourceType 与路由参数取资源', async () => {
    const t = build({
      requirement: { action: Action.Preview, resourceType: ResourceType.Folder, param: 'folderId' },
      actor: member(UserLevel.SuperAdmin),
      params: { folderId: '12' },
      resource: image({ type: ResourceType.Folder, id: 12, albumId: undefined, folderIdChain: [1, 12] }),
    });
    await expect(t.permission.canActivate(t.ctx)).resolves.toBe(true);
    expect(t.loader.load).toHaveBeenCalledWith(ResourceType.Folder, 12);
  });

  it('L1 下载原图 → 403，并落一条 result=0 的越权审计（PRD 15.2）', async () => {
    const t = build({ requirement: downloadRequirement, actor: member(UserLevel.Trainee), params: { id: '500' }, resource: image() });
    const err = await failure(t.permission.canActivate(t.ctx));
    expect(err.getStatus()).toBe(403);
    expect(err.code).toBe('LEVEL_FORBIDDEN');
    expect(t.audit.record).toHaveBeenCalledWith(
      { kind: ActorKind.Member, uid: SELF, level: UserLevel.Trainee },
      { ip: '198.51.100.4', ua: 'jest' },
      {
        action: 'download_original_denied',
        targetType: ResourceType.Image,
        targetId: IMAGE_ID,
        detail: 'LEVEL_FORBIDDEN',
        result: 0,
      },
    );
  });

  it('L3 访问他人 private 图片 → 404（PRD 15.4，D1）', async () => {
    const t = build({
      requirement: { action: Action.Preview, resourceType: ResourceType.Image, param: 'id' },
      actor: member(UserLevel.Admin),
      params: { id: '500' },
      resource: image({ visibility: Visibility.Private, ownerId: OTHER, containerVisibilities: [Visibility.Private] }),
    });
    const err = await failure(t.permission.canActivate(t.ctx));
    expect(err.getStatus()).toBe(404);
    expect(t.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ detail: 'NOT_FOUND', result: 0 }),
    );
  });

  it('L4 同一资源 → 放行', async () => {
    const t = build({
      requirement: { action: Action.Delete, resourceType: ResourceType.Image, param: 'id' },
      actor: member(UserLevel.SuperAdmin),
      params: { id: '500' },
      resource: image({ visibility: Visibility.Private, ownerId: OTHER }),
    });
    await expect(t.permission.canActivate(t.ctx)).resolves.toBe(true);
    expect(t.audit.record).not.toHaveBeenCalled();
  });

  it('L2 改他人图片 → 403 NOT_OWNER；改自己的 → 放行（PRD 15.3）', async () => {
    const requirement: PermissionRequirement = { action: Action.EditTags, resourceType: ResourceType.Image, param: 'id' };
    const others = build({ requirement, actor: member(UserLevel.Member), params: { id: '500' }, resource: image({ ownerId: OTHER }) });
    expect((await failure(others.permission.canActivate(others.ctx))).code).toBe('NOT_OWNER');

    const mine = build({ requirement, actor: member(UserLevel.Member), params: { id: '500' }, resource: image({ ownerId: SELF }) });
    await expect(mine.permission.canActivate(mine.ctx)).resolves.toBe(true);
  });

  it('游客请求网盘资源 → 401，请求公开图下载 → 403（PRD 15.1）', async () => {
    const drive = build({
      requirement: { action: Action.Preview, resourceType: ResourceType.Folder, param: 'id' },
      actor: { kind: ActorKind.Guest },
      params: { id: '1' },
      resource: image({ type: ResourceType.Folder, visibility: Visibility.Public, containerVisibilities: [] }),
    });
    expect((await failure(drive.permission.canActivate(drive.ctx))).getStatus()).toBe(401);

    const original = build({
      requirement: downloadRequirement,
      actor: { kind: ActorKind.Guest },
      params: { id: '500' },
      resource: image({ visibility: Visibility.Public, containerVisibilities: [Visibility.Public] }),
    });
    expect((await failure(original.permission.canActivate(original.ctx))).getStatus()).toBe(403);
  });

  it('临时账号越权：结构性禁止的操作即使开关全开也 403', async () => {
    const t = build({
      requirement: { action: Action.Delete, resourceType: ResourceType.Image, param: 'id' },
      actor: {
        kind: ActorKind.Temp,
        tempId: 7,
        ownerUid: 3,
        expired: false,
        disabled: false,
        flags: { preview: true, download: true, uploadImg: true, uploadFile: true, editTag: true },
        quotaBytes: 0,
        usedBytes: 0,
        albumIds: [10],
        folderIds: [],
      },
      params: { id: '500' },
      resource: image({ uploadTempId: 7 }),
    });
    const err = await failure(t.permission.canActivate(t.ctx));
    expect(err.getStatus()).toBe(403);
    expect(err.code).toBe('TEMP_FORBIDDEN');
  });
});

describe('AdminGuard', () => {
  it('未标注 @RequireAdmin 的接口放行', async () => {
    const t = build({ actor: member(UserLevel.Trainee) });
    await expect(t.admin.canActivate(t.ctx)).resolves.toBe(true);
  });

  it('L2 写站点配置 → 403 并留审计（PRD 6.1 站点核心配置仅 L4）', async () => {
    const t = build({ adminAction: AdminAction.WriteSiteSettings, actor: member(UserLevel.Member) });
    const err = await failure(t.admin.canActivate(t.ctx));
    expect(err.getStatus()).toBe(403);
    expect(err.code).toBe('LEVEL_FORBIDDEN');
    expect(t.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: 'write_site_settings_denied', result: 0 }),
    );
  });

  it('L4 写站点配置 → 放行；L3 只读可过、写入不可过', async () => {
    const read = build({ adminAction: AdminAction.ReadSiteSettings, actor: member(UserLevel.Admin) });
    await expect(read.admin.canActivate(read.ctx)).resolves.toBe(true);

    const write = build({ adminAction: AdminAction.WriteSiteSettings, actor: member(UserLevel.SuperAdmin) });
    await expect(write.admin.canActivate(write.ctx)).resolves.toBe(true);
  });

  for (const actor of [
    { kind: ActorKind.Guest } as Actor,
    {
      kind: ActorKind.Temp,
      tempId: 7,
      ownerUid: 3,
      expired: false,
      disabled: false,
      flags: { preview: true, download: true, uploadImg: true, uploadFile: true, editTag: true },
      quotaBytes: 0,
      usedBytes: 0,
      albumIds: [],
      folderIds: [],
    } as Actor,
  ]) {
    it(`${actor.kind} 访问后台 → 403 ADMIN_REQUIRED`, async () => {
      const t = build({ adminAction: AdminAction.ManageMembers, actor });
      expect((await failure(t.admin.canActivate(t.ctx))).code).toBe('ADMIN_REQUIRED');
    });
  }

  it('分享链接访客也不能访问后台', async () => {
    const t = build({
      adminAction: AdminAction.ViewLogs,
      actor: { kind: ActorKind.ShareVisitor, linkId: 3, imageIds: [IMAGE_ID], allowDownload: false },
    });
    expect((await failure(t.admin.canActivate(t.ctx))).code).toBe('ADMIN_REQUIRED');
  });
});
