import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { In, Repository } from 'typeorm';
import { UserLevel } from '../../common/enums/user-level.enum';
import { clampPaging, Page, pagedList } from '../../common/http/pagination';
import { AppError } from '../../common/http/app-error';
import { requireMember } from '../../common/permission/actor-guards';
import { Actor, ActorKind, MemberActor } from '../../common/permission/types';
import { uniqueAccountNo } from '../../common/temp-account/account-no';
import { maskPhone } from '../../common/temp-account/phone-mask';
import { LIKE_ESCAPE_SQL, likePrefixPattern } from '../../common/sql/like';
import {
  Album,
  File,
  Folder,
  LogTargetType,
  TempAccount,
  TempAccountAlbum,
  TempAccountFolder,
  User,
} from '../../entities';
import { AuditService, RequestContext } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { SettingsService } from '../settings/settings.service';
import {
  CreateTempAccountDto,
  ListTempAccountDto,
  MAX_PRE_REFS,
  TEMP_FLAG_FIELDS,
  TempFlagField,
} from './dto/temp-account.dto';

const DAY_MS = 86_400_000;
/** PRD 6.2：L3/L4 上限 30 天；L1/L2 上限来自站点配置 temp.max_days_for_l1_l2 */
export const MAX_DAYS_FOR_ADMIN = 30;
export const DEFAULT_QUOTA_KEY = 'temp.default_quota';
export const MAX_DAYS_FOR_L1_L2_KEY = 'temp.max_days_for_l1_l2';
/** 帐户ID 由数据库 UNIQUE 兜底，撞库即换一个再来，最多 5 次（用例 22） */
const ACCOUNT_NO_ATTEMPTS = 5;

export type TempFlagSet = Record<TempFlagField, number>;

export interface TempAccountView {
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
  flags: TempFlagSet;
  hasLink: boolean;
  spaceQuota: number;
  usedSpace: number;
  albumIds: number[];
  folderIds: number[];
  preStage: number;
  postStage: number;
  preDoneTime: Date | null;
  postDoneTime: Date | null;
  createTime: Date;
}

/** 创建响应额外带一次性凭据，之后任何接口都不再返回（PRD 6.2「复制帐号信息」） */
export interface CreateTempAccountResult extends TempAccountView {
  password?: string;
  accessToken?: string;
  /** 被后端覆盖的项；不回显的话前端会以为 30 天 + 下载权限真的生效了（用例 21） */
  overridden: string[];
}

/** 表单元数据：天数档位与上限由后端下发，前端不硬编码（图 3 的「账号时长」下拉） */
export interface TempAccountSchema {
  canManage: boolean;
  daysOptions: number[];
  maxDays: number;
  defaultQuota: number;
  maxPreRefs: number;
  flags: TempFlagField[];
}

interface Limits {
  defaultQuota: number;
  maxDays: number;
}

function isDuplicateKey(err: unknown): boolean {
  const e = err as { code?: string; errno?: number };
  return e?.code === 'ER_DUP_ENTRY' || Number(e?.errno) === 1062;
}

/** L1/L2 只允许开预览（D9；D27 起上传开关已作废，低等级可授予的就只剩这一位） */
function grantableForLowLevel(field: TempFlagField): boolean {
  return field === 'allowPreview';
}

/**
 * D9 强制降权：L1/L2 无论传什么都按 6.2 的表覆盖，并记录覆盖了哪几项。
 * 纯函数、不碰仓储，逐项断言即是 PRD 15 章用例 21。
 */
export function applyCreateLimits(
  level: UserLevel,
  asked: Partial<TempFlagSet> & { spaceQuota?: number },
  caps: { maxDaysForL1L2: number; defaultQuota: number },
): { flags: TempFlagSet; spaceQuota: number; maxDays: number; overridden: string[] } {
  const downscope = level <= UserLevel.Member;
  const maxDays = downscope ? caps.maxDaysForL1L2 : MAX_DAYS_FOR_ADMIN;
  const overridden: string[] = [];
  const flags = {} as TempFlagSet;

  for (const field of TEMP_FLAG_FIELDS) {
    const value = asked[field];
    if (downscope && !grantableForLowLevel(field)) {
      flags[field] = 0;
      if (value === 1) overridden.push(field);
      continue;
    }
    /** 未传时：L1/L2 默认开预览，L3/L4 默认全关 */
    flags[field] = value === undefined ? (downscope ? 1 : 0) : value;
  }

  let spaceQuota = caps.defaultQuota;
  if (!downscope && asked.spaceQuota !== undefined) spaceQuota = asked.spaceQuota;
  if (downscope && asked.spaceQuota !== undefined && asked.spaceQuota !== caps.defaultQuota) {
    overridden.push('spaceQuota');
  }
  return { flags, spaceQuota, maxDays, overridden };
}

@Injectable()
export class TempAccountService {
  constructor(
    @InjectRepository(TempAccount) private readonly temps: Repository<TempAccount>,
    @InjectRepository(TempAccountAlbum) private readonly albumGrants: Repository<TempAccountAlbum>,
    @InjectRepository(TempAccountFolder) private readonly folderGrants: Repository<TempAccountFolder>,
    @InjectRepository(Album) private readonly albums: Repository<Album>,
    @InjectRepository(Folder) private readonly folders: Repository<Folder>,
    @InjectRepository(File) private readonly files: Repository<File>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly settings: SettingsService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  schema(actor: Actor): TempAccountSchema {
    if (actor.kind !== ActorKind.Member) {
      throw new AppError(HttpStatus.FORBIDDEN, 'MEMBER_ONLY', '仅正式成员可创建临时账号');
    }
    const caps = this.readLimits(actor.level);
    const days = [1, 3, 7, 15, 30].filter((d) => d <= caps.maxDays);
    if (!days.includes(caps.maxDays)) days.push(caps.maxDays);
    return {
      canManage: actor.level >= UserLevel.Admin,
      daysOptions: days.sort((a, b) => a - b),
      maxDays: caps.maxDays,
      defaultQuota: caps.defaultQuota,
      maxPreRefs: MAX_PRE_REFS,
      flags: [...TEMP_FLAG_FIELDS],
    };
  }

  /** 候选帐户ID：不落库，点「换一下」就是再取一个（PRD 6.2 表单对照） */
  async nextAccountNo(actor: Actor): Promise<{ accountNo: string }> {
    requireMember(actor, '创建临时账号');
    const taken = new Set<string>();
    for (let i = 0; i < ACCOUNT_NO_ATTEMPTS; i += 1) {
      const candidate = uniqueAccountNo(taken);
      const clash = await this.temps.findOne({ where: { accountNo: candidate }, select: { id: true } });
      if (!clash) return { accountNo: candidate };
      taken.add(candidate);
    }
    throw this.accountNoExhausted();
  }

  async create(
    dto: CreateTempAccountDto,
    actor: Actor,
    ctx: RequestContext,
  ): Promise<CreateTempAccountResult> {
    const member = requireMember(actor, '创建临时账号');
    const caps = this.readLimits(member.level);

    if (!dto.password && !dto.wantLink) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'ACCESS_METHOD_REQUIRED',
        '至少配置一种访问方式：设置密码或生成一次性专属链接',
      );
    }

    const limited = applyCreateLimits(member.level, dto, {
      maxDaysForL1L2: this.settings.getNumber(MAX_DAYS_FOR_L1_L2_KEY, 7),
      defaultQuota: this.settings.getNumber(DEFAULT_QUOTA_KEY, 10 * 1024 ** 3),
    });
    const expire = this.resolveExpire(dto, limited.maxDays);
    if (expire.expireTime.getTime() <= Date.now()) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'EXPIRE_IN_PAST', '截止时间必须晚于当前时间');
    }
    if (expire.truncated) limited.overridden.push('expireTime');

    /** 白名单：L1/L2 只保留自己名下的相册与文件夹，越界的静默丢弃并记入 overridden */
    const albumIds = await this.filterAlbums(dto.albumIds ?? [], member);
    const folderIds = await this.filterFolders(dto.folderIds ?? [], member);
    if (dto.albumIds?.some((id) => !albumIds.includes(id))) limited.overridden.push('albumIds');
    if (dto.folderIds?.some((id) => !folderIds.includes(id))) limited.overridden.push('folderIds');

    const row = await this.insertWithUniqueAccountNo({
      displayName: dto.displayName.trim(),
      loginName: dto.loginName?.trim() || null,
      password: dto.password ? await this.auth.hashPassword(dto.password) : null,
      accessToken: dto.wantLink ? randomBytes(16).toString('hex') : null,
      phone: dto.phone ?? null,
      shootingNote: dto.shootingNote?.trim() ?? '',
      expireTime: expire.expireTime,
      ...limited.flags,
      spaceQuota: String(limited.spaceQuota),
      usedSpace: '0',
      disabled: 0,
      ownerUid: member.uid,
      preStage: 0,
      postStage: 0,
      preDoneTime: null,
      postDoneTime: null,
    });

    if (albumIds.length) {
      await this.albumGrants.insert(albumIds.map((albumId) => ({ tempId: row.id, albumId })));
    }
    if (folderIds.length) {
      await this.folderGrants.insert(folderIds.map((folderId) => ({ tempId: row.id, folderId })));
    }
    const attached = await this.attachPreRefs(dto.preRefs ?? [], row.id, member.uid);
    if (attached < (dto.preRefs ?? []).length) limited.overridden.push('preRefs');

    await this.audit.record(actor, ctx, {
      action: 'temp_account_create',
      targetType: LogTargetType.Temp,
      targetId: row.id,
      /** 只记帐户ID 与被覆盖项：手机号、密码、专属链接 token 一律不进 logs（12 章） */
      detail: `account_no=${row.accountNo}${
        limited.overridden.length ? `, overridden=${limited.overridden.join(',')}` : ''
      }`,
    });

    const view = await this.toView(row, actor, albumIds, folderIds);
    return {
      ...view,
      ...(dto.password ? { password: dto.password } : {}),
      ...(row.accessToken ? { accessToken: row.accessToken } : {}),
      overridden: limited.overridden,
    };
  }

  async list(actor: Actor, query: ListTempAccountDto): Promise<Page<TempAccountView>> {
    const member = requireMember(actor, '查看临时账号列表');
    const { skip, take, page, pageSize } = clampPaging(query);

    const qb = this.temps.createQueryBuilder('t');
    /** L1/L2 只见自己创建的（D9 的另一半），L3/L4 全站 */
    if (member.level <= UserLevel.Member) {
      qb.where('t.ownerUid = :uid', { uid: member.uid });
    }
    if (query.disabled !== undefined) qb.andWhere('t.disabled = :disabled', { disabled: query.disabled });

    const kw = query.q?.trim();
    if (kw) {
      qb.andWhere(
        `(t.accountNo LIKE :kw ${LIKE_ESCAPE_SQL} OR t.loginName LIKE :kw ${LIKE_ESCAPE_SQL} OR t.displayName LIKE :kw ${LIKE_ESCAPE_SQL})`,
        { kw: likePrefixPattern(kw) },
      );
    }

    const [rows, total] = await qb
      .orderBy('t.createTime', 'DESC')
      .addOrderBy('t.id', 'DESC')
      .skip(skip)
      .take(take)
      .getManyAndCount();

    const grants = await this.grantsOf(rows.map((r) => r.id));
    const owners = await this.ownersOf(rows);
    return pagedList(
      rows.map((r) =>
        this.toView(r, actor, grants.albums.get(r.id) ?? [], grants.folders.get(r.id) ?? [], owners),
      ),
      total,
      page,
      pageSize,
    );
  }

  private readLimits(level: UserLevel): Limits {
    const defaultQuota = this.settings.getNumber(DEFAULT_QUOTA_KEY, 10 * 1024 ** 3);
    const forLowLevel = Math.min(this.settings.getNumber(MAX_DAYS_FOR_L1_L2_KEY, 7), MAX_DAYS_FOR_ADMIN);
    return {
      defaultQuota,
      maxDays: level <= UserLevel.Member ? forLowLevel : MAX_DAYS_FOR_ADMIN,
    };
  }

  /** 天 / 自定义起止统一折算成绝对时刻；L1/L2 超出上限即截断而不是报错（6.2） */
  private resolveExpire(dto: CreateTempAccountDto, maxDays: number): { expireTime: Date; truncated: boolean } {
    const ceiling = new Date(Date.now() + maxDays * DAY_MS);
    if (dto.validUntil) {
      const asked = new Date(dto.validUntil);
      return asked > ceiling ? { expireTime: ceiling, truncated: true } : { expireTime: asked, truncated: false };
    }
    const days = dto.days ?? maxDays;
    return { expireTime: new Date(Date.now() + Math.min(days, maxDays) * DAY_MS), truncated: days > maxDays };
  }

  private async filterAlbums(ids: number[], member: MemberActor): Promise<number[]> {
    if (!ids.length) return [];
    const rows = await this.albums.find({ where: { id: In(ids) }, select: { id: true, createUid: true } });
    return rows
      .filter((a) => member.level > UserLevel.Member || a.createUid === member.uid)
      .map((a) => a.id);
  }

  private async filterFolders(ids: number[], member: MemberActor): Promise<number[]> {
    if (!ids.length) return [];
    const rows = await this.folders.find({ where: { id: In(ids) }, select: { id: true, createUid: true } });
    return rows
      .filter((f) => member.level > UserLevel.Member || f.createUid === member.uid)
      .map((f) => f.id);
  }

  /** 参考图只能挂自己的文件：否则任何人报一个 file_id 就能把别人的文件划进自己工单 */
  private async attachPreRefs(ids: number[], tempId: number, uid: number): Promise<number> {
    if (!ids.length) return 0;
    const rows = await this.files.find({
      where: { id: In(ids), uploadUid: uid },
      select: { id: true },
    });
    if (!rows.length) return 0;
    await this.files.update({ id: In(rows.map((r) => r.id)) }, { tempAccountId: tempId, refStage: 'pre' });
    return rows.length;
  }

  private async insertWithUniqueAccountNo(input: Partial<TempAccount>): Promise<TempAccount> {
    const taken = new Set<string>();
    for (let i = 0; i < ACCOUNT_NO_ATTEMPTS; i += 1) {
      const accountNo = uniqueAccountNo(taken);
      try {
        return await this.temps.save(this.temps.create({ ...input, accountNo }));
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        taken.add(accountNo);
      }
    }
    throw this.accountNoExhausted();
  }

  private accountNoExhausted(): AppError {
    return new AppError(
      HttpStatus.INTERNAL_SERVER_ERROR,
      'ACCOUNT_NO_EXHAUSTED',
      '帐户ID 连续碰撞，请稍后重试',
    );
  }

  private async grantsOf(tempIds: number[]): Promise<{ albums: Map<number, number[]>; folders: Map<number, number[]> }> {
    const albums = new Map<number, number[]>();
    const folders = new Map<number, number[]>();
    if (!tempIds.length) return { albums, folders };

    for (const r of await this.albumGrants.find({ where: { tempId: In(tempIds) } })) {
      albums.set(r.tempId, [...(albums.get(r.tempId) ?? []), r.albumId]);
    }
    for (const r of await this.folderGrants.find({ where: { tempId: In(tempIds) } })) {
      folders.set(r.tempId, [...(folders.get(r.tempId) ?? []), r.folderId]);
    }
    return { albums, folders };
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

  private toView(
    row: TempAccount,
    actor: Actor,
    albumIds: number[],
    folderIds: number[],
    owners = new Map<number, string>(),
  ): TempAccountView {
    return {
      tempId: row.id,
      accountNo: row.accountNo,
      loginName: row.loginName,
      displayName: row.displayName,
      /** 完整号码只对创建人与 L3/L4 放行，其余身份与一切响应都脱敏 */
      phone: this.showPhone(actor, row.ownerUid) ? row.phone : maskPhone(row.phone),
      shootingNote: row.shootingNote,
      ownerUid: row.ownerUid,
      ownerName: owners.get(row.ownerUid) ?? `#${row.ownerUid}`,
      expireTime: row.expireTime,
      disabled: row.disabled,
      flags: {
        allowPreview: row.allowPreview,
        allowDownload: row.allowDownload,
        allowEditTag: row.allowEditTag,
      },
      hasLink: Boolean(row.accessToken),
      spaceQuota: Number(row.spaceQuota),
      usedSpace: Number(row.usedSpace),
      albumIds,
      folderIds,
      preStage: row.preStage,
      postStage: row.postStage,
      preDoneTime: row.preDoneTime,
      postDoneTime: row.postDoneTime,
      createTime: row.createTime,
    };
  }

  private showPhone(actor: Actor, ownerUid: number): boolean {
    if (actor.kind !== ActorKind.Member) return false;
    return actor.uid === ownerUid || actor.level >= UserLevel.Admin;
  }
}
