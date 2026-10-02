import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { Visibility } from '../../../common/enums/visibility.enum';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** 前端把多选筛选拼成 `tags=1,2,3`，这里拆成 ID 数组，非法值交给 IsInt 拒绝 */
const csvIds = ({ value }: { value: unknown }): unknown => {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value !== 'string') return value;
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '')
    .map(Number);
};

/** 单次批量上限 500 张（PRD 4.5） */
export const BATCH_MAX = 500;

/** PRD 4.4：类型之间 AND、同类型多值 OR，标签数上限防恶意拼超长 IN */
export class ListImageDto {
  @IsOptional()
  @Transform(csvIds)
  @IsArray()
  @ArrayMaxSize(20)
  @IsInt({ each: true, message: 'tags 必须是标签 ID' })
  @Min(1, { each: true })
  tags?: number[];

  /** 状态标签只对成员开放，非成员带上直接 403 */
  @IsOptional()
  @Transform(csvIds)
  @IsArray()
  @ArrayMaxSize(10)
  @IsInt({ each: true, message: 'status 必须是状态标签 ID' })
  @Min(1, { each: true })
  status?: number[];

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

export class UpdateImageDto {
  @IsOptional()
  @IsEnum(Visibility, { message: '可见范围取值不合法' })
  visibility?: Visibility;

  /** 无 EXIF 的截图 / 后期图由上传者补填，传 null 表示清空 */
  @IsOptional()
  @ValidateIf((o: UpdateImageDto) => o.shotTime !== null)
  @IsDateString({}, { message: '拍摄时间格式应为 YYYY-MM-DDTHH:mm:ss' })
  shotTime?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sort?: number;
}

export class BatchTagsDto {
  @ArrayNotEmpty({ message: 'imageIds 不能为空' })
  @IsArray()
  @ArrayMaxSize(BATCH_MAX)
  @IsInt({ each: true, message: 'imageIds 必须是图片 ID' })
  @Min(1, { each: true })
  imageIds: number[];

  /** 只做已存在标签的关联，输入即建走 /tags 与 /tags/suggest */
  @IsOptional()
  @Transform(csvIds)
  @IsArray()
  @ArrayMaxSize(20)
  @IsInt({ each: true, message: 'add 必须是标签 ID' })
  @Min(1, { each: true })
  add?: number[];

  @IsOptional()
  @Transform(csvIds)
  @IsArray()
  @ArrayMaxSize(20)
  @IsInt({ each: true, message: 'remove 必须是标签 ID' })
  @Min(1, { each: true })
  remove?: number[];
}

export class BatchVisibilityDto {
  @ArrayNotEmpty({ message: 'imageIds 不能为空' })
  @IsArray()
  @ArrayMaxSize(BATCH_MAX)
  @IsInt({ each: true, message: 'imageIds 必须是图片 ID' })
  @Min(1, { each: true })
  imageIds: number[];

  @IsEnum(Visibility, { message: '可见范围取值不合法' })
  visibility: Visibility;
}
