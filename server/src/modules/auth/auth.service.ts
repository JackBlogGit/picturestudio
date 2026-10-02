import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { LogTargetType, TempAccount, User } from '../../entities';
import { LEVEL_LABEL, UserLevel } from '../../common/enums/user-level.enum';
import { capabilitiesFor } from '../../common/permission/permission-policy';
import { AppError } from '../../common/http/app-error';
import { TokenService } from '../../common/auth/token.service';
import { Actor, ActorKind } from '../../common/permission/types';
import { AuditService, RequestContext } from '../audit/audit.service';

export interface LoginResult {
  accessToken: string;
  identity:
    | { kind: 'user'; uid: number; username: string; nickname: string; level: UserLevel }
    | { kind: 'temp'; tempId: number; displayName: string; expiresAt: Date };
}

const BCRYPT_COST = 12;

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(TempAccount) private readonly temps: Repository<TempAccount>,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, BCRYPT_COST);
  }

  /**
   * 统一登录入口：先按正式成员账号查，未命中再按临时账号的 login_name 或帐户ID 查（PRD 6.2）。
   * 两类命名空间不共享唯一约束，若同名则以正式成员优先——创建临时账号时需避开正式账号名。
   * 无论「查无此人」还是「密码错」都回同一个 401，避免拿登录口枚举帐户ID。
   */
  async login(username: string, password: string, ctx: RequestContext): Promise<LoginResult> {
    const user = await this.users
      .createQueryBuilder('u')
      .addSelect('u.password')
      .where('u.username = :username', { username })
      .getOne();

    if (user) {
      return this.loginAsMember(user, password, ctx);
    }

    const temp = await this.temps
      .createQueryBuilder('t')
      .addSelect('t.password')
      .where('t.loginName = :name OR t.accountNo = :name', { name: username })
      .getOne();
    if (!temp) {
      await this.denied(ctx, 'login_failed', 'unknown_account');
      throw new AppError(401, 'BAD_CREDENTIALS', '账号或密码错误');
    }
    return this.loginAsTemp(temp, password, ctx);
  }

  /** 一次性专属访问链接：凭 access_token 换临时会话，无密码则直接放行 */
  async loginByAccessToken(
    accessToken: string,
    password: string | undefined,
    ctx: RequestContext,
  ): Promise<LoginResult> {
    const temp = await this.temps
      .createQueryBuilder('t')
      .addSelect('t.password')
      .where('t.access_token = :token', { token: accessToken })
      .getOne();
    if (!temp) {
      await this.denied(ctx, 'temp_link_access_failed', 'unknown_token');
      throw new AppError(404, 'NOT_FOUND', '链接无效');
    }
    if (temp.password && (!password || !(await bcrypt.compare(password, temp.password)))) {
      await this.denied(ctx, 'temp_link_access_failed', 'bad_password');
      throw new AppError(401, 'BAD_CREDENTIALS', '访问密码错误');
    }
    return this.issueForTemp(temp, ctx, 'link');
  }

  logout(actor: Actor, jti: string | undefined): void {
    if (jti) this.tokens.revoke(jti);
  }

  /**
   * D15 自助销毁：只有临时账号本人能调用，且必须回传帐户ID 后 6 位。
   * 与到期销毁走同一条落库路径（disabled=1），已上传资源与归属一律保留。
   */
  async tempDestroy(
    actor: Actor,
    confirmNo: string,
    jti: string | undefined,
    ctx: RequestContext,
  ): Promise<{ destroyed: true }> {
    if (actor.kind === ActorKind.Member) {
      throw new AppError(403, 'TEMP_ONLY', '自助销毁仅临时账号可调用');
    }
    if (actor.kind !== ActorKind.Temp) {
      throw new AppError(401, 'LOGIN_REQUIRED', '需登录后操作');
    }

    const temp = await this.temps.findOne({ where: { id: actor.tempId } });
    if (!temp) throw new AppError(401, 'TEMP_NOT_FOUND', '临时账号不存在');

    const tail = temp.accountNo.slice(-6).toUpperCase();
    if (confirmNo.trim().toUpperCase() !== tail) {
      await this.audit.record(actor, ctx, {
        action: 'temp_self_destroy',
        targetType: LogTargetType.Temp,
        targetId: temp.id,
        detail: 'confirm_mismatch',
        result: 0,
      });
      throw new AppError(400, 'CONFIRM_MISMATCH', '帐户ID 后 6 位不匹配，已取消销毁');
    }

    if (temp.disabled !== 1) {
      await this.temps.update({ id: temp.id }, { disabled: 1 });
      await this.audit.record(actor, ctx, {
        action: 'temp_self_destroy',
        targetType: LogTargetType.Temp,
        targetId: temp.id,
        detail: `account_no=${temp.accountNo}`,
      });
    }
    /** 令牌一撤销，后续任何请求都由 ActorGuard 拦成 401，重复调用自然幂等 */
    if (jti) this.tokens.revoke(jti);
    return { destroyed: true };
  }

  async changePassword(actor: Actor, oldPassword: string, newPassword: string): Promise<void> {
    if (actor.kind !== ActorKind.Member && actor.kind !== ActorKind.Temp) {
      throw new AppError(401, 'LOGIN_REQUIRED', '需登录后修改密码');
    }
    if (newPassword.length < 8) {
      throw new AppError(400, 'WEAK_PASSWORD', '新密码至少 8 位');
    }

    if (actor.kind === ActorKind.Member) {
      const user = await this.users
        .createQueryBuilder('u')
        .addSelect('u.password')
        .where('u.id = :id', { id: actor.uid })
        .getOne();
      if (!user || !(await bcrypt.compare(oldPassword, user.password))) {
        throw new AppError(401, 'BAD_CREDENTIALS', '原密码错误');
      }
      user.password = await this.hashPassword(newPassword);
      await this.users.save(user);
      return;
    }

    const temp = await this.temps
      .createQueryBuilder('t')
      .addSelect('t.password')
      .where('t.id = :id', { id: actor.tempId })
      .getOne();
    if (!temp) throw new AppError(401, 'TEMP_NOT_FOUND', '临时账号不存在');
    if (temp.password && !(await bcrypt.compare(oldPassword, temp.password))) {
      throw new AppError(401, 'BAD_CREDENTIALS', '原密码错误');
    }
    temp.password = await this.hashPassword(newPassword);
    await this.temps.save(temp);
  }

  async profile(actor: Actor): Promise<Record<string, unknown>> {
    if (actor.kind === ActorKind.Member) {
      const user = await this.users.findOne({ where: { id: actor.uid } });
      if (!user) throw new AppError(401, 'ACCOUNT_DISABLED', '账号不存在或已被禁用');
      return {
        kind: 'user',
        uid: user.id,
        username: user.username,
        nickname: user.nickname,
        level: user.level,
        levelName: LEVEL_LABEL[user.level],
        spaceQuota: Number(user.spaceQuota),
        usedSpace: Number(user.usedSpace),
        capabilities: capabilitiesFor(user.level),
      };
    }

    if (actor.kind === ActorKind.Temp) {
      const temp = await this.temps.findOne({
        where: { id: actor.tempId },
        relations: { albumGrants: true, folderGrants: true },
      });
      if (!temp) throw new AppError(401, 'TEMP_NOT_FOUND', '临时账号不存在');
      return {
        kind: 'temp',
        tempId: temp.id,
        displayName: temp.displayName,
        expiresAt: temp.expireTime,
        ownerUid: temp.ownerUid,
        flags: actor.flags,
        allowedAlbumIds: (temp.albumGrants ?? []).map((g) => g.albumId),
        allowedFolderIds: (temp.folderGrants ?? []).map((g) => g.folderId),
        spaceQuota: Number(temp.spaceQuota),
        usedSpace: Number(temp.usedSpace),
      };
    }

    throw new AppError(401, 'LOGIN_REQUIRED', '需登录后访问');
  }

  private async loginAsMember(user: User, password: string, ctx: RequestContext) {
    if (!(await bcrypt.compare(password, user.password))) {
      await this.denied(ctx, 'login_failed', 'bad_password');
      throw new AppError(401, 'BAD_CREDENTIALS', '账号或密码错误');
    }
    if (user.status !== 1) {
      await this.denied(ctx, 'login_denied', 'account_disabled');
      throw new AppError(403, 'ACCOUNT_DISABLED', '账号已被禁用');
    }
    const accessToken = await this.tokens.signUser(user.id, user.level);
    user.lastLoginTime = new Date();
    await this.users.save({ id: user.id, lastLoginTime: user.lastLoginTime });
    return {
      accessToken,
      identity: {
        kind: 'user' as const,
        uid: user.id,
        username: user.username,
        nickname: user.nickname,
        level: user.level,
      },
    };
  }

  private async loginAsTemp(temp: TempAccount, password: string, ctx: RequestContext) {
    if (!temp.password || !(await bcrypt.compare(password, temp.password))) {
      await this.denied(ctx, 'login_failed', 'temp_bad_password');
      throw new AppError(401, 'BAD_CREDENTIALS', '账号或密码错误');
    }
    return this.issueForTemp(temp, ctx, 'password');
  }

  private async issueForTemp(
    temp: TempAccount,
    ctx: RequestContext,
    via: 'link' | 'password',
  ): Promise<LoginResult> {
    if (temp.disabled === 1 || temp.expireTime.getTime() <= Date.now()) {
      await this.denied(ctx, 'temp_expired_access', via);
      throw new AppError(401, 'TEMP_EXPIRED', '临时账号已到期或已被销毁');
    }
    const accessToken = await this.tokens.signTemp(temp.id);
    return {
      accessToken,
      identity: {
        kind: 'temp' as const,
        tempId: temp.id,
        displayName: temp.displayName,
        expiresAt: temp.expireTime,
      },
    };
  }

  private denied(ctx: RequestContext, action: string, reason: string): Promise<unknown> {
    return this.audit.record({ kind: ActorKind.Guest }, ctx, {
      action,
      detail: reason,
      result: 0,
    });
  }
}
