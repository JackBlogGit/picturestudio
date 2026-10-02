import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Album, File, Folder, Image } from '../../entities';
import { Visibility } from '../enums/visibility.enum';
import { ResourceRef, ResourceType } from '../permission/types';

export interface FolderChain {
  ids: number[];
  /** 祖先链上除自身以外的档位，用于 3.2 继承上限 */
  ancestorVisibilities: Visibility[];
}

@Injectable()
export class ResourceLoader {
  constructor(
    @InjectRepository(Album) private readonly albums: Repository<Album>,
    @InjectRepository(Image) private readonly images: Repository<Image>,
    @InjectRepository(Folder) private readonly folders: Repository<Folder>,
    @InjectRepository(File) private readonly files: Repository<File>,
  ) {}

  async load(type: ResourceType, id: number): Promise<ResourceRef | null> {
    switch (type) {
      case ResourceType.Album: {
        const row = await this.albums.findOne({ where: { id } });
        if (!row) return null;
        return {
          type,
          id: row.id,
          visibility: row.visibility,
          ownerId: row.createUid,
          albumId: row.id,
          containerVisibilities: [],
        };
      }
      case ResourceType.Image: {
        const row = await this.images.findOne({ where: { id } });
        if (!row) return null;
        const album = await this.albums.findOne({ where: { id: row.albumId } });
        return {
          type,
          id: row.id,
          visibility: row.visibility,
          ownerId: row.uploadUid,
          albumId: row.albumId,
          uploadTempId: row.uploadTempId,
          containerVisibilities: album ? [album.visibility] : [],
        };
      }
      case ResourceType.Folder: {
        const row = await this.folders.findOne({ where: { id } });
        if (!row) return null;
        const chain = await this.resolveChain(row);
        return {
          type,
          id: row.id,
          visibility: row.visibility,
          ownerId: row.createUid,
          folderIdChain: chain.ids,
          containerVisibilities: chain.ancestorVisibilities,
        };
      }
      case ResourceType.File: {
        const row = await this.files.findOne({ where: { id } });
        if (!row) return null;
        const folder = await this.folders.findOne({ where: { id: row.folderId } });
        if (!folder) return null;
        const chain = await this.resolveChain(folder);
        return {
          type,
          id: row.id,
          visibility: row.visibility,
          ownerId: row.uploadUid,
          uploadTempId: row.uploadTempId,
          folderIdChain: chain.ids,
          containerVisibilities: [folder.visibility, ...chain.ancestorVisibilities],
        };
      }
    }
  }

  /** path 形如 /1/5/12/，末段是自身；祖先档位按由外到内排序 */
  private async resolveChain(folder: Folder): Promise<FolderChain> {
    const ids = folder.path.split('/').filter(Boolean).map(Number);
    const known = new Set(ids);
    if (!known.has(folder.id)) ids.push(folder.id);

    const ancestorIds = ids.filter((id) => id !== folder.id);
    const rows = ancestorIds.length
      ? await this.folders.find({
          where: { id: In(ancestorIds) },
          select: { id: true, visibility: true },
        })
      : [];
    const visById = new Map(rows.map((r) => [r.id, r.visibility]));

    return {
      ids,
      ancestorVisibilities: ancestorIds
        .map((id) => visById.get(id))
        .filter((v): v is Visibility => v !== undefined),
    };
  }
}
