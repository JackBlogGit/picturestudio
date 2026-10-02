import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream, promises as fsp } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { resolveInside } from './storage-path';

export interface StoredFile {
  stream: Readable;
  size: number;
}

/**
 * 存储根目录的一切读写出口。约定：
 * - 对外只接受「相对路径」，且必须经 resolveInside 校验，物理上不可能写到 root 之外；
 * - 写入先落 .part 再 rename，避免读到一个写了一半的文件；
 * - 删除一律吞 ENOENT，因为清理是幂等的（重复删、级联删都常见）。
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  readonly root: string;

  constructor(config: ConfigService) {
    this.root = config.getOrThrow<string>('app.storageRoot');
  }

  abs(rel: string): string {
    return resolveInside(this.root, rel);
  }

  async write(rel: string, data: Buffer): Promise<number> {
    const abs = this.abs(rel);
    await fsp.mkdir(dirname(abs), { recursive: true });
    const part = `${abs}.part`;
    await fsp.writeFile(part, data);
    await fsp.rename(part, abs);
    return data.length;
  }

  async read(rel: string): Promise<StoredFile> {
    const abs = this.abs(rel);
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) throw new Error(`不是普通文件：${rel}`);
    return { stream: createReadStream(abs), size: stat.size };
  }

  /** 派生图与魔数校验都要拿到字节，sharp/exifr 的入参是 Buffer */
  async buffer(rel: string): Promise<Buffer> {
    return fsp.readFile(this.abs(rel));
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await fsp.access(this.abs(rel));
      return true;
    } catch {
      return false;
    }
  }

  async size(rel: string): Promise<number> {
    try {
      return (await fsp.stat(this.abs(rel))).size;
    } catch {
      return -1;
    }
  }

  /** 同一存储根内改名，用于把临时区产物提升到正式目录 */
  async move(fromRel: string, toRel: string): Promise<void> {
    const to = this.abs(toRel);
    await fsp.mkdir(dirname(to), { recursive: true });
    await fsp.rename(this.abs(fromRel), to);
  }

  /**
   * 顺序合并分片。一次只读一片，绝不把整个上传体量装进内存；
   * sink 让调用方能在合并的同时算 MD5（PRD 5.3），返回值是合并后的总字节数。
   */
  async concat(targetRel: string, sourceRels: string[], sink?: (chunk: Buffer) => void): Promise<number> {
    const target = this.abs(targetRel);
    const sources = sourceRels.map((rel) => this.abs(rel));
    await fsp.mkdir(dirname(target), { recursive: true });
    const part = `${target}.part`;
    const handle = await fsp.open(part, 'w');
    let total = 0;
    try {
      for (const src of sources) {
        const chunk = await fsp.readFile(src);
        total += chunk.length;
        await handle.writeFile(chunk);
        sink?.(chunk);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(part, target);
    return total;
  }

  async remove(...rels: Array<string | null | undefined>): Promise<void> {
    for (const rel of rels) {
      if (!rel) continue;
      try {
        await fsp.unlink(this.abs(rel));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') this.logger.warn(`删除失败 ${rel}：${(err as Error).message}`);
      }
    }
  }

  /** 递归删目录（分片临时区），目录不存在视为成功 */
  async removeTree(relDir: string): Promise<void> {
    try {
      await fsp.rm(this.abs(relDir), { recursive: true, force: true });
    } catch (err) {
      this.logger.warn(`清理目录失败 ${relDir}：${(err as Error).message}`);
    }
  }
}
