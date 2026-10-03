import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserLevel } from '../common/enums/user-level.enum';
import { Album } from './photo.entities';
import { Folder } from './drive.entities';

@Entity('users')
@Index('idx_level_status', ['level', 'status'])
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 50, unique: true })
  username: string;

  @Column({ length: 100, select: false })
  password: string;

  @Column({ length: 50, default: '' })
  nickname: string;

  /** 8.5 顶栏欢迎语「你好！{名称} · {职务}」，缺失时前端退化成只显示名称 */
  @Column({ length: 50, default: '' })
  position: string;

  @Column({ type: 'tinyint' })
  level: UserLevel;

  /** bigint 经 mysql2 返回字符串，参与运算前必须 Number()/BigInt() 转换 */
  @Column({ type: 'bigint', default: 0 })
  spaceQuota: string;

  @Column({ type: 'bigint', default: 0 })
  usedSpace: string;

  @Column({ type: 'tinyint', default: 1 })
  status: number;

  @Column({ length: 255, default: '' })
  remark: string;

  /**
   * D20 个人文件权限授权：四档各自 1=开。判定是 `level >= 全站门槛 ∨ 本列 = 1` 取并集，
   * 门槛填 5 时也能只对一个人敞开；只有 L4 能写，撤销不回收已建的目录。
   */
  @Column({ type: 'tinyint', default: 0 })
  drivePerm1: number;

  @Column({ type: 'tinyint', default: 0 })
  drivePerm2: number;

  @Column({ type: 'tinyint', default: 0 })
  drivePerm3: number;

  @Column({ type: 'tinyint', default: 0 })
  drivePerm4: number;

  /** D21 按人的能力位覆盖：{"download":1,"editAny":0}，1 强制开 / 0 强制关，缺键=跟随等级，NULL=全部跟随 */
  @Column({ type: 'json', nullable: true })
  featureGrants: Record<string, number> | null;

  @Column({ type: 'datetime', nullable: true })
  lastLoginTime: Date | null;

  @CreateDateColumn({ type: 'datetime' })
  createTime: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updateTime: Date;

  @OneToMany(() => Album, (a) => a.creator)
  albums: Album[];
}

@Entity('temp_accounts')
@Index('idx_owner', ['ownerUid'])
@Index('idx_temp_expire', ['expireTime', 'disabled'])
@Index('uk_account_no', ['accountNo'], { unique: true })
@Index('idx_stage_query', ['disabled', 'preStage', 'postStage', 'createTime'])
export class TempAccount {
  @PrimaryGeneratedColumn()
  id: number;

  /** YK + 6 位随机码，全局唯一且可替代 loginName 登录（PRD 6.2） */
  @Column({ length: 16 })
  accountNo: string;

  @Column({ type: 'varchar', length: 128, nullable: true, unique: true })
  accessToken: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true, unique: true })
  loginName: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, select: false })
  password: string | null;

  @Column({ length: 100, default: '' })
  displayName: string;

  /** PII：仅 owner 与 L3/L4 可见完整值，任何响应与 logs 都要脱敏 */
  @Column({ type: 'varchar', length: 16, nullable: true })
  phone: string | null;

  @Column({ length: 500, default: '' })
  shootingNote: string;

  @Column({ type: 'datetime' })
  expireTime: Date;

  @Column({ type: 'tinyint', default: 1 })
  allowPreview: number;

  @Column({ type: 'tinyint', default: 0 })
  allowDownload: number;

  @Column({ type: 'tinyint', default: 0 })
  allowEditTag: number;

  @Column({ type: 'bigint', default: 0 })
  spaceQuota: string;

  @Column({ type: 'bigint', default: 0 })
  usedSpace: string;

  @Column({ type: 'tinyint', default: 0 })
  disabled: number;

  @Column({ type: 'int' })
  ownerUid: number;

  /** 前期修图 0未完成 1已完成（PRD 17.2） */
  @Column({ type: 'tinyint', default: 0 })
  preStage: number;

  /** 后期返图 0未完成 1已完成（PRD 17.2） */
  @Column({ type: 'tinyint', default: 0 })
  postStage: number;

  @Column({ type: 'datetime', nullable: true })
  preDoneTime: Date | null;

  @Column({ type: 'datetime', nullable: true })
  postDoneTime: Date | null;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'owner_uid' })
  owner: User;

  @CreateDateColumn({ type: 'datetime' })
  createTime: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updateTime: Date;

  @OneToMany(() => TempAccountAlbum, (r) => r.tempAccount, { cascade: true })
  albumGrants: TempAccountAlbum[];

  @OneToMany(() => TempAccountFolder, (r) => r.tempAccount, { cascade: true })
  folderGrants: TempAccountFolder[];
}

/** DDL 是复合主键 (temp_id, album_id)，没有自增 id 列 */
@Entity('temp_account_albums')
export class TempAccountAlbum {
  @PrimaryColumn({ type: 'int' })
  tempId: number;

  @PrimaryColumn({ type: 'int' })
  albumId: number;

  @ManyToOne(() => TempAccount, (t) => t.albumGrants, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'temp_id' })
  tempAccount: TempAccount;

  @ManyToOne(() => Album, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'album_id' })
  album: Album;
}

/** DDL 是复合主键 (temp_id, folder_id)，没有自增 id 列 */
@Entity('temp_account_folders')
export class TempAccountFolder {
  @PrimaryColumn({ type: 'int' })
  tempId: number;

  @PrimaryColumn({ type: 'int' })
  folderId: number;

  @ManyToOne(() => TempAccount, (t) => t.folderGrants, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'temp_id' })
  tempAccount: TempAccount;

  @ManyToOne(() => Folder, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'folder_id' })
  folder: Folder;
}
