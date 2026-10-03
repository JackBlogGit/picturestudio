import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
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

/** 0/1 开关：前端传布尔也接，落库存 tinyint */
const toFlag = ({ value }: { value: unknown }): number | unknown => {
  if (value === true || value === 1 || value === '1' || value === 'true') return 1;
  if (value === false || value === 0 || value === '0' || value === 'false') return 0;
  return value;
};

const FLAG_VALUES = [0, 1];

/** PRD 6.2 的 3 个开关，键名与实体列一一对应（D27：上传两开关作废，临时账号只能取图） */
export const TEMP_FLAG_FIELDS = [
  'allowPreview',
  'allowDownload',
  'allowEditTag',
] as const;
export type TempFlagField = (typeof TEMP_FLAG_FIELDS)[number];

/** 后期前参考图上限（PRD 6.2「0–9 张」） */
export const MAX_PRE_REFS = 9;

export class CreateTempAccountDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: '昵称不能为空' })
  @MaxLength(100)
  displayName: string;

  /** 可空：帐户ID 本身就能替代登录名（PRD 6.2） */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  loginName?: string;

  /** 不设密码 = 只走一次性专属链接；两者皆空由服务内拦（「至少配一种」） */
  @IsOptional()
  @IsString()
  @MinLength(8, { message: '密码至少 8 位' })
  @MaxLength(64)
  password?: string;

  /** 一次性专属链接：不传则不生成，避免任何账号都自带一条可外传的 URL */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === 1 || value === '1')
  @IsBoolean()
  wantLink?: boolean;

  @IsOptional()
  @Transform(trim)
  @Matches(/^1[3-9]\d{9}$/, { message: '手机号格式不正确' })
  phone?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  shootingNote?: string;

  /** days 与 validUntil 二选一，服务内折算成 expire_time 绝对时刻 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  days?: number;

  @IsOptional()
  @IsDateString({}, { message: '自定义截止时间格式不合法' })
  validUntil?: string;

  /** 配额字节；L1/L2 传入任何值都会被站点配置覆盖（D9） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  spaceQuota?: number;

  @IsOptional()
  @Transform(toFlag)
  @IsIn(FLAG_VALUES)
  allowPreview?: number;

  @IsOptional()
  @Transform(toFlag)
  @IsIn(FLAG_VALUES)
  allowDownload?: number;

  @IsOptional()
  @Transform(toFlag)
  @IsIn(FLAG_VALUES)
  allowEditTag?: number;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  albumIds?: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  folderIds?: number[];

  /** 后期前效果参考图：先走网盘拿到 file_id，再随表单提交 */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PRE_REFS, { message: `参考图最多 ${MAX_PRE_REFS} 张` })
  @IsInt({ each: true })
  preRefs?: number[];
}

/** 列表查询：管理员需要按状态与归属翻找 */
export class ListTempAccountDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  q?: string;

  /** 1 = 只看已注销 */
  @IsOptional()
  @Transform(toFlag)
  @IsIn(FLAG_VALUES)
  disabled?: number;

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
