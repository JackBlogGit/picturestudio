import { Injectable, Logger } from '@nestjs/common';
import exifr from 'exifr';
import sharp, { type Gravity } from 'sharp';
import { SettingsService } from '../../modules/settings/settings.service';

export interface SourceInfo {
  width: number;
  height: number;
  shotTime: Date | null;
  /** 原图本身无法解码（RAW），派生图来自嵌入预览 */
  fromEmbeddedPreview: boolean;
}

export interface Derivatives {
  preview: Buffer;
  thumb: Buffer;
  watermarked: 0 | 1;
}

const WATERMARK_POSITIONS: Record<string, Gravity> = {
  topLeft: 'northwest',
  topRight: 'northeast',
  bottomLeft: 'southwest',
  bottomRight: 'southeast',
  center: 'center',
};

/** EXIF orientation 5~8 是 90° 旋转，显示宽高要互换，否则手机竖拍会存成横图 */
export function displayedSize(meta: {
  width?: number;
  height?: number;
  orientation?: number;
}): { width: number; height: number } {
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const rotated = meta.orientation !== undefined && meta.orientation >= 5 && meta.orientation <= 8;
  return rotated ? { width: height, height: width } : { width, height };
}

/** 水印文字来自站点配置，仍要转义，避免一个 & 就把整张图打挂 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function watermarkGravity(position: string): Gravity {
  return WATERMARK_POSITIONS[position] ?? 'southeast';
}

@Injectable()
export class DerivativeService {
  private readonly logger = new Logger(DerivativeService.name);

  constructor(private readonly settings: SettingsService) {}

  /** PRD 4.3：自动读 EXIF DateTimeOriginal，读不到留空由上传者补填 */
  async readShotTime(source: Buffer): Promise<Date | null> {
    try {
      const parsed = (await exifr.parse(source, ['DateTimeOriginal'])) as
        | { DateTimeOriginal?: Date }
        | undefined;
      const value = parsed?.DateTimeOriginal;
      return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
    } catch (err) {
      this.logger.debug(`EXIF 解析失败：${(err as Error).message}`);
      return null;
    }
  }

  /**
   * 探测原图尺寸。sharp 读不动的 RAW 走 exifr 头信息 + 嵌入 JPEG 预览回退，
   * 回退成功时把可用于派生的 buffer 一起返回。
   */
  async probe(source: Buffer): Promise<{ info: SourceInfo; renderable: Buffer | null }> {
    try {
      const meta = await sharp(source, { failOn: 'none' }).metadata();
      const size = displayedSize(meta);
      return {
        info: { ...size, shotTime: await this.readShotTime(source), fromEmbeddedPreview: false },
        renderable: source,
      };
    } catch (err) {
      this.logger.debug(`原图无法直接解码，尝试嵌入预览：${(err as Error).message}`);
    }

    const embedded = await this.embeddedPreview(source);
    if (embedded) {
      const meta = await sharp(embedded).metadata();
      return {
        info: {
          ...displayedSize(meta),
          shotTime: await this.readShotTime(source),
          fromEmbeddedPreview: true,
        },
        renderable: embedded,
      };
    }
    const exif = await this.exifSize(source);
    return {
      info: { width: exif.width, height: exif.height, shotTime: exif.shotTime, fromEmbeddedPreview: false },
      renderable: null,
    };
  }

  /** 生成预览图与缩略图；两者都带水印，原图永不修改（PRD 4.3 / D7） */
  async render(renderable: Buffer | null): Promise<Derivatives> {
    const previewWidth = this.settings.getNumber('preview.max_width', 2048);
    const thumbWidth = this.settings.getNumber('preview.thumb_width', 400);
    const quality = this.settings.getNumber('preview.quality', 82);
    const watermark = this.buildWatermark();

    const preview = await this.resizeTo(renderable, previewWidth, quality, watermark);
    const thumb = await this.resizeTo(
      renderable,
      Math.min(thumbWidth, previewWidth),
      quality,
      watermark,
    );
    return { preview, thumb, watermarked: watermark ? 1 : 0 };
  }

  /** 批量重新生成水印用同一套参数，不读原图尺寸 */
  async regenerate(source: Buffer): Promise<Derivatives | null> {
    const { info, renderable } = await this.probe(source);
    if (!renderable || !info.width || !info.height) return null;
    return this.render(renderable);
  }

  private async resizeTo(
    source: Buffer | null,
    longEdge: number,
    quality: number,
    watermark: Buffer | null,
  ): Promise<Buffer> {
    const edge = Math.max(Math.trunc(longEdge) || 1, 16);
    if (!source) return DerivativeService.placeholder(edge);

    const base = sharp(source, { failOn: 'none' }).rotate();
    const pipeline = base.resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true });
    if (watermark) {
      pipeline.composite([{ input: watermark, gravity: watermarkGravity(this.settings.getString('watermark.position', 'bottomRight')) }]);
    }
    try {
      return await pipeline.webp({ quality: Math.min(Math.max(quality, 1), 100) }).toBuffer();
    } catch (err) {
      this.logger.warn(`派生图生成失败，回退占位图：${(err as Error).message}`);
      return DerivativeService.placeholder(edge);
    }
  }

  private buildWatermark(): Buffer | null {
    if (!this.settings.getBoolean('watermark.enabled', false)) return null;
    const text = this.settings.getString('watermark.text', '皮克社工作室').trim();
    if (!text) return null;
    const opacity = Math.min(Math.max(this.settings.getNumber('watermark.opacity', 0.35), 0.05), 1);
    const canvas = 512;
    const fontSize = 64;
    const width = Math.min(canvas, Math.max(text.length * fontSize, fontSize * 2));
    const svg =
      `<svg width="${width}" height="${fontSize * 2}" xmlns="http://www.w3.org/2000/svg">` +
      `<text x="8" y="${fontSize * 1.4}" font-size="${fontSize}" font-family="sans-serif" ` +
      `fill="#ffffff" fill-opacity="${opacity}">${escapeXml(text)}</text></svg>`;
    return Buffer.from(svg, 'utf8');
  }

  private async embeddedPreview(source: Buffer): Promise<Buffer | null> {
    try {
      const thumb = (await exifr.thumbnail(source)) as ArrayBuffer | Uint8Array | undefined;
      if (!thumb) return null;
      const buffer = Buffer.isBuffer(thumb)
        ? thumb
        : Buffer.from(thumb instanceof Uint8Array ? thumb : new Uint8Array(thumb));
      if (buffer.length < 1024) return null;
      const meta = await sharp(buffer).metadata();
      return meta.width && meta.height ? buffer : null;
    } catch (err) {
      this.logger.debug(`嵌入预览不可用：${(err as Error).message}`);
      return null;
    }
  }

  private async exifSize(source: Buffer): Promise<{ width: number; height: number; shotTime: Date | null }> {
    try {
      const parsed = (await exifr.parse(source, ['DateTimeOriginal', 'ImageWidth', 'ImageHeight'])) as
        | { DateTimeOriginal?: Date; ImageWidth?: number; ImageHeight?: number }
        | undefined;
      return {
        width: Number(parsed?.ImageWidth ?? 0),
        height: Number(parsed?.ImageHeight ?? 0),
        shotTime: parsed?.DateTimeOriginal instanceof Date ? parsed.DateTimeOriginal : null,
      };
    } catch {
      return { width: 0, height: 0, shotTime: null };
    }
  }

  private static placeholder(edge: number): Promise<Buffer> {
    return sharp({
      create: { width: edge, height: Math.trunc(edge * 0.66), channels: 3, background: { r: 238, g: 238, b: 238 } },
    })
      .webp({ quality: 80 })
      .toBuffer();
  }
}
