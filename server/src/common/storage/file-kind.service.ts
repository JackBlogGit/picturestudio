import { HttpStatus, Injectable } from '@nestjs/common';
import { fileTypeFromBuffer } from 'file-type';
import { SettingsService } from '../../modules/settings/settings.service';
import { AppError } from '../http/app-error';

export interface FileKind {
  ext: string;
  mime: string;
}

/** 魔数探测只需要文件头，64KB 足够覆盖全部支持格式的 box/table 定位 */
const PROBE_BYTES = 65536;

/**
 * PRD 5.2 的三张名单缺省值，与 `sql/schema.sql` 结尾的 site_settings 种子逐字一致。
 * 之所以要在代码里也放一份：SQLite 开发库走 synchronize 建表，不会跑 schema.sql 里那段
 * INSERT 种子，缺键时若兜成空数组，白名单为空 ⇒ 每一次上传都死在误导性的「不支持的扩展名」。
 * 管理员真的把某条配置存成空数组时，getJson 拿到的就是空数组，这份缺省不会盖掉它。
 */
const DEFAULT_IMAGE_EXTENSIONS = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  'heic',
  'tif',
  'tiff',
  'raw',
  'cr2',
  'nef',
  'arw',
];

const DEFAULT_FILE_EXTENSIONS = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'psd',
  'ai',
  'zip',
  '7z',
  'rar',
  'mp4',
  'mov',
  'preset',
  'xmp',
];

const DEFAULT_BLOCKED_EXTENSIONS = [
  'exe',
  'bat',
  'cmd',
  'sh',
  'msi',
  'dll',
  'apk',
  'jar',
  'js',
  'vbs',
  'ps1',
  'scr',
];

/**
 * PRD 12.4：真实类型判定不信任扩展名，也不信任客户端 Content-Type。
 * 白名单来自站点配置，黑名单无条件拒绝，落库的 mimeType 一定是这里校验后的值。
 */
@Injectable()
export class FileKindService {
  constructor(private readonly settings: SettingsService) {}

  async detect(buffer: Buffer): Promise<FileKind | null> {
    const result = await fileTypeFromBuffer(buffer.subarray(0, PROBE_BYTES));
    return result ? { ext: result.ext.toLowerCase(), mime: result.mime } : null;
  }

  /** 客户端扩展名只参与白名单比对，绝不参与任何路径拼接 */
  clientExt(filename: string): string {
    const dot = filename.lastIndexOf('.');
    return dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
  }

  private list(key: string, fallback: string[]): string[] {
    const raw = this.settings.getJson<string[]>(key, fallback);
    return raw.map((e) => String(e).toLowerCase().replace(/^\./, '')).filter(Boolean);
  }

  /**
   * @param scope image 走图片白名单，file 走网盘白名单
   * @throws 400 伪装文件 / 不在白名单 / 命中黑名单
   */
  async assertAllowed(scope: 'image' | 'file', buffer: Buffer, filename: string): Promise<FileKind> {
    const whitelistKey = scope === 'image' ? 'upload.image_extensions' : 'upload.file_extensions';
    const whitelist = this.list(
      whitelistKey,
      scope === 'image' ? DEFAULT_IMAGE_EXTENSIONS : DEFAULT_FILE_EXTENSIONS,
    );
    const blacklist = this.list('upload.blocked_extensions', DEFAULT_BLOCKED_EXTENSIONS);
    const client = this.clientExt(filename);

    if (blacklist.includes(client)) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'BLOCKED_EXTENSION', `禁止上传 .${client} 类型文件`);
    }
    if (client && !whitelist.includes(client)) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'EXTENSION_NOT_ALLOWED', `不支持的扩展名 .${client}`);
    }

    const kind = await this.detect(buffer);
    if (!kind) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'UNKNOWN_FILE_TYPE', '无法识别文件真实类型，已拒绝');
    }
    /** svg 是 XSS 载体，file-type 未必区分，单独兜死 */
    if (kind.ext === 'svg' || kind.mime === 'image/svg+xml') {
      throw new AppError(HttpStatus.BAD_REQUEST, 'BLOCKED_FILE_TYPE', '禁止上传 SVG');
    }
    if (blacklist.includes(kind.ext)) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'FAKE_EXTENSION',
        `文件真实类型为 .${kind.ext}，与扩展名不符，已拒绝`,
      );
    }
    if (!whitelist.includes(kind.ext)) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'TYPE_NOT_ALLOWED', `不支持的文件类型 .${kind.ext}`);
    }
    return kind;
  }
}
