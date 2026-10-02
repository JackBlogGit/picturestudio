import { ConfigService } from '@nestjs/config';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageService } from './storage.service';

function service(root: string): StorageService {
  const config = { getOrThrow: () => root } as unknown as ConfigService;
  return new StorageService(config);
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('StorageService 真实磁盘读写', () => {
  let root: string;
  let svc: StorageService;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'pike-storage-'));
    svc = service(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('写入会自动建目录，读出的是同一段字节', async () => {
    const key = 'originals/2026/09/deep/nested.jpg';
    expect(await svc.write(key, Buffer.from('一二三abc'))).toBe(12);
    expect(await svc.exists(key)).toBe(true);
    const file = await svc.read(key);
    expect(file.size).toBe(12);
    expect((await collect(file.stream)).toString()).toBe('一二三abc');
    expect(await svc.size(key)).toBe(12);
  });

  it('写入走 .part 再改名，落盘后不留半成品', async () => {
    const key = 'derived/preview/9.webp';
    await svc.write(key, Buffer.from('x'));
    expect(await readdir(join(root, 'derived', 'preview'))).toEqual(['9.webp']);
  });

  it('同一路径再写是覆盖，不是追加', async () => {
    const key = 'derived/thumb/9.webp';
    await svc.write(key, Buffer.alloc(1024, 1));
    await svc.write(key, Buffer.alloc(8, 2));
    expect(await svc.size(key)).toBe(8);
  });

  it('move 把临时区产物提升到正式目录，目标目录不存在时先建', async () => {
    const from = 'tmp/derive/upload-1/merged.bin';
    const to = 'originals/2026/09/moved.bin';
    await svc.write(from, Buffer.from('merged'));
    await svc.move(from, to);
    expect(await svc.exists(from)).toBe(false);
    expect(await svc.exists(to)).toBe(true);
  });

  it('删除幂等：不存在的、null、undefined 都不炸', async () => {
    await expect(
      svc.remove('originals/never-exists.jpg', null, undefined, 'originals/2026/09/moved.bin'),
    ).resolves.toBeUndefined();
    expect(await svc.exists('originals/2026/09/moved.bin')).toBe(false);
  });

  it('removeTree 递归清理分片目录，目录不存在也算成功', async () => {
    await svc.write('tmp/chunk/abc/0', Buffer.from('0'));
    await svc.write('tmp/chunk/abc/1', Buffer.from('1'));
    await svc.removeTree('tmp/chunk/abc');
    expect(await svc.exists('tmp/chunk/abc/1')).toBe(false);
    await expect(svc.removeTree('tmp/chunk/not-there')).resolves.toBeUndefined();
  });

  it('missing 文件的 size 是 -1，read 才抛', async () => {
    expect(await svc.size('originals/void.jpg')).toBe(-1);
    await expect(svc.read('originals/void.jpg')).rejects.toThrow();
  });

  describe('防穿越', () => {
    const escapes = ['../pike-escaped.txt', '../../etc/passwd', '/etc/passwd', 'C:\\Windows\\win.ini'];

    it('穿越路径既写不出去也读不出来', async () => {
      for (const rel of escapes) {
        expect(() => svc.abs(rel)).toThrow();
        await expect(svc.write(rel, Buffer.from('boom'))).rejects.toThrow();
        await expect(svc.read(rel)).rejects.toThrow();
        await expect(svc.move(rel, 'ok.bin')).rejects.toThrow();
        await expect(svc.move('ok.bin', rel)).rejects.toThrow();
      }
      await expect(stat(join(root, '..', 'pike-escaped.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('清理路径上的非法输入只会被吞掉，绝不误删 root 之外的东西', async () => {
      const outside = join(root, '..', 'pike-keep-me.txt');
      await expect(stat(outside)).rejects.toMatchObject({ code: 'ENOENT' });
      for (const rel of escapes) {
        await expect(svc.remove(rel)).resolves.toBeUndefined();
        await expect(svc.removeTree(rel)).resolves.toBeUndefined();
      }
      await expect(stat(outside)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('客户端文件名不参与任何拼接：落盘键只有 UUID', async () => {
    const clientFilename = '../../../../../../etc/passwd.jpg';
    const key = 'originals/2026/09/3f9a1c2b-0d4e-4a1f-9b7c-16f2b3c4d5e6.jpg';
    expect(key).not.toContain(clientFilename);
    expect(() => svc.abs(clientFilename)).toThrow();
    await svc.write(key, Buffer.from('safe'));
    expect((await collect(await (await svc.read(key)).stream)).toString()).toBe('safe');
  });

  it('storageRoot 缺失时构造即失败，绝不退化成项目目录', () => {
    const config = {
      getOrThrow: (key: string) => {
        if (key === 'app.storageRoot') throw new Error('缺配置');
        return key;
      },
    } as unknown as ConfigService;
    expect(() => new StorageService(config)).toThrow();
  });
});
