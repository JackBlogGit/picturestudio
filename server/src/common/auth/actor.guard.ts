import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditService, RequestContext } from '../../modules/audit/audit.service';
import { tempGrantIds } from '../permission/temp-grants';
import { LogTargetType, TempAccount, User } from '../../entities';
import { AppError } from '../http/app-error';
import { UserLevel } from '../enums/user-level.enum';
import { Actor, ActorKind, TempActor } from '../permission/types';
import { TokenPayload, TokenService } from './token.service';

export interface ActorRequest extends Request {
  actor: Actor;
  auditCtx: RequestContext;
  tokenPayload?: TokenPayload;
}

@Injectable()
export class ActorGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(TempAccount) private readonly temps: Repository<TempAccount>,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ActorRequest>();
    req.auditCtx = { ip: req.ip ?? '', ua: (req.headers['user-agent'] as string) ?? '' };
    const { actor, payload } = await this.resolve(req, req.auditCtx);
    req.actor = actor;
    req.tokenPayload = payload;
    return true;
  }

  private async resolve(
    req: Request,
    ctx: RequestContext,
  ): Promise<{ actor: Actor; payload?: TokenPayload }> {
    const raw = this.extractToken(req);
    if (!raw) {
      return { actor: { kind: ActorKind.Guest } };
    }

    let payload;
    try {
      payload = this.tokens.verify(raw);
    } catch {
      await this.audit.record({ kind: ActorKind.Guest }, ctx, {
        action: 'auth_failed',
        detail: 'invalid_token',
        result: 0,
      });
      throw new AppError(401, 'INVALID_TOKEN', '登录状态无效，请重新登录');
    }

    if (this.tokens.isRevoked(payload.jti)) {
      throw new AppError(401, 'TOKEN_REVOKED', '登录状态已失效，请重新登录');
    }

    if (payload.kind === 'user') {
      const uid = Number(payload.sub.slice(2));
      const user = await this.users.findOne({ where: { id: uid } });
      if (!user || user.status !== 1) {
        throw new AppError(401, 'ACCOUNT_DISABLED', '账号不存在或已被禁用');
      }
      // level 以库内值为准：管理员调级后旧 token 里的等级立即失效
      return { actor: { kind: ActorKind.Member, uid: user.id, level: user.level as UserLevel }, payload };
    }

    const tempId = Number(payload.sub.slice(3));
    const temp = await this.temps.findOne({ where: { id: tempId } });
    if (!temp) {
      throw new AppError(401, 'TEMP_NOT_FOUND', '临时账号不存在');
    }
    if (temp.disabled === 1 || temp.expireTime.getTime() <= Date.now()) {
      await this.audit.record({ kind: ActorKind.Guest }, ctx, {
        action: 'temp_expired_access',
        targetType: LogTargetType.Temp,
        targetId: temp.id,
        result: 0,
      });
      throw new AppError(401, 'TEMP_EXPIRED', '临时账号已到期或已被销毁');
    }

    const grants = await tempGrantIds(this.temps.manager, temp.id);
    const actor: TempActor = {
      kind: ActorKind.Temp,
      tempId: temp.id,
      ownerUid: temp.ownerUid,
      expired: false,
      disabled: false,
      flags: {
        preview: temp.allowPreview === 1,
        download: temp.allowDownload === 1,
        editTag: temp.allowEditTag === 1,
      },
      quotaBytes: Number(temp.spaceQuota),
      usedBytes: Number(temp.usedSpace),
      albumIds: grants.albumIds,
      folderIds: grants.folderIds,
    };
    return { actor, payload };
  }

  /**
   * 图片/缩略图由 <img src> 直接加载，浏览器不会带 Authorization 头，所以 GET 额外认 ?t=。
   * 只放开 GET 且只认这一个参数名——写操作仍然只能走 Bearer，令牌不会进浏览器历史以外的通道。
   */
  private extractToken(req: Request): string | null {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      return header.slice(7).trim() || null;
    }
    if (req.method !== 'GET') return null;
    const raw = (req.query as Record<string, unknown> | undefined)?.t;
    return typeof raw === 'string' && raw ? raw : null;
  }
}
