export * from './account.entities';
export * from './photo.entities';
export * from './share.entities';
export * from './drive.entities';
export * from './system.entities';
export * from './crawler.entities';

import {
  TempAccount,
  TempAccountAlbum,
  TempAccountFolder,
  User,
} from './account.entities';
import { Album, Image, ImageTagMap, Tag } from './photo.entities';
import { CoserShareLink, ShareLinkImage } from './share.entities';
import { File, Folder } from './drive.entities';
import {
  AuditLog,
  GuestbookMessage,
  SiteSetting,
  UploadSession,
} from './system.entities';
import { CrawlerLink } from './crawler.entities';

export const ALL_ENTITIES = [
  User,
  TempAccount,
  TempAccountAlbum,
  TempAccountFolder,
  Album,
  Image,
  Tag,
  ImageTagMap,
  CoserShareLink,
  ShareLinkImage,
  Folder,
  File,
  SiteSetting,
  UploadSession,
  GuestbookMessage,
  AuditLog,
  CrawlerLink,
];
