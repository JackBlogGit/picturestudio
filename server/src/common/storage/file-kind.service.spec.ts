import { fileTypeFromBuffer } from 'file-type';
import { SettingsService } from '../../modules/settings/settings.service';
import { AppError } from '../http/app-error';
import { FileKindService } from './file-kind.service';

/** 与 sql/schema.sql 的种子值保持一致：白名单写错，整条上传链路就会全拒 */
const IMAGE_WHITELIST = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.heic',
  '.tif',
  '.tiff',
  '.raw',
  '.cr2',
  '.nef',
  '.arw',
];
const FILE_WHITELIST = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.psd',
  '.ai',
  '.zip',
  '.7z',
  '.rar',
  '.mp4',
  '.mov',
  '.preset',
  '.xmp',
];
const BLOCKED = ['.exe', '.bat', '.cmd', '.sh', '.msi', '.dll', '.apk', '.jar', '.js', '.vbs', '.ps1', '.scr'];

function settings(values: Record<string, string[]> = {}): SettingsService {
  const seed: Record<string, string[]> = {
    'upload.image_extensions': IMAGE_WHITELIST,
    'upload.file_extensions': FILE_WHITELIST,
    'upload.blocked_extensions': BLOCKED,
    ...values,
  };
  return {
    getJson: (key: string, fallback: unknown) => seed[key] ?? fallback,
  } as unknown as SettingsService;
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    return err as AppError;
  }
  throw new Error('预期被拒绝，但实际放行了');
}

async function image(format: 'png' | 'jpeg' | 'webp' | 'tiff' | 'avif'): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
  })[format]()
    .toBuffer();
}

/** PE 头：MZ + 指向 PE\0\0 的 e_lfanew，file-type 认得出来 */
function peBytes(): Buffer {
  const buf = Buffer.alloc(0x120);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(0x100, 0x3c);
  buf.write('PE\0\0', 0x100, 'ascii');
  return buf;
}

function svgBytes(): Buffer {
  return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>', 'utf8');
}

describe('FileKindService：只信二进制头', () => {
  it('种子白名单里的类型，魔数结果确实能对得上', async () => {
    const svc = new FileKindService(settings());
    const expected: Record<string, string> = {
      png: 'png',
      jpeg: 'jpg',
      webp: 'webp',
      tiff: 'tif',
    };
    for (const [format, ext] of Object.entries(expected)) {
      const kind = await svc.assertAllowed('image', await image(format as never), `现场返图.${ext}`);
      expect(kind.ext).toBe(ext);
      expect(IMAGE_WHITELIST).toContain(`.${kind.ext}`);
    }
  });

  it('原始文件名里的路径穿越不参与判定，扩展名大小写也不影响', async () => {
    const svc = new FileKindService(settings());
    const source = await image('jpeg');
    const kind = await svc.assertAllowed('image', source, '../../../../Windows/Temp/PHOTO.JPEG');
    expect(kind.ext).toBe('jpg');
  });

  it('可执行文件伪装成 .jpg 会被真实类型戳穿', async () => {
    const svc = new FileKindService(settings());
    const err = await errorOf(svc.assertAllowed('image', peBytes(), '好看的照片.jpg'));
    expect(err.getStatus()).toBe(400);
    expect(err.code).toBe('FAKE_EXTENSION');
  });

  it('黑名单扩展名先看名字，哪怕内容是真图片', async () => {
    const svc = new FileKindService(settings());
    const err = await errorOf(svc.assertAllowed('file', await image('png'), 'setup.exe'));
    expect(err.code).toBe('BLOCKED_EXTENSION');
    expect(err.getStatus()).toBe(400);
  });

  it('白名单外的合法类型也进不来（图片档位收到 mp4 名字）', async () => {
    const svc = new FileKindService(settings());
    const err = await errorOf(svc.assertAllowed('image', Buffer.alloc(64), '视频.mp4'));
    expect(err.code).toBe('EXTENSION_NOT_ALLOWED');
  });

  it('认不出类型的字节一律拒绝，不存在「默认放行」', async () => {
    const svc = new FileKindService(settings());
    const err = await errorOf(
      svc.assertAllowed('image', Buffer.from('这就是一段普通文本，没有魔数'), '照片.png'),
    );
    expect(err.code).toBe('UNKNOWN_FILE_TYPE');
  });

  it('GIF 是真图片，但没进白名单就是不行', async () => {
    const svc = new FileKindService(settings());
    const gif = Buffer.concat([Buffer.from('GIF89a', 'binary'), Buffer.alloc(64)]);
    expect((await fileTypeFromBuffer(gif))?.ext).toBe('gif');
    // 名字先被拦
    expect((await errorOf(svc.assertAllowed('image', gif, '表情.gif'))).code).toBe('EXTENSION_NOT_ALLOWED');
    // 名字伪装成白名单，也要被真实类型拦下
    expect((await errorOf(svc.assertAllowed('image', gif, '表情.jpg'))).code).toBe('TYPE_NOT_ALLOWED');
  });

  it('SVG 无论走名字还是走内容都进不来', async () => {
    const svc = new FileKindService(settings());
    const byName = await errorOf(svc.assertAllowed('image', svgBytes(), '图标.svg'));
    expect(byName.code).toBe('EXTENSION_NOT_ALLOWED');
    const byContent = await errorOf(svc.assertAllowed('image', svgBytes(), '图标.png'));
    expect(['BLOCKED_FILE_TYPE', 'UNKNOWN_FILE_TYPE']).toContain(byContent.code);
  });

  it('网盘档位放行 pdf/zip，图片档位照样拒绝', async () => {
    const svc = new FileKindService(settings());
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF', 'binary');
    expect((await svc.assertAllowed('file', pdf, '合同 .pdf')).ext).toBe('pdf');
    const err = await errorOf(svc.assertAllowed('image', pdf, '伪装成图的合同.jpg'));
    expect(err.code).toBe('TYPE_NOT_ALLOWED');

    const zip = Buffer.from('PK\x03\x04', 'ascii');
    expect((await svc.assertAllowed('file', zip, '预设.zip')).ext).toBe('zip');
  });

  it('白名单是站点配置，管理员加了 .gif 之后才放行', async () => {
    const gif = Buffer.concat([Buffer.from('GIF89a', 'binary'), Buffer.alloc(64)]);
    const strict = new FileKindService(settings());
    await expect(strict.assertAllowed('image', gif, '动图.gif')).rejects.toThrow();
    const loose = new FileKindService(
      settings({ 'upload.image_extensions': [...IMAGE_WHITELIST, '.gif'] }),
    );
    expect((await loose.assertAllowed('image', gif, '动图.gif')).ext).toBe('gif');
  });

  it('探测只看头部，2MB 的真图不会因为体积被误判', async () => {
    const svc = new FileKindService(settings());
    const source = Buffer.concat([await image('png'), Buffer.alloc(2 * 1024 * 1024, 7)]);
    expect((await svc.assertAllowed('image', source, '大图.png')).ext).toBe('png');
  });

  it('无扩展名时以魔数为准，落库的 mimeType 永远来自真实类型', async () => {
    const svc = new FileKindService(settings());
    const kind = await svc.assertAllowed('image', await image('webp'), 'clipboard-20260930');
    expect(kind).toEqual({ ext: 'webp', mime: 'image/webp' });
  });

  it('AVIF 不在白名单里，别被「浏览器都支持」骗了', async () => {
    const svc = new FileKindService(settings());
    const err = await errorOf(svc.assertAllowed('image', await image('avif'), '新格式.avif'));
    expect(err.code).toBe('EXTENSION_NOT_ALLOWED');
  });

  it('clientExt 只取最后一个点之后的部分，且只用于比对', () => {
    const svc = new FileKindService(settings());
    expect(svc.clientExt('a.b.c.JPG')).toBe('jpg');
    expect(svc.clientExt('无扩展名')).toBe('');
    expect(svc.clientExt('结尾带点.')).toBe('');
    expect(svc.clientExt('路径/斜杠.png')).toBe('png');
  });
});
