import { Body, Controller, Get, HttpCode, Post, Put, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ActorRequest } from '../../common/auth/actor.guard';
import { CurrentActor, CurrentAuditCtx } from '../../common/auth/actor.decorator';
import { RequestContext } from '../audit/audit.service';
import { AppError } from '../../common/http/app-error';
import { Actor, ActorKind } from '../../common/permission/types';
import { AuthService } from './auth.service';
import { ChangePasswordDto, LoginDto, TempDestroyDto, TempLinkDto } from './dto/auth.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  login(@Body() dto: LoginDto, @CurrentAuditCtx() ctx: RequestContext) {
    return this.auth.login(dto.username, dto.password, ctx);
  }

  @Post('temp-token')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  tempToken(@Body() dto: TempLinkDto, @CurrentAuditCtx() ctx: RequestContext) {
    return this.auth.loginByAccessToken(dto.accessToken, dto.password, ctx);
  }

  @Post('logout')
  @HttpCode(200)
  logout(@CurrentActor() actor: Actor, @Req() req: ActorRequest) {
    if (actor.kind === ActorKind.Guest) {
      throw new AppError(401, 'LOGIN_REQUIRED', '需登录后操作');
    }
    this.auth.logout(actor, req.tokenPayload?.jti);
    return { loggedOut: true };
  }

  @Post('temp-destroy')
  @HttpCode(200)
  tempDestroy(
    @CurrentActor() actor: Actor,
    @Body() dto: TempDestroyDto,
    @Req() req: ActorRequest,
    @CurrentAuditCtx() ctx: RequestContext,
  ) {
    return this.auth.tempDestroy(actor, dto.confirmNo, req.tokenPayload?.jti, ctx);
  }

  @Get('me')
  me(@CurrentActor() actor: Actor) {
    if (actor.kind === ActorKind.Guest) {
      throw new AppError(401, 'LOGIN_REQUIRED', '需登录后访问');
    }
    return this.auth.profile(actor);
  }

  @Put('password')
  @HttpCode(204)
  changePassword(@CurrentActor() actor: Actor, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(actor, dto.oldPassword, dto.newPassword);
  }
}
