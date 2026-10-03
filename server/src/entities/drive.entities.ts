import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Visibility } from '../common/enums/visibility.enum';
import { User } from './account.entities';

/** 目录用途：网盘 12 条规则的判定全部挂在这一列（PRD 5.4） */
export enum FolderKind {
  /** 「工作室」：规则 2，需文件权限1 */
  Workspace = 'workspace',
  /** 「拍展」：规则 3，列表不显示，每个临时账号一个帐户ID 子目录 */
  Shoot = 'shoot',
  /** 「管理」：规则 4，需文件权限2 */
  Manage = 'manage',
  /** 个人共享文件夹：规则 1/5 需文件权限3 */
  Shared = 'shared',
  /** 私人文件夹：规则 6 由文件权限4 决定 */
  Personal = 'personal',
  /** 「爬虫」：规则 11，挂在超管私人文件夹下 */
  Crawler = 'crawler',
  /** 「垃圾箱」：规则 12，只有超管能读改 */
  Trash = 'trash',
}

@Entity('folders')
@Index('idx_path', ['path'])
@Index('idx_folder_parent', ['parentId'])
export class Folder {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', nullable: true })
  parentId: number | null;

  @ManyToOne(() => Folder, (f) => f.children, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'parent_id' })
  parent: Folder | null;

  @OneToMany(() => Folder, (f) => f.parent)
  children: Folder[];

  @Column({ length: 500, default: '/' })
  path: string;

  @Column({ type: 'tinyint', default: 1 })
  depth: number;

  @Column({ length: 100 })
  name: string;

  @Column({ length: 500, default: '' })
  description: string;

  @Column({ type: 'simple-enum', enum: FolderKind, default: FolderKind.Workspace })
  kind: FolderKind;

  /** 规则 1/6：共享／私人／拍展／爬虫目录的归属人，公共目录为 NULL */
  @Column({ type: 'int', nullable: true })
  ownerUid: number | null;

  /** 规则 12：被移进垃圾箱时的原上级目录，还原时移回这里 */
  @Column({ type: 'int', nullable: true })
  deletedFromId: number | null;

  @Column({ type: 'datetime', nullable: true })
  deletedAt: Date | null;

  @Column({ type: 'simple-enum', enum: Visibility, default: Visibility.Member })
  visibility: Visibility;

  @Column({ type: 'int' })
  createUid: number;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'create_uid' })
  creator: User;

  @OneToMany(() => File, (f) => f.folder)
  files: File[];

  @CreateDateColumn({ type: 'datetime' })
  createTime: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updateTime: Date;
}

@Entity('files')
@Index('idx_folder_vis', ['folderId', 'visibility'])
@Index('idx_file_upload_uid', ['uploadUid'])
@Index('idx_file_md5', ['md5'])
@Index('idx_temp_ref', ['tempAccountId', 'refStage'])
export class File {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  folderId: number;

  @ManyToOne(() => Folder, (f) => f.files, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'folder_id' })
  folder: Folder;

  @Column({ length: 255 })
  filename: string;

  @Column({ length: 255 })
  storagePath: string;

  @Column({ type: 'bigint' })
  fileSize: string;

  @Column({ length: 100, default: '' })
  mimeType: string;

  @Column({ type: 'text' })
  md5: string;

  @Column({ type: 'tinyint', default: 0 })
  previewStatus: number;

  @Column({ type: 'simple-enum', enum: Visibility, default: Visibility.Member })
  visibility: Visibility;

  @Column({ type: 'int' })
  uploadUid: number;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'upload_uid' })
  uploader: User;

  @Column({ type: 'int', nullable: true })
  uploadTempId: number | null;

  /** 非 NULL = 该文件属于某条返图工单的附件；无外键，与附录 A 一致 */
  @Column({ type: 'int', nullable: true })
  tempAccountId: number | null;

  @Column({ type: 'varchar', length: 8, nullable: true })
  refStage: string | null;

  /** 规则 12：进垃圾箱前的原目录，还原时移回这里 */
  @Column({ type: 'int', nullable: true })
  deletedFromId: number | null;

  @Column({ type: 'datetime', nullable: true })
  deletedAt: Date | null;

  @CreateDateColumn({ type: 'datetime' })
  createTime: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updateTime: Date;
}
