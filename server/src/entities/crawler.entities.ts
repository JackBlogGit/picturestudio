import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** 命中来源的平台归类：域名 → 平台，只用于列表筛选与统计，不做抓取策略 */
export enum CrawlerPlatform {
  Weibo = 'weibo',
  Bilibili = 'bilibili',
  Xiaohongshu = 'xiaohongshu',
  Douyin = 'douyin',
  Twitter = 'twitter',
  Other = 'other',
}

/** 跟进状态：登记之后要能看出「这条外链走到哪一步了」 */
export enum CrawlerLinkStatus {
  /** 0 刚登记，还没人看过 */
  Pending = 0,
  /** 1 已确认是本工作室作品的转载，仅作记录 */
  Noted = 1,
  /** 2 已联系发布者取得授权 */
  Contacted = 2,
  /** 3 已发起平台侵权投诉 */
  Reported = 3,
  /** 4 与本工作室无关，关掉 */
  Ignored = 4,
}

export const CRAWLER_LINK_STATUSES = [
  CrawlerLinkStatus.Pending,
  CrawlerLinkStatus.Noted,
  CrawlerLinkStatus.Contacted,
  CrawlerLinkStatus.Reported,
  CrawlerLinkStatus.Ignored,
] as const;

/** 链接怎么进来的：检索命中后一键登记，或超管手敲粘贴 */
export enum CrawlerLinkSource {
  Search = 'search',
  Manual = 'manual',
}

/**
 * 站外来源登记表（PRD D23）。只存 URL 与从页面上读到的少量文本元数据，
 * 不落地任何抓取到的文件字节——原图与派生图仍只走 files/images 那两条通道。
 */
@Entity('crawler_links')
@Index('uk_crawler_url_hash', ['urlHash'], { unique: true })
@Index('idx_crawler_status_time', ['status', 'createTime'])
@Index('idx_crawler_platform', ['platform'])
export class CrawlerLink {
  @PrimaryGeneratedColumn()
  id: number;

  /** 规范化后的绝对地址（去 fragment、去跟踪参数、host 小写），展示与跳转都用它 */
  @Column({ length: 1000 })
  url: string;

  /** 规范化地址的 sha256，唯一约束落这一列，避免长度与大小写造成的重复登记 */
  @Column({ name: 'url_hash', length: 64 })
  urlHash: string;

  @Column({ length: 255, default: '' })
  title: string;

  @Column({ length: 500, default: '' })
  snippet: string;

  @Column({ length: 255, default: '' })
  domain: string;

  @Column({ type: 'simple-enum', enum: CrawlerPlatform, default: CrawlerPlatform.Other })
  platform: CrawlerPlatform;

  /** 登记时命中的检索词，手敲登记可为空 */
  @Column({ length: 100, default: '' })
  keyword: string;

  @Column({ type: 'simple-enum', enum: CrawlerLinkSource, default: CrawlerLinkSource.Search })
  source: CrawlerLinkSource;

  @Column({ type: 'tinyint', default: CrawlerLinkStatus.Pending })
  status: CrawlerLinkStatus;

  @Column({ length: 500, default: '' })
  note: string;

  @Column({ type: 'int', nullable: true })
  createUid: number | null;

  /** 最后一次改状态的人与时间，Pending 之外都应有人负责 */
  @Column({ type: 'int', nullable: true })
  auditUid: number | null;

  @Column({ type: 'datetime', nullable: true })
  auditTime: Date | null;

  @CreateDateColumn({ type: 'datetime' })
  createTime: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updateTime: Date;
}
