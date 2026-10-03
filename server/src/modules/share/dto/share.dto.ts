import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** 有效期只在服务侧夹到 1~365 天，超出范围按边界取值而不是打回（PRD 10.3） */
export const SHARE_DEFAULT_DAYS = 30;
export const SHARE_MAX_DAYS = 365;

/**
 * 建链请求体：与 client/src/api/share.ts 的 ShareLinkInput 逐键对齐。
 * 全局 ValidationPipe 开了 forbidNonWhitelisted，多一个键就是 400。
 * 两种口径共用一份 DTO——返给个人的 coserTagId 必填由服务侧判，
 * 因为服务本来就要取标签确认它是 coser 类型。
 */
export class CreateShareLinkDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'coserTagId 必须是标签 ID' })
  @Min(1)
  coserTagId?: number | null;

  @IsOptional()
  @IsArray({ message: 'tagIds 必须是标签 ID 数组' })
  @ArrayMaxSize(20, { message: '附加筛选标签不得超过 20 个' })
  @IsInt({ each: true, message: 'tagIds 必须是标签 ID' })
  @Min(1, { each: true })
  tagIds?: number[];

  /** true=固化当次命中集合，false=按标签实时命中 */
  @IsOptional()
  @IsBoolean({ message: 'snapshot 必须是布尔值' })
  snapshot?: boolean;

  /** 只在创建时经手一次，落库存 bcrypt，任何响应都不带回明文 */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64, { message: '访问密码不得超过 64 字' })
  password?: string | null;

  @IsOptional()
  @IsBoolean({ message: 'allowDownload 必须是布尔值' })
  allowDownload?: boolean;

  /** 越界值由服务侧夹到 1~365，不在这里打回，与已验收的 mock 行为一致 */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'expireDays 必须是整数天数' })
  expireDays?: number;
}

export class ListShareLinkDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'album 必须是相册 ID' })
  @Min(1)
  album?: number;

  @IsOptional()
  @Transform(({ value }) => value === true || value === '1' || value === 1)
  onlyAlive?: boolean;
}

export class UnlockShareDto {
  @Transform(trim)
  @IsString()
  @MaxLength(64, { message: '访问密码不得超过 64 字' })
  password: string;
}
