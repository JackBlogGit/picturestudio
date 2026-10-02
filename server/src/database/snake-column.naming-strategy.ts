import { DefaultNamingStrategy } from 'typeorm';

/**
 * schema.sql 的列名一律 snake_case，而 TypeORM 默认策略只把**表名**转 snake_case、
 * **列名原样取属性名**（DefaultNamingStrategy.columnName 直接 return propertyName）。
 * 于是实体指向 `accessToken` / `spaceQuota` 这类库里并不存在的列，真连上 MySQL 就是
 * Unknown column。本类把列名统一落到 DDL 的真实列名。
 *
 * 表名与索引名不处理：@Entity('site_settings')、@Index('idx_xxx') 均已写显式名。
 * 已有的显式列名只有 skey / sval，snakeCaseName 对其恒等，故可一并覆盖。
 */
export function snakeCaseName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export class SnakeColumnNamingStrategy extends DefaultNamingStrategy {
  override columnName(propertyName: string, customName?: string): string {
    return snakeCaseName(customName ?? propertyName);
  }
}

export const snakeNamingStrategy = () => new SnakeColumnNamingStrategy();
