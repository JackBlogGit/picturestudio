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
} from 'typeorm';
import { Album, Image } from './photo.entities';
import { User } from './account.entities';

@Entity('coser_share_links')
@Index('idx_album_coser', ['albumId', 'coserTagId'])
@Index('idx_expire', ['expireTime', 'revoked'])
export class CoserShareLink {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 128, unique: true })
  shareToken: string;

  @Column({ type: 'int' })
  albumId: number;

  @ManyToOne(() => Album, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'album_id' })
  album: Album;

  @Column({ type: 'int', nullable: true })
  coserTagId: number | null;

  @Column({ type: 'json', nullable: true })
  filterJson: Record<string, unknown> | null;

  @Column({ type: 'tinyint', default: 0 })
  snapshot: number;

  @Column({ type: 'varchar', length: 100, nullable: true, select: false })
  password: string | null;

  @Column({ type: 'tinyint', default: 0 })
  allowDownload: number;

  @Column({ type: 'int', default: 0 })
  visitCount: number;

  @Column({ type: 'datetime' })
  expireTime: Date;

  @Column({ type: 'tinyint', default: 0 })
  revoked: number;

  @Column({ type: 'int' })
  createUid: number;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'create_uid' })
  creator: User;

  @Column({ type: 'datetime', nullable: true })
  lastVisitTime: Date | null;

  @CreateDateColumn({ type: 'datetime' })
  createTime: Date;

  @OneToMany(() => ShareLinkImage, (r) => r.link, { cascade: true })
  images: ShareLinkImage[];
}

/** DDL 是复合主键 (link_id, image_id)，没有自增 id 列 */
@Entity('share_link_images')
@Index('idx_image', ['imageId'])
export class ShareLinkImage {
  @PrimaryColumn({ type: 'int' })
  linkId: number;

  @ManyToOne(() => CoserShareLink, (l) => l.images, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'link_id' })
  link: CoserShareLink;

  @PrimaryColumn({ type: 'int' })
  imageId: number;

  @ManyToOne(() => Image, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'image_id' })
  image: Image;

  @Column({ type: 'int', default: 0 })
  sort: number;
}
