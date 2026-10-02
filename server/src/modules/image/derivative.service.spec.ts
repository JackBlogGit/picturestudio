import sharp from 'sharp';
import { SettingsService } from '../../modules/settings/settings.service';
import {
  DerivativeService,
  displayedSize,
  escapeXml,
  watermarkGravity,
} from './derivative.service';

interface SettingValues {
  [key: string]: string;
}

function settings(values: SettingValues = {}): SettingsService {
  const get = (key: string, fallback: string): string => values[key] ?? fallback;
  return {
    getString: get,
    getNumber: (key: string, fallback: number) =>
      values[key] === undefined ? fallback : Number(values[key]),
    getBoolean: (key: string, fallback: boolean) =>
      values[key] === undefined ? fallback : values[key] === 'true',
    getJson: (key: string, fallback: unknown) => (values[key] ? JSON.parse(values[key]) : fallback),
  } as unknown as SettingsService;
}

async function jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 180, g: 40, b: 60 } },
  })
    .jpeg()
    .toBuffer();
}

/**
 * sharp 0.35 的 withExif 会静默丢掉自定义标签，实测写不出 DateTimeOriginal，
 * 所以这里手工拼一段最小 APP1/Exif 段，确保测的是 exifr 真实解析路径。
 */
function exifSegment(shootTime: string): Buffer {
  const text = Buffer.from(`${shootTime}\0`, 'ascii');
  const IFD0 = 8;
  const EXIF_IFD = 38;
  const TEXT_AT = 56;
  const tiff = Buffer.alloc(TEXT_AT + text.length);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(IFD0, 4);

  tiff.writeUInt16LE(2, IFD0);
  let p = IFD0 + 2;
  // Orientation = 1，顺带验证 probe 会尊重 EXIF 方向
  tiff.writeUInt16LE(0x0112, p);
  tiff.writeUInt16LE(3, p + 2);
  tiff.writeUInt32LE(1, p + 4);
  tiff.writeUInt32LE(1, p + 8);
  p += 12;
  tiff.writeUInt16LE(0x8769, p);
  tiff.writeUInt16LE(4, p + 2);
  tiff.writeUInt32LE(1, p + 4);
  tiff.writeUInt32LE(EXIF_IFD, p + 8);
  p += 12;
  tiff.writeUInt32LE(0, p);

  tiff.writeUInt16LE(1, EXIF_IFD);
  p = EXIF_IFD + 2;
  tiff.writeUInt16LE(0x9003, p); // DateTimeOriginal
  tiff.writeUInt16LE(2, p + 2); // ASCII
  tiff.writeUInt32LE(text.length, p + 4);
  tiff.writeUInt32LE(TEXT_AT, p + 8);
  p += 12;
  tiff.writeUInt32LE(0, p);
  text.copy(tiff, TEXT_AT);

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const segment = Buffer.alloc(4 + payload.length);
  segment.writeUInt16BE(0xffe1, 0);
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return segment;
}

async function jpegWithExif(shootTime: string): Promise<Buffer> {
  const base = await jpeg(640, 480);
  return Buffer.concat([base.subarray(0, 2), exifSegment(shootTime), base.subarray(2)]);
}

/** 平坦色块压不出质量差异，用伪随机噪声才能让 quality 影响体积 */
async function noisy(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  let seed = 12345;
  for (let i = 0; i < raw.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = seed & 0xff;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
}

describe('派生图纯逻辑', () => {
  it('orientation 5~8 互换显示宽高', () => {
    expect(displayedSize({ width: 4000, height: 3000, orientation: 6 })).toEqual({ width: 3000, height: 4000 });
    expect(displayedSize({ width: 4000, height: 3000, orientation: 1 })).toEqual({ width: 4000, height: 3000 });
    expect(displayedSize({ width: 4000, height: 3000 })).toEqual({ width: 4000, height: 3000 });
  });

  it('站点配置里的水印位置映射到 sharp gravity，未知值兜右下', () => {
    expect(watermarkGravity('bottomRight')).toBe('southeast');
    expect(watermarkGravity('topLeft')).toBe('northwest');
    expect(watermarkGravity('center')).toBe('center');
    expect(watermarkGravity('随便写的')).toBe('southeast');
  });

  it('水印文字里的 XML 特殊字符必须转义', () => {
    expect(escapeXml('皮克社 <A&B> "x"')).toBe('皮克社 &lt;A&amp;B&gt; &quot;x&quot;');
  });
});

describe('probe 原图探测', () => {
  it('读出宽高，无 EXIF 时 shotTime 留空', async () => {
    const service = new DerivativeService(settings());
    const { info, renderable } = await service.probe(await jpeg(3000, 2000));
    expect(info.width).toBe(3000);
    expect(info.height).toBe(2000);
    expect(info.shotTime).toBeNull();
    expect(info.fromEmbeddedPreview).toBe(false);
    expect(renderable).toBeInstanceOf(Buffer);
  });

  it('非图片字节既不抛异常也拿不到可派生源', async () => {
    const service = new DerivativeService(settings());
    const { info, renderable } = await service.probe(Buffer.from('这不是图片'));
    expect(renderable).toBeNull();
    expect(info.width).toBe(0);
    expect(info.height).toBe(0);
  });

  it('EXIF DateTimeOriginal 会被读成拍摄时间', async () => {
    const withExif = await jpegWithExif('2026:09:12 14:03:05');
    const service = new DerivativeService(settings());
    const { info } = await service.probe(withExif);
    expect(info.shotTime).toBeInstanceOf(Date);
    expect(info.shotTime?.getFullYear()).toBe(2026);
    // exifr 按本地时区解析裸时间戳，所以只要求落在同一自然日附近
    const wallClock = new Date(2026, 8, 12, 14, 3, 5).getTime();
    expect(Math.abs((info.shotTime as Date).getTime() - wallClock)).toBeLessThan(24 * 3600 * 1000);
  });
});

describe('render 预览与缩略', () => {
  it('默认不加水印，预览长边不超过 preview.max_width', async () => {
    const service = new DerivativeService(settings());
    const { info, renderable } = await service.probe(await jpeg(3000, 2000));
    const out = await service.render(renderable);

    expect(out.watermarked).toBe(0);
    const previewMeta = await sharp(out.preview).metadata();
    expect(previewMeta.format).toBe('webp');
    expect(Math.max(previewMeta.width ?? 0, previewMeta.height ?? 0)).toBe(2048);
    const thumbMeta = await sharp(out.thumb).metadata();
    expect(thumbMeta.width).toBe(400);
    expect(info.width).toBe(3000);
  });

  it('水印开启后 watermarked=1，且像素与不加水印时不同', async () => {
    const source = await jpeg(2600, 1500);
    const plain = await new DerivativeService(settings({ 'watermark.enabled': 'false' })).render(source);
    const marked = await new DerivativeService(
      settings({ 'watermark.enabled': 'true', 'watermark.text': '皮克社工作室', 'watermark.opacity': '0.6' }),
    ).render(source);

    expect(marked.watermarked).toBe(1);
    expect(plain.watermarked).toBe(0);
    expect(Buffer.compare(marked.preview, plain.preview)).not.toBe(0);
    expect((await sharp(marked.thumb).metadata()).width).toBe(400);
  });

  it('水印开启但文字被清空时等于没开', async () => {
    const out = await new DerivativeService(
      settings({ 'watermark.enabled': 'true', 'watermark.text': '   ' }),
    ).render(await jpeg(800, 600));
    expect(out.watermarked).toBe(0);
  });

  it('小图不放大：原图小于目标尺寸时保持原尺寸', async () => {
    const out = await new DerivativeService(settings()).render(await jpeg(600, 400));
    const meta = await sharp(out.preview).metadata();
    expect(meta.width).toBe(600);
    expect(meta.height).toBe(400);
  });

  it('没有可派生源时回退占位图，尺寸仍受上限约束', async () => {
    const out = await new DerivativeService(
      settings({ 'preview.max_width': '800', 'preview.thumb_width': '200' }),
    ).render(null);
    expect((await sharp(out.preview).metadata()).width).toBeLessThanOrEqual(800);
    expect((await sharp(out.thumb).metadata()).width).toBeLessThanOrEqual(200);
  });

  it('quality 与尺寸配置一起生效', async () => {
    const source = await noisy(2600, 1800);
    const hi = await new DerivativeService(settings({ 'preview.quality': '95' })).render(source);
    const lo = await new DerivativeService(settings({ 'preview.quality': '25' })).render(source);
    expect(hi.preview.length).toBeGreaterThan(lo.preview.length);
  });

  it('regenerate 走同一套参数，供批量重做水印', async () => {
    const service = new DerivativeService(settings({ 'watermark.enabled': 'true', 'watermark.opacity': '0.5' }));
    const out = await service.regenerate(await jpeg(2200, 1400));
    expect(out?.watermarked).toBe(1);
    expect((await sharp(out!.preview).metadata()).width).toBe(2048);
  });

  it('regenerate 遇到不可解码字节返回 null 而不是假成功', async () => {
    const service = new DerivativeService(settings());
    await expect(service.regenerate(Buffer.from('raw bytes only'))).resolves.toBeNull();
  });
});
