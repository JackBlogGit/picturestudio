import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve, sep } from 'node:path';

/** PRD 第 9 章存储目录约定；DB 一律存相对路径，换机器只需搬目录 + 改 STORAGE_ROOT */
export const DIR_ORIGINALS = 'originals';
export const DIR_PREVIEW = 'derived/preview';
export const DIR_THUMB = 'derived/thumb';
export const DIR_CHUNK = 'tmp/chunk';
export const DIR_DERIVE = 'tmp/derive';

export type DerivedKind = 'preview' | 'thumb';

const SAFE_EXT = /^[a-z0-9]{1,8}$/;
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 扩展名只允许来自 magic bytes 的结果，绝不来自客户端文件名 */
export function safeExt(input: string): string {
  const ext = (input ?? '').toLowerCase().replace(/^\./, '');
  return SAFE_EXT.test(ext) ? ext : 'bin';
}

export function newUploadId(): string {
  return randomUUID();
}

export function isUploadId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_UUID.test(value);
}

/** 原图/原文件：originals/YYYY/MM/<uuid>.<ext> */
export function originalKey(ext: string, now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${DIR_ORIGINALS}/${y}/${m}/${randomUUID()}.${safeExt(ext)}`;
}

/** 派生图按 image_id 固定命名，重新生成水印时原地覆盖，不产生孤儿文件 */
export function derivedKey(imageId: number, kind: DerivedKind): string {
  if (!Number.isInteger(imageId) || imageId <= 0) {
    throw new Error(`派生图 id 非法：${String(imageId)}`);
  }
  return `${kind === 'preview' ? DIR_PREVIEW : DIR_THUMB}/${imageId}.webp`;
}

export function chunkKey(uploadId: string, index: number): string {
  if (!isUploadId(uploadId) || !Number.isInteger(index) || index < 0) {
    throw new Error('分片路径参数非法');
  }
  return `${DIR_CHUNK}/${uploadId}/${index}`;
}

/** 合并中的临时产物；name 只允许代码里写死的字面量 */
export function stagingKey(uploadId: string, name: string): string {
  if (!isUploadId(uploadId) || !/^[a-z0-9.]{1,40}$/.test(name)) {
    throw new Error('临时产物路径参数非法');
  }
  return `${DIR_DERIVE}/${uploadId}/${name}`;
}

/**
 * 一切可能来自请求或数据库的路径都要过这道闸。
 * 越界即抛，宁可 500 也不能把 storageRoot 之外的文件读出去。
 */
export function resolveInside(root: string, rel: string): string {
  const cleaned = (rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned || isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel) || cleaned.split('/').includes('..')) {
    throw new Error(`非法存储路径：${String(rel)}`);
  }
  const rootAbs = resolve(root);
  const abs = resolve(join(rootAbs, cleaned));
  if (abs === rootAbs || !abs.startsWith(rootAbs + sep)) {
    throw new Error(`存储路径越界：${String(rel)}`);
  }
  return abs;
}
