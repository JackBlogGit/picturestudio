import { EntityManager } from 'typeorm';
import { TempAccountAlbum, TempAccountFolder } from '../../entities';

/**
 * 工单白名单只能按主键列直查。
 *
 * Why：TempAccountAlbum / TempAccountFolder 的复合主键写在 tempId / albumId 两列上，
 * 而 ManyToOne 的 @JoinColumn 名字是 snake 的 temp_id / album_id。开发库（SQLite 不套
 * snake 命名策略）于是同表开出两栏，种子与后台只填了主键那两栏，关系列恒为 NULL——
 * `relations: { albumGrants: true }` 因此每次拿到空数组，工单看起来像谁都没授权。
 * MySQL 侧两栏同名，所以这个坑只在开发库咬人；按属性列查在两边都对。
 */
export async function tempGrantIds(
  manager: EntityManager,
  tempId: number,
): Promise<{ albumIds: number[]; folderIds: number[] }> {
  const rows = await manager.getRepository(TempAccountAlbum).find({ where: { tempId } });
  const cols = await manager.getRepository(TempAccountFolder).find({ where: { tempId } });
  return {
    albumIds: rows.map((r) => Number(r.albumId)),
    folderIds: cols.map((r) => Number(r.folderId)),
  };
}
