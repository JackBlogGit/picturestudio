import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { TagType } from '../../../entities';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const toBool = ({ value }: { value: unknown }): boolean =>
  value === true || value === 'true' || value === '1';

export class SuggestTagDto {
  @IsOptional()
  @IsEnum(TagType, { message: '标签类型不合法' })
  type?: TagType;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class ListTagDto {
  @IsOptional()
  @IsEnum(TagType)
  type?: TagType;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  keyword?: string;

  /** 默认隐藏已合并的停用标签 */
  @IsOptional()
  @Transform(toBool)
  includeMerged?: boolean;
}

export class CreateTagDto {
  @IsEnum(TagType, { message: '标签类型不合法' })
  type: TagType;

  @Transform(trim)
  @IsString()
  @MinLength(1, { message: '标签名不能为空' })
  @MaxLength(100)
  name: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  alias?: string;
}

export class RenameTagDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: '标签名不能为空' })
  @MaxLength(100)
  name: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  alias?: string;
}

export class MergeTagDto {
  @IsInt()
  @Min(1)
  targetId: number;
}
