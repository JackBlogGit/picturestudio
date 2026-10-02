import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CRAWLER_LINK_STATUSES, CrawlerLinkStatus, CrawlerPlatform } from '../../../entities';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** 单次检索条数上限：CLI 背后是搜索引擎，捞太多只会带回一堆无关转载 */
export const CRAWLER_SEARCH_LIMITS = { min: 1, max: 20, fallback: 10 } as const;

export class SearchCrawlerDto {
  @Transform(trim)
  @IsString()
  @MinLength(2, { message: '检索词至少 2 个字符' })
  @MaxLength(50, { message: '检索词最长 50 个字符' })
  keyword: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(CRAWLER_SEARCH_LIMITS.min)
  @Max(CRAWLER_SEARCH_LIMITS.max)
  limit?: number = CRAWLER_SEARCH_LIMITS.fallback;
}

/** 只读回页面元数据，不下载文件；url 由服务层过 SSRF 闸门 */
export class ProbeCrawlerDto {
  @Transform(trim)
  @IsString()
  @MaxLength(1000, { message: '地址最长 1000 字符' })
  url: string;
}

export class CreateCrawlerLinkDto {
  @Transform(trim)
  @IsString()
  @MaxLength(1000, { message: '地址最长 1000 字符' })
  url: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  snippet?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  keyword?: string;
}

export class ListCrawlerLinkDto {
  @IsOptional()
  @Type(() => Number)
  @IsIn(CRAWLER_LINK_STATUSES, { message: `status 只能是 ${CRAWLER_LINK_STATUSES.join(' / ')}` })
  status?: CrawlerLinkStatus;

  @IsOptional()
  @Transform(trim)
  @IsIn(Object.values(CrawlerPlatform), { message: 'platform 不合法' })
  platform?: CrawlerPlatform;

  /** 标题 / 域名 / 正文的模糊词 */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}

export class UpdateCrawlerLinkDto {
  @Type(() => Number)
  @IsIn(CRAWLER_LINK_STATUSES, { message: `status 只能是 ${CRAWLER_LINK_STATUSES.join(' / ')}` })
  status: CrawlerLinkStatus;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}
