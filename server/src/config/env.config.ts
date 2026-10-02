import { registerAs } from '@nestjs/config';

export interface Env {
  nodeEnv: string;
  port: number;
  corsOrigin: string[];
  db: { 
    type: 'mysql' | 'better-sqlite3';
    host?: string; 
    port?: number; 
    user?: string; 
    password?: string; 
    name?: string;
    database?: string; // SQLite file path
  };
  jwt: { secret: string; accessTokenTtlSec: number };
  storageRoot: string;
  maxImageSize: number;
  maxFileSize: number;
  redisUrl: string | null;
}

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`环境变量 ${name} 未配置，请参考 .env.example 填写`);
  }
  return value;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const nodeEnv = source.NODE_ENV ?? 'development';
  const secret = required('JWT_SECRET', source.JWT_SECRET);
  if (nodeEnv === 'production' && secret.length < 32) {
    throw new Error('生产环境 JWT_SECRET 长度不得小于 32 字符');
  }
  
  const dbType = (source.DB_TYPE ?? 'better-sqlite3') as 'mysql' | 'better-sqlite3';
  
  return {
    nodeEnv,
    port: Number(source.PORT ?? 3000),
    corsOrigin: (source.CORS_ORIGIN ?? 'http://localhost:5173').split(','),
    db: dbType === 'better-sqlite3' 
      ? {
          type: 'better-sqlite3',
          database: source.DB_DATABASE ?? './piks_photo.db',
        }
      : {
          type: 'mysql',
          host: source.DB_HOST ?? '127.0.0.1',
          port: Number(source.DB_PORT ?? 3306),
          user: source.DB_USER ?? 'root',
          password: source.DB_PASSWORD ?? '',
          name: source.DB_NAME ?? 'piks_photo',
        },
    jwt: {
      secret,
      accessTokenTtlSec: Number(source.JWT_ACCESS_TTL_SEC ?? 900),
    },
    storageRoot: required('STORAGE_ROOT', source.STORAGE_ROOT),
    maxImageSize: Number(source.UPLOAD_MAX_IMAGE_SIZE ?? 52428800),
    maxFileSize: Number(source.UPLOAD_MAX_FILE_SIZE ?? 2147483648),
    redisUrl: source.REDIS_URL || null,
  };
}

export default registerAs('app', () => loadEnv());
