/**
 * 取图（PRD 18 章的「取图」格）：临时账号的独立待领清单。
 * 分前期修图（stage1）和后期返图（stage2）两部分，各自独立完成独立展示。
 * 某阶段未完成时，对应该阶段的图组必为空——不是白名单里没图，而是还没修完。
 * 与 4.4 的 coser 分享链接是两条独立交付路径，这里不过 share_token。
 */
import type { TakeGroup, TakePending } from '@/types/api';
import { TEMPS, albumById, imagesOfAlbum } from './db';
import type { Actor } from './policy';
import { closedAlbumCaps, fail, readableImages, toView } from './shared';

function buildGroups(actor: Actor, albumIds: number[]): TakeGroup[] {
  const groups: TakeGroup[] = [];
  for (const albumId of albumIds) {
    const album = albumById(albumId);
    if (!album) continue;
    // D25：本册关掉「临时账号访问」时整册从待领清单消失，与相册列表 / decideTemp 的 404 同一口径（PRD 6.5）
    if (closedAlbumCaps(album).includes('tempAccess')) continue;
    const images = readableImages(imagesOfAlbum(albumId), actor).map((seed) => toView(seed, actor));
    if (!images.length) continue;
    groups.push({
      kind: 'album',
      id: albumId,
      name: album.name,
      subtitle: `${album.eventName || '未标注漫展'} · ${album.eventDate}`,
      images,
    });
  }
  return groups;
}

export function takePending(actor: Actor): TakePending {
  if (actor.kind !== 'temp') fail(403, 'TEMP_ONLY', '待领清单只对临时账号开放');
  const temp = TEMPS.find((t) => t.tempId === actor.tempId);
  if (!temp) fail(401, 'ACCOUNT_DISABLED', '账号已失效');

  const base = {
    code: temp.code,
    preStageDone: temp.stage1 === 1,
    postStageDone: temp.stage2 === 1,
    canDownload: temp.flags.download,
  };

  // 白名单相册里可能没有图或档位不够可见，但那属于另一个问题（readableImages 过滤后空）
  const preGroups = temp.stage1 === 1 ? buildGroups(actor, temp.albumIds) : [];
  const postGroups = temp.stage2 === 1 ? buildGroups(actor, temp.albumIds) : [];

  return { ...base, preGroups, postGroups };
}
