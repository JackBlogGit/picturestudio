import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';

export class SettingItemDto {
  @IsString()
  @Length(1, 64)
  key: string;

  @IsString()
  @Length(0, 4000)
  value: string;

  /** 前端保存时不传备注，缺省由 setMany 落空串 */
  @IsOptional()
  @IsString()
  @Length(0, 255)
  remark?: string;
}

export class UpdateSettingsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SettingItemDto)
  entries: SettingItemDto[];
}
