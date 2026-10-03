import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './account.entities';
import { Album, AlbumStage } from './photo.entities';

@Entity('site_settings')
export class SiteSetting {
  @PrimaryColumn({ name: 'skey', length: 64 })
  key: string;

  @Column({ name: 'sval', type: 'text' })
  value: string;

  @Column({ length: 255, default: '' })
  remark: string;

  @Column({ type: 'int', nullable: true })
  updateUid: number | null;

  @UpdateDateColumn({ type: 'datetime' })
  updateTime: Date;
}

export enum UploadResourceType {
  Image = 'image',
  File = 'file',
}

@Entity('upload_sessions')
@Index('uk_upload_id', ['uploadId'], { unique: true })
@Index('idx_session_expire', ['status', 'expireTime'])
export class UploadSession {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 64 })
  uploadId: string;

  @Column({ type: 'simple-enum', enum: UploadResourceType })
  resourceType: UploadResourceType;

  @Column({ type: 'int', nullable: true })
  albumId: number | null;

  @Column({ type: 'int', nullable: true })
  folderId: number | null;

  @Column({ length: 255 })
  filename: string;

  /** D31：本批图片的阶段，NULL = 上传时没选，落库时回落到 albums.stage */
  @Column({ type: 'simple-enum', enum: AlbumStage, nullable: true })
  stage: AlbumStage | null;

  @Column({ type: 'bigint' })
  fileSize: string;

  @Column({ type: 'int', default: 5242880 })
  chunkSize: number;

  @Column({ type: 'int', default: 0 })
  totalChunks: number;

  @Column({ length: 2000, default: '' })
  uploadedChunks: string;

  @Column({ type: 'text', default: '' })
  md5Client: string;

  @Column({ type: 'simple-enum', enum: ['user', 'temp'] })
  userType: 'user' | 'temp';

  @Column({ type: 'int', nullable: true })
  uid: number | null;

  @Column({ type: 'int', nullable: true })
  tempId: number | null;

  /** 0进行中 1已完成 2已放弃 */
  @Column({ type: 'tinyint', default: 0 })
  status: number;

  @Column({ type: 'datetime' })
  expireTime: Date;

  @CreateDateColumn({ type: 'datetime' })
  createTime: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updateTime: Date;
}

export enum MessageStatus {
  Pending = 0,
  Approved = 1,
  Rejected = 2,
}

@Entity('guestbook_messages')
@Index('idx_status_time', ['status', 'createTime'])
export class GuestbookMessage {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 50, default: '' })
  nickname: string;

  @Column({ length: 100, default: '' })
  contact: string;

  @Column({ length: 1000 })
  content: string;

  @Column({ type: 'int', nullable: true })
  albumId: number | null;

  @ManyToOne(() => Album, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'album_id' })
  album: Album | null;

  @Column({ type: 'tinyint', default: MessageStatus.Pending })
  status: MessageStatus;

  @Column({ type: 'int', nullable: true })
  auditUid: number | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'audit_uid' })
  auditor: User | null;

  @Column({ type: 'datetime', nullable: true })
  auditTime: Date | null;

  @Column({ length: 50, default: '' })
  ip: string;

  @CreateDateColumn({ type: 'datetime' })
  createTime: Date;
}

export type LogUserType = 'user' | 'temp' | 'guest' | 'system';

export enum LogTargetType {
  Album = 'album',
  Image = 'image',
  File = 'file',
  Folder = 'folder',
  Tag = 'tag',
  User = 'user',
  Temp = 'temp',
  Site = 'site',
  Link = 'link',
  Message = 'message',
  Crawler = 'crawler',
}

/** uid/temp_id/target_id 刻意不加外键：审计记录必须比业务数据活得更久 */
@Entity('logs')
@Index('idx_time', ['createTime'])
@Index('idx_uid_time', ['userType', 'uid', 'createTime'])
@Index('idx_target', ['targetType', 'targetId'])
@Index('idx_action_time', ['action', 'createTime'])
export class AuditLog {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'simple-enum', enum: ['user', 'temp', 'guest', 'system'] })
  userType: LogUserType;

  @Column({ type: 'int', nullable: true })
  uid: number | null;

  @Column({ type: 'int', nullable: true })
  tempId: number | null;

  @Column({ length: 50 })
  action: string;

  @Column({ type: 'simple-enum', enum: LogTargetType, nullable: true })
  targetType: LogTargetType | null;

  @Column({ type: 'int', nullable: true })
  targetId: number | null;

  @Column({ length: 500, default: '' })
  detail: string;

  @Column({ length: 50 })
  ip: string;

  @Column({ length: 255, default: '' })
  ua: string;

  /** 1成功 0被拦截 */
  @Column({ type: 'tinyint', default: 1 })
  result: number;

  @CreateDateColumn({ type: 'datetime' })
  createTime: Date;
}
