import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { SiteSetting } from '../../entities';
import { SettingsService } from './settings.service';

type Seed = Array<Pick<SiteSetting, 'key' | 'value'>>;

const SEED: Seed = [
  { key: 'upload.max_image_size', value: '52428800' },
  { key: 'preview.quality', value: '82' },
  { key: 'watermark.enabled', value: 'false' },
  { key: 'guest.comment_enabled', value: 'true' },
  { key: 'watermark.text', value: '皮克社工作室' },
  { key: 'upload.image_extensions', value: '[".jpg",".png"]' },
  { key: 'security.session_ttl', value: '{"user":86400,"temp":3600}' },
  { key: 'broken.number', value: 'not-a-number' },
  { key: 'broken.json', value: '{"user":' },
];

function build(seed: Seed = SEED, findError?: Error) {
  const store = new Map(seed.map((row) => [row.key, row.value]));
  const repo = {
    find: jest.fn(async () => {
      if (findError) throw findError;
      return [...store.entries()].map(([key, value]) => ({ key, value })) as SiteSetting[];
    }),
    save: jest.fn(async (entity: unknown) => {
      const rows = (Array.isArray(entity) ? entity : [entity]) as Seed;
      for (const row of rows) store.set(row.key, row.value);
      return entity;
    }),
  } as unknown as Repository<SiteSetting>;
  return { repo, service: new SettingsService(repo), store };
}

describe('SettingsService：KV 缓存与类型解析', () => {
  it('reload 后按声明类型解析库中的字符串值', async () => {
    const t = build();
    await t.service.reload();

    expect(t.service.getNumber('upload.max_image_size', 0)).toBe(52428800);
    expect(t.service.getBoolean('watermark.enabled', true)).toBe(false);
    expect(t.service.getBoolean('guest.comment_enabled', false)).toBe(true);
    expect(t.service.getString('watermark.text', '')).toBe('皮克社工作室');
    expect(t.service.getJson<string[]>('upload.image_extensions', [])).toEqual(['.jpg', '.png']);
    expect(t.service.getJson<Record<string, number>>('security.session_ttl', {})).toEqual({
      user: 86400,
      temp: 3600,
    });
    expect(t.service.raw('preview.quality')).toBe('82');
  });

  it('缺 key 时回退默认值，四类读取器口径一致', async () => {
    const t = build([]);
    await t.service.reload();

    expect(t.service.getNumber('absent', 1024)).toBe(1024);
    expect(t.service.getBoolean('absent', true)).toBe(true);
    expect(t.service.getString('absent', 'fallback')).toBe('fallback');
    expect(t.service.getJson<string[]>('absent', ['.a'])).toEqual(['.a']);
    expect(t.service.raw('absent')).toBeUndefined();
  });

  it('脏数据不抛异常，只回退默认值', async () => {
    const t = build();
    await t.service.reload();

    expect(t.service.getNumber('broken.number', 7)).toBe(7);
    expect(t.service.getJson('broken.json', { ok: true })).toEqual({ ok: true });
    // 非法 JSON 之外的布尔解释：非 'true'/'1' 一律视为关闭，宁可少放行
    expect(t.service.getBoolean('broken.json', true)).toBe(false);
  });

  it('写入后立即生效，不需要等下一次 reload', async () => {
    const t = build([]);
    await t.service.reload();
    expect(t.service.getBoolean('watermark.enabled', false)).toBe(false);

    await t.service.set('watermark.enabled', 'true', '开启水印', 1);

    expect(t.repo.save).toHaveBeenCalledWith({
      key: 'watermark.enabled',
      value: 'true',
      remark: '开启水印',
      updateUid: 1,
    });
    expect(t.service.getBoolean('watermark.enabled', false)).toBe(true);
  });

  it('批量写入后刷新缓存，空清单不碰库', async () => {
    const t = build([]);
    await t.service.reload();
    const before = (t.repo.find as unknown as jest.Mock).mock.calls.length;

    await t.service.setMany([], 1);
    expect(t.repo.save).not.toHaveBeenCalled();
    expect((t.repo.find as unknown as jest.Mock).mock.calls.length).toBe(before);

    await t.service.setMany(
      [
        { key: 'preview.quality', value: '90' },
        { key: 'preview.max_width', value: '4096' },
      ],
      4,
    );
    expect(t.service.getNumber('preview.quality', 0)).toBe(90);
    expect(t.service.getNumber('preview.max_width', 0)).toBe(4096);
    expect(t.store.get('preview.quality')).toBe('90');
    expect(t.repo.save).toHaveBeenCalledWith([
      { key: 'preview.quality', value: '90', remark: '', updateUid: 4 },
      { key: 'preview.max_width', value: '4096', remark: '', updateUid: 4 },
    ]);
  });

  it('后台配置页按 key 升序读取全表', async () => {
    const t = build();
    await t.service.listAll();
    expect(t.repo.find).toHaveBeenCalledWith({ order: { key: 'ASC' } });
  });

  it('配置表还没建时不阻断启动，全走默认值', async () => {
    const spy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const t = build(SEED, new Error("Table 'site_settings' doesn't exist"));

    await expect(t.service.onModuleInit()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('站点配置预加载失败'));
    expect(t.service.getNumber('upload.max_image_size', 52428800)).toBe(52428800);
    spy.mockRestore();
  });
});
