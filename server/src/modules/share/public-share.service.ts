import { HttpStatus, Injectable, StreamableFile } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { AppError } from '../../common/http/app-error';
import { contentDisposition } from '../../common/http/disposition';
import { unwrapDecision } from '../../common/permission/actor-guards';
import { decide } from '../../common/permission/permission-policy';
import { Action, ActorKind, ResourceType, ShareActor } from '../../common/permission/types';
import { StoredFile, StorageService } from '../../common/storage/storage.service';
import { CoserShareLink, Image, LogTargetType } from '../../entities';
import { AuditService, RequestContext } from '../audit/audit.service';
import { TagService } from '../tag/tag.service';
import { TagView, visibleTags } from '../image/image-shape';
import { ShareHitService } from './share-hit';
import { ShareLinkService } from './share-link.service';
import { ShareSessionService } from './share-session';
import { isShareExpired, publicView, PublicShareView, visitorView } from './share-shape';

@Injectable()
export class PublicShareService {
  constructor(
    @InjectRepository(Image) private readonly images: Repository<Image>,
    @InjectRepository(CoserShareLink) private readonly links: Repository<CoserShareLink>,
    private readonly shareLinks: ShareLinkService,
    private readonly hits: ShareHitService,
    private readonly storage: StorageService,
    private readonly tags: TagService,
    private readonly session: ShareSessionService,
    private readonly audit: AuditService,
  ) {}

  /** GET /public/share/:token —— 口令没过后拿不到任何内容，页面据此弹密码框 */
  async view(shareToken: string, sessionOk: boolean, ctx: RequestContext): Promise<PublicShareView> {
    const link = await this.readable(shareToken);
    await this.assertUnlocked(link, sessionOk);

    const images = await this.hits.hitImages(await this.hits.filterOf(link));
    const actor = this.actorOf(link, images.map((i) => i.id));
    const [scopeAlbum, coser, hitAlbums] = await Promise.all([
      this.shareLinks.albumOf(link.albumId),
      this.shareLinks.tagOf(link.coserTagId),
      this.hits.albumsByIds([...new Set(images.map((i) => i.albumId))]),
    ]);
    const albumsById = new Map(hitAlbums.map((album) => [album.id, album]));

    const tagMap = await this.tagMap(images, actor);
    const views = images.map((image) =>
      visitorView(
        image,
        link,
        tagMap.get(image.id) ?? [],
        albumsById.get(image.albumId)?.stage ?? null,
      ),
    );

    await this.countVisit(link, ctx);
    return publicView({
      link,
      scopeAlbum,
      coserName: coser?.tagName ?? null,
      albumsById,
      images: views,
    });
  }

  /**
   * POST /public/share/:token/unlock —— 无口令链接直接算通过，前端不用分支；
   * 通过后由控制器把子会话 Cookie 挂到本条链接的路径下。
   */
  async unlock(shareToken: string, password: string): Promise<{ unlocked: true; cookie?: string }> {
    const link = await this.resolve(shareToken);
    if (!link || link.revoked === 1) {
      throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', '链接不存在或已被注销');
    }
    if (isShareExpired(link)) {
      throw new AppError(HttpStatus.GONE, 'LINK_EXPIRED', '该返图链接已过期，交付已收回');
    }
    const hash = await this.shareLinks.passwordOf(link.id);
    if (!hash) return { unlocked: true };
    if (!(await bcrypt.compare(password, hash))) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'BAD_CREDENTIALS', '访问密码错误');
    }
    return { unlocked: true, cookie: await this.session.issue(link.shareToken) };
  }

  /**
   * 访客拿字节只有这两个出口，且一律按 token 判定：
   * 集合外的图片 ID 回 404 而不是 403，不给枚举留存在性提示（PRD 4.4）。
   * 口令链路的字节同样要过解锁，否则猜得出图片 ID 就绕过了密码页。
   */
  async image(
    shareToken: string,
    imageId: number,
    action: Action.Preview | Action.DownloadOriginal,
    sessionOk: boolean,
  ): Promise<StreamableFile> {
    const link = await this.resolve(shareToken);
    if (!link || link.revoked === 1 || isShareExpired(link)) {
      throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', '链接不存在或已失效');
    }
    await this.assertUnlocked(link, sessionOk);

    const hits = await this.hits.hitImages(await this.hits.filterOf(link));
    const image = hits.find((row) => row.id === imageId);
    if (!image) {
      throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', '该图片不在分享链接范围内');
    }
    unwrapDecision(
      decide(action, this.actorOf(link, [imageId]), {
        type: ResourceType.Image,
        id: image.id,
        visibility: image.visibility,
        ownerId: image.uploadUid,
        albumId: image.albumId,
      }),
    );
    return action === Action.Preview ? this.previewFile(image) : this.originalFile(image);
  }

  private actorOf(link: CoserShareLink, imageIds: number[]): ShareActor {
    return {
      kind: ActorKind.ShareVisitor,
      linkId: link.id,
      imageIds,
      allowDownload: link.allowDownload === 1,
    };
  }

  private resolve(shareToken: string): Promise<CoserShareLink | null> {
    return this.shareLinks.byToken(shareToken);
  }

  private async readable(shareToken: string): Promise<CoserShareLink> {
    const link = await this.resolve(shareToken);
    // 注销与不存在同一口径，避免枚举 token（PRD 12.5）
    if (!link || link.revoked === 1) {
      throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', '链接不存在或已被注销');
    }
    if (isShareExpired(link)) {
      throw new AppError(HttpStatus.GONE, 'LINK_EXPIRED', '该返图链接已过期，交付已收回');
    }
    return link;
  }

  private async assertUnlocked(link: CoserShareLink, sessionOk: boolean): Promise<void> {
    // link.password 恒为 undefined（select:false），判口令只能问库，不能用 === null
    if (sessionOk || !(await this.shareLinks.passwordSet(link.id))) return;
    throw new AppError(HttpStatus.FORBIDDEN, 'SHARE_PASSWORD_REQUIRED', '该链接需要访问密码');
  }

  private async tagMap(images: Image[], actor: ShareActor): Promise<Map<number, TagView[]>> {
    const map = new Map<number, TagView[]>();
    if (!images.length) return map;
    for (const { imageId, tag } of await this.tags.tagsOf(images.map((i) => i.id))) {
      const bucket = map.get(imageId) ?? [];
      bucket.push(...visibleTags(actor, [tag]));
      map.set(imageId, bucket);
    }
    return map;
  }

  private async countVisit(link: CoserShareLink, ctx: RequestContext): Promise<void> {
    link.visitCount += 1;
    link.lastVisitTime = new Date();
    await this.links.save(link);
    await this.audit.record(this.actorOf(link, []), ctx, {
      action: 'share_view',
      targetType: LogTargetType.Link,
      targetId: link.id,
      detail: link.shareToken,
    });
  }

  private async previewFile(image: Image): Promise<StreamableFile> {
    if (!image.previewPath) {
      throw new AppError(HttpStatus.CONFLICT, 'PREVIEW_NOT_READY', '预览图尚未生成，请稍后重试');
    }
    const file = await this.open(image.previewPath, '预览图');
    return new StreamableFile(file.stream, { type: 'image/webp', length: file.size });
  }

  /** 原图一律按附件下发，文件名走 RFC 5987 双写，中文名不乱码（PRD 15.14） */
  private async originalFile(image: Image): Promise<StreamableFile> {
    const file = await this.open(image.originalPath, '原图');
    return new StreamableFile(file.stream, {
      type: 'application/octet-stream',
      length: file.size,
      disposition: contentDisposition(image.filename),
    });
  }

  /** 库里有条记录、磁盘上文件却没了（手工清理或磁盘故障）时，给 409 而不是 500 */
  private async open(rel: string, label: string): Promise<StoredFile> {
    try {
      return await this.storage.read(rel);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      throw new AppError(HttpStatus.CONFLICT, 'FILE_MISSING', `${label}文件缺失，请联系管理员重新生成`);
    }
  }
}
