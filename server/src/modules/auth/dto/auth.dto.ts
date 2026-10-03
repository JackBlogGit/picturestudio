import { IsOptional, IsString, Length, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class LoginDto {
  @IsString()
  @Length(2, 50)
  @Matches(/^[A-Za-z0-9_.@-]+$/, { message: '账号只能包含字母、数字与 _ . @ -' })
  username: string;

  @IsString()
  @Length(1, 100)
  password: string;
}

export class TempLinkDto {
  @IsString()
  @Length(8, 128)
  accessToken: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  password?: string;
}

export class ChangePasswordDto {
  @IsString()
  @Length(1, 100)
  oldPassword: string;

  @IsString()
  @Length(8, 100)
  newPassword: string;
}

/** 销毁不可逆（D15），必须回传帐户ID 后 6 位；比对在服务内做 */
export class TempDestroyDto {
  @Transform(trim)
  @IsString()
  @Length(1, 16)
  accountTail: string;
}
