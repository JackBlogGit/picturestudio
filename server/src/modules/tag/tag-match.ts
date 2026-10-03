import { Tag, TagType } from '../../entities';

export interface TagMatchFilter {
  /** 与 where / having 两个片段配套使用的参数，交给同一次查询 */
  params: Record<string, unknown>;
  /** 依赖查询里已 join 的别名 m（image_tag_map）与 t（tags） */
  where: string;
  having: string;
}

/** 同类型多个值是「或」，不同类型之间是「与」（PRD 4.4） */
export function groupTagIds(rows: Tag[]): Map<TagType, number[]> {
  const groups = new Map<TagType, number[]>();
  for (const tag of rows) {
    const bucket = groups.get(tag.tagType) ?? [];
    if (!bucket.includes(tag.id)) bucket.push(tag.id);
    groups.set(tag.tagType, bucket);
  }
  return groups;
}

/**
 * 上级文档写的是 COUNT(DISTINCT tag_id)=N，那只能表达「全部标签都要命中」，
 * 与同类型多值 OR 冲突，所以按 tag_type 计数：每组至少命中一个即记 1。
 * 空标签集必须跳过本片段——生成的 `()` 不是合法 SQL，调用方自己判空。
 */
export function tagMatchFilter(rows: Tag[]): TagMatchFilter {
  const groups = groupTagIds(rows);
  const clauses: string[] = [];
  const params: Record<string, unknown> = { tagGroups: groups.size };
  [...groups.entries()].forEach(([type, ids], index) => {
    clauses.push(`(t.tagType = :tagType${index} AND t.id IN (:...tagIds${index}))`);
    params[`tagType${index}`] = type;
    params[`tagIds${index}`] = ids;
  });
  return {
    params,
    where: `(${clauses.join(' OR ')})`,
    having: 'COUNT(DISTINCT t.tagType) = :tagGroups',
  };
}
