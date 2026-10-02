import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SiteSetting } from '../../entities';

@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);
  private cache = new Map<string, string>();

  constructor(@InjectRepository(SiteSetting) private readonly repo: Repository<SiteSetting>) {}

  /**
   * 配置读取失败不阻断启动：站点配置表可能还没跑 migration，
   * 此时全部走 DEFAULTS，保证 /health 与登录之外的接口不因此瘫痪。
   */
  async onModuleInit(): Promise<void> {
    await this.reload().catch((err: Error) =>
      this.logger.warn(`站点配置预加载失败，使用默认值：${err.message}`),
    );
  }

  async reload(): Promise<void> {
    const rows = await this.repo.find();
    this.cache = new Map(rows.map((r) => [r.key, r.value]));
  }

  listAll(): Promise<SiteSetting[]> {
    return this.repo.find({ order: { key: 'ASC' } });
  }

  raw(key: string): string | undefined {
    return this.cache.get(key);
  }

  getString(key: string, fallback: string): string {
    return this.cache.get(key) ?? fallback;
  }

  getNumber(key: string, fallback: number): number {
    const v = this.cache.get(key);
    if (v === undefined) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  getBoolean(key: string, fallback: boolean): boolean {
    const v = this.cache.get(key);
    if (v === undefined) return fallback;
    return v === 'true' || v === '1';
  }

  getJson<T>(key: string, fallback: T): T {
    const v = this.cache.get(key);
    if (v === undefined) return fallback;
    try {
      return JSON.parse(v) as T;
    } catch {
      this.logger.warn(`站点配置 ${key} 不是合法 JSON，已回退默认值`);
      return fallback;
    }
  }

  /** 写入由 L4 触发（AdminGuard 保证），成功后立即刷新缓存 */
  async set(key: string, value: string, remark: string, uid: number | null): Promise<void> {
    await this.repo.save({ key, value, remark: remark ?? '', updateUid: uid });
    this.cache.set(key, value);
  }

  async setMany(entries: Array<{ key: string; value: string; remark?: string }>, uid: number | null): Promise<void> {
    if (!entries.length) return;
    await this.repo.save(
      entries.map((e) => ({ key: e.key, value: e.value, remark: e.remark ?? '', updateUid: uid })),
    );
    await this.reload();
  }
}
