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

export enum TagType {
  Event = 'event',
  Coser = 'coser',
  Role = 'role',
  Photographer = 'photographer',
  Status = 'status',
}

export enum AlbumStatus {
  Normal = 1,
  Archived = 2,
  Locked = 3,
}

/** 阶段词汇：前期 = 拍展/原片初修，后期 = 精修/交付（PRD D31）。albums.stage 与 images.img_stage 共用它 */
export enum AlbumStage {
  Pre = 'pre',
  Post = 'post',
}

@Entity('albums')
@Index('idx_visibility_status', ['visibility', 'status'])
@Index('idx_create_uid', ['createUid'])
@Index('idx_parent', ['parentId'])
export class Album {
  @PrimaryGeneratedColumn()
  id: number;

  /** 父相册 ID，顶级相册为 NULL。仅超级管理员可创建子相册 */
  @Column({ type: 'int', nullable: true })
  parentId: number | null;

  @Column({ length: 100 })
  name: string;

  @Column({ length: 100, default: '' })
  eventName: string;

  @Column({ type: 'date', nullable: true })
  eventDate: string | null;

  @Column({ length: 150, default: '' })
  location: string;

  @Column({ length: 500, default: '' })
  description: string;

  /** 刻意不加外键：与 images.albumId 构成循环引用，级联删除会报错，由应用层回写 NULL */
  @Column({ type: 'int', nullable: true })
  coverImgId: number | null;

  @Column({ type: 'simple-enum', enum: Visibility, default: Visibility.Member })
  visibility: Visibility;

  @Column({ type: 'tinyint', default: AlbumStatus.Normal })
  status: AlbumStatus;

  @Column({ type: 'simple-enum', enum: AlbumStage, default: AlbumStage.Pre })
  stage: AlbumStage;

  /** D25：数组里出现即「关」，NULL / 空数组 = 本册全开；父关子也关的有效集在读取时沿 parent_id 往上并，不落库 */
  @Column({ type: 'json', nullable: true })
  albumCaps: string[] | null;

  @Column({ type: 'int' })
  createUid: number;

  @ManyToOne(() => User, (u) => u.albums, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'create_uid' })
  creator: User;

  /** 父相册（自关联） */
  @ManyToOne(() => Album, (a) => a.children, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'parent_id' })
  parent: Album | null;

  /** 子相册列表 */
  @OneToMany(() => Album, (a) => a.parent)
  children: Album[];

  @OneToMany(() => Image, (i) => i.album)
  images: Image[];

  @CreateDateColumn({ type: 'datetime' })
  createTime: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updateTime: Date;
}

@Entity('images')
@Index('idx_album_vis', ['albumId', 'visibility'])
@Index('idx_img_upload_uid', ['uploadUid'])
@Index('idx_img_md5', ['md5'])
@Index('idx_shot_time', ['shotTime'])
export class Image {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  albumId: number;

  @ManyToOne(() => Album, (a) => a.images, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'album_id' })
  album: Album;

  @Column({ length: 255 })
  originalPath: string;

  @Column({ length: 255 })
  previewPath: string;

  @Column({ length: 255, default: '' })
  thumbPath: string;

  @Column({ length: 255, default: '' })
  filename: string;

  @Column({ type: 'bigint', default: 0 })
  fileSize: string;

  @Column({ type: 'int', default: 0 })
  width: number;

  @Column({ type: 'int', default: 0 })
  height: number;

  @Column({ type: 'text', default: '' })
  md5: string;

  @Column({ type: 'datetime', nullable: true })
  shotTime: Date | null;

  @Column({ type: 'tinyint', default: 0 })
  watermarked: number;

  @Column({ type: 'simple-enum', enum: Visibility, default: Visibility.Member })
  visibility: Visibility;

  @Column({ type: 'int', default: 0 })
  sort: number;

  /** D31：NULL = 这张图没单独标过阶段，投影时回落到 albums.stage */
  @Column({ type: 'simple-enum', enum: AlbumStage, nullable: true })
  imgStage: AlbumStage | null;

  @Column({ type: 'int' })
  uploadUid: number;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'upload_uid' })
  uploader: User;

  @Column({ type: 'int', nullable: true })
  uploadTempId: number | null;

  @OneToMany(() => ImageTagMap, (m) => m.image, { cascade: true })
  tagMaps: ImageTagMap[];

  @CreateDateColumn({ type: 'datetime' })
  createTime: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updateTime: Date;
}

@Entity('tags')
@Index('uk_type_name', ['tagType', 'tagName'], { unique: true })
@Index('idx_type_count', ['tagType', 'useCount'])
export class Tag {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'simple-enum', enum: TagType })
  tagType: TagType;

  @Column({ length: 100 })
  tagName: string;

  @Column({ length: 100, default: '' })
  alias: string;

  @Column({ type: 'int', nullable: true })
  mergedInto: number | null;

  @Column({ type: 'int', default: 0 })
  useCount: number;

  @Column({ type: 'int', nullable: true })
  createUid: number | null;

  @OneToMany(() => ImageTagMap, (m) => m.tag)
  imageMaps: ImageTagMap[];

  @CreateDateColumn({ type: 'datetime' })
  createTime: Date;
}

@Entity('image_tag_map')
@Index('uk_img_tag', ['imageId', 'tagId'], { unique: true })
@Index('idx_tag', ['tagId'])
export class ImageTagMap {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  imageId: number;

  @ManyToOne(() => Image, (i) => i.tagMaps, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'image_id' })
  image: Image;

  @Column({ type: 'int' })
  tagId: number;

  @ManyToOne(() => Tag, (t) => t.imageMaps, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tag_id' })
  tag: Tag;
}
