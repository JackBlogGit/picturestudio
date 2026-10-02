import { DataSource } from 'typeorm';
import { loadEnv } from './config/env.config';
import { snakeNamingStrategy } from './database/snake-column.naming-strategy';
import { ALL_ENTITIES } from './entities';

/**
 * TypeORM CLI 用的数据源（migration:generate / migration:run）。
 * 应用运行时用的是 app.module.ts 里的 TypeOrmModule.forRootAsync，二者共用同一份实体清单。
 */
const env = loadEnv({ ...process.env, JWT_SECRET: process.env.JWT_SECRET ?? 'cli-only' });

export default new DataSource({
  type: 'mysql',
  host: env.db.host,
  port: env.db.port,
  username: env.db.user,
  password: env.db.password,
  database: env.db.name,
  charset: 'utf8mb4',
  // 必须与 app.module.ts 完全一致，否则 migration:generate 会把 snake_case 列当成改名
  namingStrategy: snakeNamingStrategy(),
  entities: ALL_ENTITIES,
  migrations: ['src/migrations/*.ts', 'dist/migrations/*.js'],
  // InitSchema 迁移需要一次提交整份 schema.sql
  extra: { multipleStatements: true },
  synchronize: false,
});
