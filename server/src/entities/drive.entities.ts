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

  @CreateDateColumn({ type: 'datetime' })
  createTime: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updateTime: Date;
}
