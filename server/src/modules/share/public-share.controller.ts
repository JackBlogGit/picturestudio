import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Req, Res } from '@nestjs/common';
import { Response } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { ActorRequest } from '../../common/auth/actor.guard';
import { Action } from '../../common/permission/types';
import { UnlockShareDto } from './dto/share.dto';
import { PublicShareService } from './public-share.service';
import { buildShareCookie, readShareCookie, ShareSessionService } from './share-session';

/**
 * 公开返图通道（PRD 10.3）：只认 URL 里的 token，不认登录态。
 * 口令链路的解锁状态是一条 Path 收窄到本链接的 HttpOnly Cookie，服务端读、服务端写，
 * 前端只在 403 时弹密码框，拿不到也存不了会话。
 *
 * 字节出口不参与全局限流：一页几十张预览是浏览器并发拉的，100/分钟会刷成裂图；
 * 口令校验与页面读取仍然限流，猜口令没有缺口，猜 token 面对的是 64 位随机值。
 */
@Controller('public/share')
export class PublicShareController {
  constructor(
    private readonly service: PublicShareService,
    private readonly session: ShareSessionService,
  ) {}

  @Get(':token')
  async view(@Param('token') token: string, @Req() req: ActorRequest): Promise<unknown> {
    return this.service.view(token, await this.unlocked(token, req), req.auditCtx);
  }

  @Post(':token/unlock')
  @HttpCode(200)
  async unlock(
    @Param('token') token: string,
    @Body() dto: UnlockShareDto,
    @Req() req: ActorRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ unlocked: true }> {
    const result = await this.service.unlock(token, dto.password);
    if (result.cookie) {
      res.setHeader('Set-Cookie', buildShareCookie(result.cookie, token, req.secure === true));
    }
    return { unlocked: true };
  }

  @Get(':token/images/:id/preview')
  @SkipThrottle()
  preview(@Param('token') token: string, @Param('id', ParseIntPipe) id: number, @Req() req: ActorRequest) {
    return this.imageBytes(token, id, Action.Preview, req);
  }

  @Get(':token/images/:id/original')
  @SkipThrottle()
  original(@Param('token') token: string, @Param('id', ParseIntPipe) id: number, @Req() req: ActorRequest) {
    return this.imageBytes(token, id, Action.DownloadOriginal, req);
  }

  private async imageBytes(
    token: string,
    imageId: number,
    action: Action.Preview | Action.DownloadOriginal,
    req: ActorRequest,
  ) {
    return this.service.image(token, imageId, action, await this.unlocked(token, req));
  }

  private unlocked(token: string, req: ActorRequest): Promise<boolean> {
    return this.session.isValid(readShareCookie(req.headers.cookie), token);
  }
}
