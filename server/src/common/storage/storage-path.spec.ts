import {
  DIR_CHUNK,
  DIR_DERIVE,
  DIR_ORIGINALS,
  DIR_PREVIEW,
  DIR_THUMB,
  chunkKey,
  derivedKey,
  isUploadId,
  newUploadId,
  originalKey,
  resolveInside,
  safeExt,
  stagingKey,
} from './storage-path';

const ROOT = 'D:/pike-storage';

describe('safeExt：扩展名只能来自魔数结果', () => {
  it('小写化、去掉点，只留安全字符', () => {
    expect(safeExt('JPEG')).toBe('jpeg');
    expect(safeExt('.png')).toBe('png');
    expect(safeExt('webp')).toBe('webp');
  });

  it('路径分隔符、穿越片段、超长扩展名一律降级为 bin', () => {
    expect(safeExt('../../etc/passwd')).toBe('bin');
    expect(safeExt('jpg/..%2f')).toBe('bin');
    expect(safeExt('C:\\windows\\system32')).toBe('bin');
    expect(safeExt('a'.repeat(30))).toBe('bin');
    expect(safeExt('')).toBe('bin');
    expect(safeExt(undefined as never)).toBe('bin');
    expect(safeExt('jp g')).toBe('bin');
  });
});

describe('存储键规划', () => {
  it('原图键是 originals/YYYY/MM/uuid.ext，文件名与原始名无关', () => {
    const key = originalKey('jpg', new Date(2026, 8, 30));
    expect(key.startsWith(`${DIR_ORIGINALS}/2026/09/`)).toBe(true);
    const name = key.split('/').pop() as string;
    expect(name.endsWith('.jpg')).toBe(true);
    expect(isUploadId(name.replace(/\.jpg$/, ''))).toBe(true);
    // 月份补零，否则会写出 /9/ 这种一年八个目录的鬼东西
    expect(originalKey('png', new Date(2026, 0, 5))).toContain('/2026/01/');
  });

  it('两次生成的键必然不同，同月也不会互相覆盖', () => {
    const now = new Date();
    expect(new Set([originalKey('jpg', now), originalKey('jpg', now)]).size).toBe(2);
  });

  it('派生图按 image_id 固定命名，重做水印时原地覆盖', () => {
    expect(derivedKey(42, 'preview')).toBe(`${DIR_PREVIEW}/42.webp`);
    expect(derivedKey(42, 'thumb')).toBe(`${DIR_THUMB}/42.webp`);
  });

  it('派生图 id 非法直接抛，绝不拼出 derived/preview/NaN.webp', () => {
    expect(() => derivedKey(0, 'preview')).toThrow();
    expect(() => derivedKey(-1, 'thumb')).toThrow();
    expect(() => derivedKey(1.5, 'preview')).toThrow();
    expect(() => derivedKey(Number.NaN, 'preview')).toThrow();
  });

  it('分片与临时产物只接受 UUID uploadId，name 还要再过一次字面量闸', () => {
    const id = newUploadId();
    expect(chunkKey(id, 0)).toBe(`${DIR_CHUNK}/${id}/0`);
    expect(stagingKey(id, 'merged.bin')).toBe(`${DIR_DERIVE}/${id}/merged.bin`);
    expect(isUploadId(id)).toBe(true);
    expect(isUploadId('../../etc/passwd')).toBe(false);
    expect(isUploadId('2026-09-30 张三.jpg')).toBe(false);
  });

  it('分片序号必须是非负整数，临时 name 不能藏路径', () => {
    const id = newUploadId();
    expect(() => chunkKey(id, -1)).toThrow();
    expect(() => chunkKey(id, 1.2)).toThrow();
    expect(() => chunkKey('not-a-uuid', 1)).toThrow();
    expect(() => stagingKey(id, '../../evil')).toThrow();
    expect(() => stagingKey(id, 'a'.repeat(41))).toThrow();
    expect(() => stagingKey(id, '..\\..\\evil')).toThrow();
  });
});

describe('resolveInside：物理上写不到 root 之外', () => {
  it('正常相对路径解析到 root 下面', () => {
    const abs = resolveInside(ROOT, 'originals/2026/09/x.jpg');
    expect(abs.replace(/\\/g, '/')).toBe('D:/pike-storage/originals/2026/09/x.jpg');
  });

  it('拒绝一切穿越与绝对路径', () => {
    const bad = [
      '../outside.jpg',
      'originals/../../outside.jpg',
      'originals/..',
      '..',
      '.',
      './',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      '',
    ];
    for (const rel of bad) {
      expect(() => resolveInside(ROOT, rel)).toThrow();
    }
  });

  it('反斜杠与前置斜杠的变体同样进不来', () => {
    expect(() => resolveInside(ROOT, 'originals\\..\\..\\x')).toThrow();
    expect(() => resolveInside(ROOT, '//originals/x.jpg')).toThrow();
    expect(() => resolveInside(ROOT, '///etc/passwd')).toThrow();
  });

  it('UNC 路径在 Windows 上属于绝对路径，必须被拒', () => {
    if (process.platform === 'win32') {
      expect(() => resolveInside(ROOT, '\\\\server\\share\\x.jpg')).toThrow();
    }
  });

  it('null / undefined 直接抛，不静默写到根目录', () => {
    expect(() => resolveInside(ROOT, null as never)).toThrow();
    expect(() => resolveInside(ROOT, undefined as never)).toThrow();
  });
});
