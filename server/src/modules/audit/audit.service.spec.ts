import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AuditLog, LogTargetType } from '../../entities';
import { Actor, ActorKind, ResourceType } from '../../common/permission/types';
import { RequestContext } from './audit.service';
import { AuditService } from './audit.service';

const CTX: RequestContext = { ip: '203.0.113.20', ua: 'Mozilla/5.0' };

const member: Actor = { kind: ActorKind.Member, uid: 100, level: 2 };
const temp: Actor = {
  kind: ActorKind.Temp,
  tempId: 7,
  ownerUid: 3,
  expired: false,
  disabled: false,
  flags: { preview: true, download: false, uploadImg: false, uploadFile: false, editTag: false },
  quotaBytes: 0,
  usedBytes: 0,
  albumIds: [],
  folderIds: [],
};

function build(insertError?: Error) {
  const repo = {
    create: jest.fn((dto: Partial<AuditLog>) => dto),
    insert: jest.fn(async () => {
      if (insertError) throw insertError;
    }),
  } as unknown as Repository<AuditLog>;
  return { repo, service: new AuditService(repo) };
}

function createdRow(t: { repo: unknown; service: AuditService }): Partial<AuditLog> {
  const create = (t.repo as { create: jest.Mock }).create;
  return create.mock.calls[0][0] as Partial<AuditLog>;
}

describe('AuditService', () => {
  it('正式成员操作记 userType=user 与 uid，默认 result=1', async () => {
    const t = build();
    await t.service.record(member, CTX, { action: 'login', targetType: LogTargetType.User, targetId: 100 });

    const row = createdRow(t);
    expect(row).toMatchObject({
      userType: 'user',
      uid: 100,
      tempId: null,
      action: 'login',
      ip: CTX.ip,
      ua: CTX.ua,
      result: 1,
    });
    expect((t.repo as unknown as { insert: jest.Mock }).insert).toHaveBeenCalledTimes(1);
  });

  it('临时账号只填 tempId，游客两者皆空，无身份时为 system', async () => {
    const t1 = build();
    await t1.service.record(temp, CTX, { action: 'upload' });
    expect(createdRow(t1)).toMatchObject({ userType: 'temp', uid: null, tempId: 7 });

    const t2 = build();
    await t2.service.record({ kind: ActorKind.Guest }, CTX, { action: 'download_denied' });
    expect(createdRow(t2)).toMatchObject({ userType: 'guest', uid: null, tempId: null });

    const t3 = build();
    await t3.service.record(undefined, CTX, { action: 'cron_cleanup' });
    expect(createdRow(t3)).toMatchObject({ userType: 'system' });
  });

  it('detail 截到 500、ua 截到 255，与 logs 列宽一致', async () => {
    const t = build();
    const long = 'x'.repeat(900);
    await t.service.record(member, { ip: CTX.ip, ua: long }, { action: 'login', detail: long });

    const row = createdRow(t);
    expect(row.detail).toHaveLength(500);
    expect(row.ua).toHaveLength(255);
  });

  it('targetType 同时接受后台枚举与资源类型字符串', async () => {
    const resourceSide = build();
    await resourceSide.service.record(member, CTX, {
      action: 'delete_denied',
      targetType: ResourceType.Image,
      targetId: 500,
    });
    expect(createdRow(resourceSide)).toMatchObject({ targetType: 'image', targetId: 500 });

    const siteSide = build();
    await siteSide.service.record(member, CTX, { action: 'write_site_settings', targetType: LogTargetType.Site });
    expect(createdRow(siteSide)).toMatchObject({ targetType: 'site' });
  });

  it('未提供 targetType/targetId 时落 NULL，不写 undefined', async () => {
    const t = build();
    await t.service.record(member, CTX, { action: 'login' });
    const row = createdRow(t);
    expect(row.targetType).toBeNull();
    expect(row.targetId).toBeNull();
    expect(row.detail).toBe('');
  });

  it('越权拦截必须原样保留 result=0，供审计页筛出攻击尝试', async () => {
    const t = build();
    await t.service.record(temp, CTX, { action: 'delete_denied', result: 0, detail: 'TEMP_FORBIDDEN' });
    expect(createdRow(t).result).toBe(0);
  });

  it('审计写库失败只记错误日志，绝不把异常抛给业务请求', async () => {
    const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const t = build(new Error('logs 表不存在'));

    await expect(t.service.record(member, CTX, { action: 'login' })).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('action=login'), expect.any(Error));
    spy.mockRestore();
  });
});
