import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Like, Repository } from 'typeorm';
import { ImageTagMap, LogTargetType, Tag, TagType } from '../../entities';
import { AuditService, RequestContext } from '../audit/audit.service';
import { AppError } from '../../common/http/app-error';
import { UserLevel } from '../../common/enums/user-level.enum';
import { Actor, ActorKind, AdminAction, Decision } from '../../common/permission/types';
import { decideAdmin } from '../../common/permission/permission-policy';

/** 各类型标签「本身」的最低维护等级：status 为内置体系，只允许 L3/L4 增删 */
export const TAG_ADMIN_MIN_LEVEL: Record<TagType, UserLevel> = {
  [TagType.Event]: UserLevel.Member,
  [TagType.Coser]: UserLevel.Member,
  [TagType.Role]: UserLevel.Member,
  [TagType.Photographer]: UserLevel.Member,
  [TagType.Status]: UserLevel.Admin,
};

export function splitAlias(alias: string): string[] {
  return (alias ?? '')
    .split(/[,，、|/]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function normalizeTagName(raw: string): string {
  const name = (raw ?? '').replace(/[\r\n\t]/g, ' ').trim();
  if (!name) throw new AppError(HttpStatus.BAD_REQUEST, 'EMPTY_TAG_NAME', '标签名不能为空');
  if (name.length > 100) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'TAG_NAME_TOO_LONG', '标签名不得超过 100 字');
  }
  return name;
}

/** tagName 精确命中优先，其次别名逐个比对，避免「柚子」错命中「小柚子」 */
export function matchExact(rows: Tag[], name: string): Tag | undefined {
  const lower = name.toLowerCase();
  return (
    rows.find((r) => r.tagName.toLowerCase() === lower) ??
    rows.find((r) => splitAlias(r.alias ?? '').some((a) => a.toLowerCase() === lower))
  );
}

/** LIKE 通配符必须转义，否则用户输入 % 就能全表扫 */
export function likeParam(keyword: string): string {
  return `%${keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function isMember(actor: Actor): actor is { kind: ActorKind.Member; uid: number; level: UserLevel } {
  return actor.kind === ActorKind.Member;
}

function isDuplicateKey(err: unknown): boolean {
  const code = (err as { code?: string; errno?: number })?.code;
  return code === 'ER_DUP_ENTRY' || Number((err as { errno?: number })?.errno) === 1062;
}

@Injectable()
export class TagService {
  private readonly logger = new Logger(TagService.name);

  constructor(
    @InjectRepository(Tag) private readonly tags: Repository<Tag>,
    @InjectRepository(ImageTagMap) private readonly maps: Repository<ImageTagMap>,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /** PRD 4.1：status 标签对临时账号、游客、分享访客一律不下发 */
  static hidesStatusTags(actor: Actor): boolean {
    return actor.kind !== ActorKind.Member;
  }

  filterTags<T extends { tagType: TagType }>(actor: Actor, tags: T[]): T[] {
    return TagService.hidesStatusTags(actor)
      ? tags.filter((t) => t.tagType !== TagType.Status)
      : tags;
  }

  async suggest(actor: Actor, type: TagType | undefined, keyword: string, limit = 20): Promise<Tag[]> {
    const kw = (keyword ?? '').trim();
    if (!kw) return [];
    const qb = this.tags
      .createQueryBuilder('t')
      .where('t.mergedInto IS NULL')
      .andWhere("(t.tagName LIKE :kw ESCAPE '\\\\' OR t.alias LIKE :kw ESCAPE '\\\\')", { kw: likeParam(kw) })
      .orderBy('t.useCount', 'DESC')
      .addOrderBy('t.tagName', 'ASC')
      .take(Math.min(Math.max(limit, 1), 50));
    if (type) qb.andWhere('t.tagType = :type', { type });
    if (TagService.hidesStatusTags(actor)) {
      qb.andWhere('t.tagType <> :hidden', { hidden: TagType.Status });
    }
    return qb.getMany();
  }

  async list(params: { type?: TagType; keyword?: string; includeMerged?: boolean }): Promise<Tag[]> {
    const qb = this.tags
      .createQueryBuilder('t')
      .orderBy('t.useCount', 'DESC')
      .addOrderBy('t.id', 'ASC')
      .take(500);
    if (params.type) qb.andWhere('t.tagType = :type', { type: params.type });
    if (!params.includeMerged) qb.andWhere('t.mergedInto IS NULL');
    const kw = params.keyword?.trim();
    if (kw) qb.andWhere("t.tagName LIKE :kw ESCAPE '\\\\'", { kw: likeParam(kw) });
    return qb.getMany();
  }

  async findById(id: number): Promise<Tag> {
    const row = await this.tags.findOne({ where: { id } });
    if (!row) throw new AppError(HttpStatus.NOT_FOUND, 'TAG_NOT_FOUND', '标签不存在');
    return row;
  }

  /** 批量取标签：缺失项静默返回少几个，由调用方决定是报错还是忽略 */
  async pick(ids: number[]): Promise<Tag[]> {
    if (!ids.length) return [];
    return this.tags.find({ where: { id: In(ids) } });
  }

  /** 候选集用 LIKE 粗筛，精确判定交给 matchExact，避免别名子串误命中 */
  private async findByName(type: TagType, name: string): Promise<Tag | undefined> {
    const candidates = await this.tags.find({
      where: { tagType: type, tagName: name },
    });
    if (candidates.length) return candidates[0];
    const byAlias = await this.tags.find({
      where: { tagType: type, alias: Like(`%${name}%`) },
    });
    return matchExact(byAlias, name);
  }

  /** 合并过的标签自动指向目标；链路过长说明数据被手工改坏，记日志后停在末端 */
  private async follow(tag: Tag, depth = 0): Promise<Tag> {
    const next = tag.mergedInto;
    if (next === null || next === undefined) return tag;
    if (depth >= 5) {
      this.logger.warn(`标签 ${tag.id} 的合并链超过 5 层，停在 ${next}`);
      return tag;
    }
    const target = await this.tags.findOne({ where: { id: next } });
    return target ? this.follow(target, depth + 1) : tag;
  }

  /**
   * PRD 4.1「输入即建」：命中 tagName 或 alias 就复用，否则新建。
   * status 类型不允许隐式创建——成员只能给自有图片打已有状态。
   */
  async resolveOrCreate(type: TagType, rawName: string, actor: Actor): Promise<Tag> {
    const name = normalizeTagName(rawName);
    const hit = await this.findByName(type, name);
    if (hit) return this.follow(hit);

    if (type === TagType.Status) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'STATUS_TAG_NOT_FOUND',
        `状态标签「${name}」不存在，状态标签只能由管理员维护`,
      );
    }
    this.assertLevel(actor, type, AdminAction.CreateTag, '创建');

    try {
      return await this.tags.save(
        this.tags.create({ tagType: type, tagName: name, alias: '', useCount: 0, createUid: memberUid(actor) }),
      );
    } catch (err) {
      /** 并发下 UNIQUE(tag_type,tag_name) 兜底：别人抢先建了同名标签就直接复用 */
      if (!isDuplicateKey(err)) throw err;
      const raced = await this.findByName(type, name);
      if (raced) return this.follow(raced);
      throw err;
    }
  }

  async create(
    dto: { type: TagType; name: string; alias?: string },
    actor: Actor,
    ctx: RequestContext,
  ): Promise<Tag> {
    this.assertLevel(actor, dto.type, AdminAction.CreateTag, '创建');
    const name = normalizeTagName(dto.name);
    if (await this.findByName(dto.type, name)) {
      throw new AppError(HttpStatus.CONFLICT, 'TAG_EXISTS', `标签「${name}」已存在`);
    }
    const row = this.tags.create({
      tagType: dto.type,
      tagName: name,
      alias: splitAlias(dto.alias ?? '').join(','),
      useCount: 0,
      createUid: memberUid(actor),
    });
    try {
      const saved = await this.tags.save(row);
      await this.audit.record(actor, ctx, {
        action: 'tag_create',
        targetType: LogTargetType.Tag,
        targetId: saved.id,
        detail: saved.tagName,
      });
      return saved;
    } catch (err) {
      if (isDuplicateKey(err)) throw new AppError(HttpStatus.CONFLICT, 'TAG_EXISTS', `标签「${name}」已存在`);
      throw err;
    }
  }

  async rename(
    id: number,
    name: string,
    alias: string | undefined,
    actor: Actor,
    ctx: RequestContext,
  ): Promise<Tag> {
    const tag = await this.findById(id);
    this.assertLevel(actor, tag.tagType, AdminAction.CreateTag, '改名');
    const next = normalizeTagName(name);
    if (next.toLowerCase() !== tag.tagName.toLowerCase()) {
      const clash = await this.findByName(tag.tagType, next);
      if (clash && clash.id !== tag.id) {
        throw new AppError(HttpStatus.CONFLICT, 'TAG_EXISTS', `标签「${next}」已存在，若要归请使用合并`);
      }
    }
    tag.tagName = next;
    if (alias !== undefined) tag.alias = splitAlias(alias).join(',');
    await this.tags.save(tag);
    await this.audit.record(actor, ctx, {
      action: 'tag_rename',
      targetType: LogTargetType.Tag,
      targetId: tag.id,
      detail: next,
    });
    return tag;
  }

  /**
   * PRD 4.1：历史关联迁到目标标签后停用源标签，不物理删（保留频次统计）。
   * 与目标已有同一图片的关联先删掉，否则 UPDATE 会撞 UNIQUE(image_id,tag_id)。
   */
  async merge(sourceId: number, targetId: number, actor: Actor, ctx: RequestContext): Promise<Tag> {
    if (sourceId === targetId) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'SELF_MERGE', '不能把标签合并到自己');
    }
    const source = await this.findById(sourceId);
    const target = await this.follow(await this.findById(targetId));
    if (target.id === source.id) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'CYCLIC_MERGE', '目标标签已合并进源标签，方向反了');
    }
    if (target.tagType !== source.tagType) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'TYPE_MISMATCH', '只有同类型标签可以合并');
    }
    this.assertLevel(actor, source.tagType, AdminAction.MergeOrDeleteTag, '合并');

    await this.dataSource.transaction(async (em) => {
      const maps = em.getRepository(ImageTagMap);
      const owned = await maps.find({ where: { tagId: source.id }, select: { imageId: true } });
      const ids = owned.map((m) => Number(m.imageId));
      if (ids.length) {
        const dupes = await maps
          .createQueryBuilder('m')
          .select('m.imageId', 'imageId')
          .where('m.tagId = :target', { target: target.id })
          .andWhere('m.imageId IN (:...ids)', { ids })
          .getRawMany<{ imageId: number }>();
        const dupeIds = dupes.map((d) => Number(d.imageId));
        if (dupeIds.length) await maps.delete({ tagId: source.id, imageId: In(dupeIds) });
      }
      await em
        .createQueryBuilder()
        .update(ImageTagMap)
        .set({ tagId: target.id })
        .where('tagId = :source', { source: source.id })
        .execute();
      await em.getRepository(Tag).update(source.id, { mergedInto: target.id });
    });

    await this.recount([target.id, source.id]);
    await this.audit.record(actor, ctx, {
      action: 'tag_merge',
      targetType: LogTargetType.Tag,
      targetId: target.id,
      detail: `${source.id}(${source.tagName}) → ${target.id}(${target.tagName})`,
    });
    return this.findById(target.id);
  }

  /** status 标签为内置，只允许改文案不允许删（PRD 4.6） */
  async remove(id: number, actor: Actor, ctx: RequestContext): Promise<void> {
    const tag = await this.findById(id);
    if (tag.tagType === TagType.Status) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'BUILTIN_STATUS_TAG', '内置状态标签不可删除，如需停用请清空其图片关联');
    }
    this.assertLevel(actor, tag.tagType, AdminAction.MergeOrDeleteTag, '删除');
    await this.tags.delete({ id: tag.id });
    await this.audit.record(actor, ctx, {
      action: 'tag_delete',
      targetType: LogTargetType.Tag,
      targetId: tag.id,
      detail: tag.tagName,
    });
  }

  /**
   * 频次校准（PRD 13 每日任务的实现体，合并/批量打标后也即时调用）。
   * 停用标签保留历史统计不参与重算，否则合并即丢频次。
   */
  async recount(ids?: number[]): Promise<number> {
    const rows = ids?.length
      ? await this.tags.find({ where: { id: In(ids) } })
      : await this.tags.find({ where: { mergedInto: IsNull() } });
    let changed = 0;
    for (const tag of rows) {
      const count = await this.maps.count({ where: { tagId: tag.id } });
      if (count !== tag.useCount) {
        await this.tags.update(tag.id, { useCount: count });
        changed += 1;
      }
    }
    return changed;
  }

  /** 标签图片关联的批量写入由 ImageService 负责，这里只暴露计数刷新所需的最小接口 */
  async attach(imageId: number, tagIds: number[]): Promise<number> {
    if (!tagIds.length) return 0;
    const existing = await this.maps.find({ where: { imageId, tagId: In(tagIds) }, select: { tagId: true } });
    const have = new Set(existing.map((e) => e.tagId));
    const fresh = tagIds.filter((id) => !have.has(id));
    if (fresh.length) {
      await this.maps.insert(fresh.map((tagId) => ({ imageId, tagId })));
    }
    return fresh.length;
  }

  async detach(imageId: number, tagIds: number[]): Promise<number> {
    if (!tagIds.length) return 0;
    const result = await this.maps.delete({ imageId, tagId: In(tagIds) });
    return result.affected ?? 0;
  }

  /** 图片被删后同步频次，避免 use_count 长期偏高 */
  async tagsOf(imageIds: number[]): Promise<Array<{ imageId: number; tag: Tag }>> {
    if (!imageIds.length) return [];
    const rows = await this.maps
      .createQueryBuilder('m')
      .innerJoin(Tag, 't', 't.id = m.tagId')
      .select('m.imageId', 'imageId')
      .addSelect('t', 't')
      .where('m.imageId IN (:...ids)', { ids: imageIds })
      .orderBy('m.imageId', 'ASC')
      .getRawMany<{ imageId: number; t: Tag }>();
    return rows.map((r) => ({ imageId: Number(r.imageId), tag: r.t }));
  }

  private assertLevel(actor: Actor, type: TagType, action: AdminAction, verb: string): void {
    const decision: Decision = decideAdmin(actor, action);
    if (!decision.allowed) throw new AppError(decision.status, decision.reason, decision.message);
    if (!isMember(actor)) {
      throw new AppError(HttpStatus.FORBIDDEN, 'ADMIN_REQUIRED', '仅正式成员可维护标签库');
    }
    if (actor.level < TAG_ADMIN_MIN_LEVEL[type]) {
      throw new AppError(HttpStatus.FORBIDDEN, 'LEVEL_FORBIDDEN', `${type} 标签仅 L${TAG_ADMIN_MIN_LEVEL[type]} 及以上可${verb}`);
    }
  }
}

function memberUid(actor: Actor): number | null {
  return isMember(actor) ? actor.uid : null;
}
