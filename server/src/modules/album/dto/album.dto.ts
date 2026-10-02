import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { AlbumStatus } from '../../../entities';
import { Visibility } from '../../../common/enums/visibility.enum';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateAlbumDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: '相册名称不能为空' })
  @MaxLength(100)
  name: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  eventName?: string;

  @IsOptional()
  @IsDateString({}, { message: '漫展日期格式应为 YYYY-MM-DD' })
  eventDate?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(150)
  location?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsEnum(Visibility, { message: '可见范围取值不合法' })
  visibility?: Visibility;
}

export class UpdateAlbumDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: '相册名称不能为空' })
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  eventName?: string;

  @IsOptional()
  @IsDateString({}, { message: '漫展日期格式应为 YYYY-MM-DD' })
  eventDate?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(150)
  location?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsEnum(Visibility, { message: '可见范围取值不合法' })
  visibility?: Visibility;

  /** 封面必须从本相册已有图片里选（PRD 4.2） */
  @IsOptional()
  @IsInt()
  @Min(1)
  coverImgId?: number | null;
}

export class AlbumStatusDto {
  @IsEnum(AlbumStatus, { message: '状态只能是 1 正常 / 2 归档 / 3 锁定' })
  status: AlbumStatus;
}

/** 物理删除不可恢复，必须原样回填相册名（PRD 4.2 前端二次确认的服务端兜底） */
export class DeleteAlbumDto {
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  confirmName: string;
}

export class ListAlbumDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  keyword?: string;

  @IsOptional()
  @IsEnum(AlbumStatus)
  status?: AlbumStatus;

  /** 归档相册前台不展示，成员可显式带出 */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  includeArchived?: boolean;

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
