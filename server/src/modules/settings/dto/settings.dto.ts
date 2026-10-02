import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
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
