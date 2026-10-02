import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** 客户端算出来的 MD5 只用于校验完整性与查重，格式必须先卡死 */
export const MD5_HEX = /^[0-9a-f]{32}$/i;

const toBool = ({ value }: { value: unknown }): unknown =>
  value === true || value === 'true' || value === '1' || value === 1;

export class CreateUploadDto {
  @Type(() => Number)
  @IsInt({ message: 'albumId 必须是整数' })
  @Min(1)
  albumId: number;

  /** 原始文件名只入库用于展示与下载，绝不参与路径拼接 */
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'filename 不能为空' })
  @MaxLength(255)
  filename: string;

  /** 声明体积，单位字节；真实体积以服务端合并后的结果为准 */
  @Type(() => Number)
  @IsInt({ message: 'fileSize 必须是整数' })
  @Min(1)
  @Max(2_147_483_648)
  fileSize: number;

  @IsOptional()
  @Transform(trim)
  @Matches(MD5_HEX, { message: 'md5Client 必须是 32 位十六进制' })
  md5Client?: string;
}

export class CompleteUploadDto {
  /** 分片上传时客户端往往只能在全片齐后才算出 MD5，允许在这一步补传 */
  @IsOptional()
  @Transform(trim)
  @Matches(MD5_HEX, { message: 'md5Client 必须是 32 位十六进制' })
  md5Client?: string;

  /** 409「该图片你已上传过」之后，前端「仍要上传」置 true（PRD 4.3） */
  @IsOptional()
  @Transform(toBool)
  force?: boolean;
}

/** 小图直传：元数据走 query，字节走 raw body，避免为 5MB 再引入 multipart */
export class DirectUploadDto {
  @Type(() => Number)
  @IsInt({ message: 'albumId 必须是整数' })
  @Min(1)
  albumId: number;

  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'filename 不能为空' })
  @MaxLength(255)
  filename: string;

  @IsOptional()
  @Transform(trim)
  @Matches(MD5_HEX, { message: 'md5Client 必须是 32 位十六进制' })
  md5Client?: string;

  @IsOptional()
  @Transform(toBool)
  force?: boolean;
}
