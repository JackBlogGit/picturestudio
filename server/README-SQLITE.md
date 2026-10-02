# SQLite 数据库配置说明

## 概述

项目已配置为使用 SQLite 作为开发数据库，无需安装 MySQL。这对于快速开发和测试非常有用。

## 已完成的工作

### 1. 安装依赖

- 安装了 `better-sqlite3` 包作为 SQLite 驱动

### 2. 配置文件修改

#### `.env` 和 `.env.example`

```env
DB_TYPE=better-sqlite3
DB_DATABASE=./piks_photo.db
```

#### `src/config/env.config.ts`

- 添加了 `db.type` 字段支持 `'mysql' | 'better-sqlite3'`
- 根据数据库类型返回不同的配置对象

#### `src/app.module.ts`

- 根据 `db.type` 动态配置 TypeORM
- SQLite 模式下：
  - 禁用 `namingStrategy`（SQLite 不支持）
  - 启用 `synchronize: true`（自动同步表结构）

### 3. 实体兼容性修复

SQLite 不支持某些 MySQL 特性，已进行以下修复：

#### Enum 类型 → simple-enum

将所有 `type: 'enum'` 改为 `type: 'simple-enum'`：
- `photo.entities.ts`: Album.visibility, Image.visibility, Tag.tagType
- `system.entities.ts`: UploadSession.resourceType, userType, AuditLog.userType, targetType
- `drive.entities.ts`: Folder.visibility, File.visibility

#### Char 类型 → Text

将固定长度字符类型改为文本类型：
- `UploadSession.md5Client`: char(32) → text
- `Image.md5`: char(32) → text
- `File.md5`: char(32) → text

#### 重复索引重命名

避免不同实体间的索引名称冲突：
- `folders.parentId`: idx_parent → idx_folder_parent
- `files.uploadUid`: idx_upload_uid → idx_file_upload_uid
- `files.md5`: idx_md5 → idx_file_md5
- `images.uploadUid`: idx_upload_uid → idx_img_upload_uid
- `images.md5`: idx_md5 → idx_img_md5
- `temp_accounts.expireTime`: idx_expire → idx_temp_expire

## 使用方法

### 启动后端

```bash
cd server
npm run build
npm run start:dev
```

或增加内存限制：

```bash
node --max-old-space-size=4096 ./node_modules/@nestjs/cli/bin/nest.js start --watch
```

### 切换回 MySQL

如需切换回 MySQL，修改 `.env`：

```env
DB_TYPE=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=piks
DB_PASSWORD=your_password
DB_NAME=piks_photo
```

## 注意事项

1. **生产环境**: 生产环境应使用 MySQL，不要使用 SQLite
2. **数据库文件**: SQLite 数据库文件位于 `server/piks_photo.db`
3. **重置数据库**: 删除 `piks_photo.db` 文件后重启服务即可重新创建
4. **迁移**: SQLite 模式下不使用 TypeORM 迁移，而是依靠 `synchronize` 自动同步

## 当前状态

✅ 后端服务运行在 http://localhost:3000
✅ 前端服务运行在 http://localhost:5177
✅ 健康检查通过: http://localhost:3000/api/v1/health
