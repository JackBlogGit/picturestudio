import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Album, File, Folder, TempAccount, TempAccountAlbum, TempAccountFolder, User } from '../../entities';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { TempAccountController } from './temp-account.controller';
import { TempAccountService } from './temp-account.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TempAccount,
      TempAccountAlbum,
      TempAccountFolder,
      Album,
      Folder,
      File,
      User,
    ]),
    AuthModule,
    SettingsModule,
  ],
  controllers: [TempAccountController],
  providers: [TempAccountService],
  exports: [TempAccountService],
})
export class TempAccountModule {}
