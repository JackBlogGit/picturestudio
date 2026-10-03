/**
 * 开发/演示库的 seed：`npm run seed`（连真后端跑起来之前的第一件事，否则库里没有账号，
 * 关掉 VITE_USE_MOCK 连登录页都过不去）。
 *
 * 干三件事：
 * 1. 建表——SQLite 走 synchronize，MySQL 走 migrations（与 app.module.ts 同一套判定）；
 * 2. 落数据——内容见 seed-data.ts，与 client 的 mock 种子逐行对齐，id 也照抄，
 *    这样「mock 下已过验收」的逐身份结论可以直接迁移到真后端上对账；
 * 3. 落字节——图片用 sharp 现场生成真 JPEG/webp 写进 STORAGE_ROOT，
 *    因为真后端的 GET /images/:id/preview 是从磁盘读流的，库里有条目而磁盘没文件
 *    只会得到 409 FILE_MISSING，页面全是碎图。
 *
 * 默认只在空库上写入（users 非空就退出），要重建演示库显式加 `--reset`。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'reflect-metadata';
import * as bcrypt from 'bcrypt';
import sharp from 'sharp';
import { DataSource } from 'typeorm';
import { loadEnv, type Env } from '../config/env.config';
import { snakeNamingStrategy } from './snake-column.naming-strategy';
import { ALL_ENTITIES } from '../entities';
import {
  Album,
  AlbumStatus,
  CoserShareLink,
  File,
  Folder,
  GuestbookMessage,
  Image,
  ImageTagMap,
  AuditLog,
  ShareLinkImage,
  SiteSetting,
  Tag,
  TempAccount,
  TempAccountAlbum,
  TempAccountFolder,
  User,
  CrawlerLink,
  LogTargetType,
  LogUserType,
  MessageStatus,
  CrawlerLinkStatus,
} from '../entities';
import {
  SEED_ALBUMS,
  SEED_CRAWLER_LINKS,
  SEED_FILES,
  SEED_FOLDERS,
  SEED_IMAGES,
  SEED_MESSAGES,
  SEED_SETTINGS,
  SEED_SHARE_LINKS,
  SEED_TAGS,
  SEED_TEMPS,
  SEED_USERS,
} from './seed-data';

/** 演示口令：与 mock 的 DEMO_PASSWORD 同值，四个成员与三条临时账号共用 */
const DEMO_PASSWORD = 'demo1234';

/** 生成的演示图统一收在这个长边，seed 要跑得快，别按 7008px 的声明尺寸真造 */
const ORIGINAL_EDGE = 1200;
const PREVIEW_EDGE = 900;
const THUMB_EDGE = 400;

/** 表清空顺序：先子后父，与外键方向一致（MySQL 另有 FOREIGN_KEY_CHECKS 兜底） */
const TRUNCATE_ORDER = [
  'logs',
  'share_link_images',
  'coser_share_links',
  'image_tag_map',
  'images',
  'crawler_links',
  'files',
  'folders',
  'temp_account_albums',
  'temp_account_folders',
  'temp_accounts',
  'upload_sessions',
  'guestbook_messages',
  'site_settings',
  'tags',
  'albums',
  'users',
];

/** 只读 .env 里我们关心的这几项，不引额外依赖（Nest 运行时自己有 dotenv） */
function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    // 没有 .env 就纯靠进程环境变量，缺关键项时 loadEnv 自己会报
  }
  return out;
}

function buildDataSource(env: Env): { ds: DataSource; isSQLite: boolean } {
  const isSQLite = env.db.type === 'better-sqlite3';
  const common = {
    // 必须与 app.module.ts 一致：SQLite 侧列名取属性名原文，MySQL 侧走 snake_case
    namingStrategy: isSQLite ? undefined : snakeNamingStrategy(),
    entities: ALL_ENTITIES,
    migrations: [resolve(__dirname, '..', 'migrations', '*.{ts,js}')],
    // SQLite 演示库靠 synchronize 建表；真库只认 migrations，两边不混用
    synchronize: isSQLite,
    logging: ['error'] as ('error')[],
  };
  const ds = isSQLite
    ? new DataSource({ type: 'better-sqlite3', database: env.db.database!, ...common })
    : new DataSource({
        type: 'mysql',
        host: env.db.host,
        port: env.db.port,
        username: env.db.user,
        password: env.db.password,
        database: env.db.name,
        charset: 'utf8mb4',
        timezone: 'local',
        extra: { multipleStatements: true },
        ...common,
      });
  return { ds, isSQLite };
}

const iso = (value: string | null): Date | null => (value ? new Date(value) : null);

/** 审计种子行：实体里除时间戳外的标量列 + ISO 字符串时间，写库前才转 Date */
type LogSeedRow = Pick<
  AuditLog,
  'userType' | 'uid' | 'tempId' | 'action' | 'targetType' | 'targetId' | 'detail' | 'ip' | 'ua' | 'result'
> & { createTime: string };

/**
 * 生成一张演示图：按图片 id 取色，画一道对角渐变，再出三种尺寸。
 * 声明的 width/height 仍按 seed 里的相机原图写（页面要显示「7008×4672 · 42MP」），
 * 磁盘上的字节只是它的缩小版，二者按 id 一一对应，不会出现碎图。
 */
async function writeImageFiles(
  storageRoot: string,
  spec: { id: number; width: number; height: number },
): Promise<{ originalPath: string; previewPath: string; thumbPath: string; bytes: number; md5: string }> {
  const { promises: fsp } = await import('node:fs');
  const landscape = spec.width >= spec.height;
  const width = Math.max(64, landscape ? ORIGINAL_EDGE : Math.round(ORIGINAL_EDGE * (spec.width / spec.height)));
  const height = Math.max(64, landscape ? Math.round(ORIGINAL_EDGE * (spec.height / spec.width)) : ORIGINAL_EDGE);

  const hue = (spec.id * 47) % 360;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = (x / width + y / height) / 2;
      const i = (y * width + x) * 3;
      // HSL(hue, 55%, 25%+50%*t) 的手算展开，避免为演示数据再引一个颜色库
      const l = 0.25 + 0.5 * t;
      const c = (1 - Math.abs(2 * l - 1)) * 0.55;
      const hp = hue / 60;
      const xx = c * (1 - Math.abs((hp % 2) - 1));
      const [r1, g1, b1] =
        hp < 1 ? [c, xx, 0] : hp < 2 ? [xx, c, 0] : hp < 3 ? [0, c, xx] : hp < 4 ? [0, xx, c] : hp < 5 ? [xx, 0, c] : [c, 0, xx];
      const m = l - c / 2;
      raw[i] = Math.round((r1 + m) * 255);
      raw[i + 1] = Math.round((g1 + m) * 255);
      raw[i + 2] = Math.round((b1 + m) * 255);
    }
  }

  const rawInput = { raw: { width, height, channels: 3 as const } };
  const original = await sharp(raw, rawInput).jpeg({ quality: 78 }).toBuffer();
  const preview = await sharp(original).resize({ width: PREVIEW_EDGE }).webp({ quality: 82 }).toBuffer();
  const thumb = await sharp(original).resize({ width: THUMB_EDGE }).webp({ quality: 78 }).toBuffer();

  const originalPath = `originals/seed/img-${spec.id}.jpg`;
  const previewPath = `derived/preview/${spec.id}.webp`;
  const thumbPath = `derived/thumb/${spec.id}.webp`;
  for (const [rel, buf] of [
    [originalPath, original],
    [previewPath, preview],
    [thumbPath, thumb],
  ] as const) {
    const abs = resolve(storageRoot, rel);
    await fsp.mkdir(resolve(abs, '..'), { recursive: true });
    await fsp.writeFile(abs, buf);
  }
  return {
    originalPath,
    previewPath,
    thumbPath,
    bytes: original.length,
    md5: createHash('md5').update(original).digest('hex'),
  };
}

/** 网盘条目用的占位字节：真实体积与库里 file_size 必须一致，所以按声明体积生成 */
async function writeDriveFile(storageRoot: string, row: (typeof SEED_FILES)[number]): Promise<{ path: string; bytes: number; md5: string }> {
  const { promises: fsp } = await import('node:fs');
  const ext = row.filename.slice(row.filename.lastIndexOf('.'));
  const rel = `files/seed/${row.id}${ext}`;
  const body = Buffer.from(
    `皮克社工作室演示文件 ${row.filename}\n这是占位内容，仅用于让真后端的下载与预览接口有字节可读。\n`,
    'utf8',
  );
  const fill = Math.max(0, row.bytes - body.length);
  const buf = Buffer.concat([body, Buffer.alloc(fill, 0x20)]);
  const abs = resolve(storageRoot, rel);
  await fsp.mkdir(resolve(abs, '..'), { recursive: true });
  await fsp.writeFile(abs, buf);
  return { path: rel, bytes: buf.length, md5: createHash('md5').update(buf).digest('hex') };
}

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');
  const env = loadEnv({ ...readEnvFile(resolve(__dirname, '..', '..', '.env')), ...process.env });
  const { ds, isSQLite } = buildDataSource(env);
  await ds.initialize();
  // 建表：SQLite 的 synchronize 在 initialize 里已经做完，真库要显式跑一遍 migrations
  if (!isSQLite) await ds.runMigrations();

  const users = ds.getRepository(User);
  const existing = await users.count();
  if (existing > 0 && !reset) {
    await ds.destroy();
    // eslint-disable-next-line no-console
    console.log(`库里已有 ${existing} 个成员账号，seed 跳过。要重建演示库请加 --reset（会清空业务表）。`);
    return;
  }

  if (reset) {
    if (!isSQLite) await ds.query('SET FOREIGN_KEY_CHECKS = 0');
    else await ds.query('PRAGMA foreign_keys = OFF');
    for (const table of TRUNCATE_ORDER) {
      await ds.query(`DELETE FROM \`${table}\``);
    }
    if (!isSQLite) await ds.query('SET FOREIGN_KEY_CHECKS = 1');
    else await ds.query('PRAGMA foreign_keys = ON');
  }

  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const now = new Date();

  // ---------------- 成员与临时账号 ----------------
  await users.insert(
    SEED_USERS.map((u) => ({
      id: u.id,
      username: u.username,
      password: hash,
      nickname: u.nickname,
      position: u.position,
      level: u.level,
      spaceQuota: String(u.spaceQuota),
      usedSpace: String(u.usedSpace),
      status: 1,
      remark: 'seed 演示账号',
      lastLoginTime: null,
      createTime: now,
      updateTime: now,
    })),
  );

  const temps = ds.getRepository(TempAccount);
  const tempAlbumGrants: Array<{ tempId: number; albumId: number }> = [];
  const tempFolderGrants: Array<{ tempId: number; folderId: number }> = [];
  await temps.insert(
    SEED_TEMPS.map((t) => ({
      id: t.id,
      accountNo: t.accountNo,
      // 演示库给每个帐户ID 也配一条短登录名，方便手工登录时少敲几个字
      loginName: t.accountNo.toLowerCase(),
      accessToken: null,
      password: hash,
      displayName: t.displayName,
      phone: t.phone,
      shootingNote: t.shootingNote,
      expireTime: iso(t.expireTime)!,
      allowPreview: t.allowPreview,
      allowDownload: t.allowDownload,
      allowEditTag: t.allowEditTag,
      spaceQuota: String(t.spaceQuota),
      usedSpace: String(t.usedSpace),
      disabled: 0,
      ownerUid: t.ownerUid,
      preStage: t.preStage,
      postStage: t.postStage,
      preDoneTime: t.preStage ? iso(t.createTime) : null,
      postDoneTime: t.postStage ? iso(t.createTime) : null,
      createTime: iso(t.createTime)!,
      updateTime: now,
    })),
  );
  for (const t of SEED_TEMPS) {
    for (const albumId of t.albumIds) {
      tempAlbumGrants.push({ tempId: t.id, albumId });
    }
    for (const folderId of t.folderIds) {
      tempFolderGrants.push({ tempId: t.id, folderId });
    }
  }
  await ds.getRepository(TempAccountAlbum).insert(tempAlbumGrants);
  await ds.getRepository(TempAccountFolder).insert(tempFolderGrants);

  // ---------------- 标签 / 相册 / 图片 ----------------
  const tagCounts = new Map<number, number>();
  for (const img of SEED_IMAGES) {
    for (const tagId of img.tags) tagCounts.set(tagId, (tagCounts.get(tagId) ?? 0) + 1);
  }
  await ds.getRepository(Tag).insert(
    SEED_TAGS.map((t) => ({
      id: t.id,
      tagType: t.tagType,
      tagName: t.tagName,
      alias: '',
      mergedInto: null,
      useCount: tagCounts.get(t.id) ?? 0,
      createUid: 1,
      createTime: now,
    })),
  );

  await ds.getRepository(Album).insert(
    SEED_ALBUMS.map((a) => ({
      id: a.id,
      parentId: a.parentId,
      name: a.name,
      eventName: a.eventName,
      eventDate: a.eventDate,
      location: a.location,
      description: a.description,
      coverImgId: a.coverImgId,
      visibility: a.visibility,
      status: a.status as AlbumStatus,
      stage: a.stage,
      albumCaps: a.albumCaps,
      createUid: a.createUid,
      createTime: iso(a.createTime)!,
      updateTime: now,
    })),
  );

  const images = ds.getRepository(Image);
  const tagMaps: Array<{ imageId: number; tagId: number }> = [];
  for (const spec of SEED_IMAGES) {
    const files = await writeImageFiles(env.storageRoot, spec);
    await images.insert({
      id: spec.id,
      albumId: spec.albumId,
      originalPath: files.originalPath,
      previewPath: files.previewPath,
      thumbPath: files.thumbPath,
      filename: spec.filename,
      fileSize: String(files.bytes),
      width: spec.width,
      height: spec.height,
      md5: files.md5,
      shotTime: iso(spec.shotTime),
      watermarked: 0,
      visibility: spec.visibility,
      sort: spec.sort,
      imgStage: spec.imgStage,
      uploadUid: spec.uploadUid,
      uploadTempId: spec.uploadTempId,
      createTime: now,
      updateTime: now,
    });
    for (const tagId of spec.tags) tagMaps.push({ imageId: spec.id, tagId });
  }
  await ds.getRepository(ImageTagMap).insert(tagMaps);

  // ---------------- 网盘 ----------------
  await ds.getRepository(Folder).insert(
    SEED_FOLDERS.map((f) => ({
      id: f.id,
      parentId: f.parentId,
      path: f.path,
      depth: f.depth,
      name: f.name,
      description: f.description,
      kind: f.kind,
      ownerUid: f.ownerUid,
      deletedFromId: f.deletedFromId,
      deletedAt: iso(f.deletedAt),
      visibility: f.visibility,
      createUid: f.createUid,
      createTime: iso(f.createTime)!,
      updateTime: iso(f.updateTime)!,
    })),
  );
  const files = ds.getRepository(File);
  for (const spec of SEED_FILES) {
    const written = await writeDriveFile(env.storageRoot, spec);
    await files.insert({
      id: spec.id,
      folderId: spec.folderId,
      filename: spec.filename,
      storagePath: written.path,
      fileSize: String(written.bytes),
      mimeType: spec.mimeType,
      md5: written.md5,
      previewStatus: spec.previewStatus,
      visibility: spec.visibility,
      uploadUid: spec.uploadUid,
      uploadTempId: spec.uploadTempId,
      tempAccountId: spec.tempAccountId,
      refStage: spec.refStage,
      deletedFromId: spec.deletedFromId,
      deletedAt: iso(spec.deletedAt),
      createTime: iso(spec.createTime)!,
      updateTime: now,
    });
  }

  // ---------------- 分享链接 ----------------
  const links = ds.getRepository(CoserShareLink);
  const linkImages: Array<{ linkId: number; imageId: number; sort: number }> = [];
  for (const spec of SEED_SHARE_LINKS) {
    await links.insert({
      id: spec.id,
      shareToken: spec.shareToken,
      albumId: spec.albumId,
      coserTagId: spec.coserTagId,
      filterJson: spec.filterJson,
      snapshot: spec.snapshot,
      // 链接口令同样只存 bcrypt；访客解锁走 /public/share/:token/unlock 比对
      password: spec.password ? await bcrypt.hash(spec.password, 10) : null,
      allowDownload: spec.allowDownload,
      visitCount: spec.visitCount,
      expireTime: iso(spec.expireTime)!,
      revoked: spec.revoked,
      createUid: spec.createUid,
      createTime: iso(spec.createTime)!,
      lastVisitTime: iso(spec.lastVisitTime),
    });
    spec.imageIds.forEach((imageId, index) => linkImages.push({ linkId: spec.id, imageId, sort: index + 1 }));
  }
  if (linkImages.length) await ds.getRepository(ShareLinkImage).insert(linkImages);

  // ---------------- 站点配置 / 留言 / 爬虫登记 / 审计 ----------------
  await ds.getRepository(SiteSetting).insert(
    Object.entries(SEED_SETTINGS).map(([key, item]) => ({
      key,
      value: item.value,
      remark: item.remark,
      updateUid: 1,
      updateTime: now,
    })),
  );

  await ds.getRepository(GuestbookMessage).insert(
    SEED_MESSAGES.map((m) => ({
      id: m.id,
      nickname: m.nickname,
      contact: '',
      content: m.content,
      albumId: m.albumId,
      status: m.status as MessageStatus,
      auditUid: m.auditUid,
      auditTime: iso(m.auditTime),
      ip: '127.0.0.1',
      createTime: iso(m.createTime)!,
    })),
  );

  await ds.getRepository(CrawlerLink).insert(
    SEED_CRAWLER_LINKS.map((c) => ({
      id: c.id,
      url: c.url,
      urlHash: createHash('sha256').update(c.url).digest('hex'),
      title: c.title,
      snippet: c.snippet,
      domain: c.domain,
      platform: c.platform,
      keyword: c.keyword,
      source: c.source,
      status: c.status as CrawlerLinkStatus,
      note: c.note,
      createUid: c.createUid,
      auditUid: null,
      auditTime: null,
      createTime: now,
      updateTime: now,
    })),
  );

  const logRows: LogSeedRow[] = [
      { userType: 'user', uid: 3, tempId: null, action: 'image_upload', targetType: LogTargetType.Image, targetId: 109, detail: 'IMG_0031.jpg, size=11269856, type=jpeg, album=1', ip: '114.88.22.10', ua: 'iOS Safari', result: 1, createTime: '2026-09-26T10:02:00.000Z' },
      { userType: 'temp', uid: 3, tempId: 301, action: 'image_upload', targetType: LogTargetType.Image, targetId: 110, detail: 'IMG_0032.jpg, album=1', ip: '114.88.22.10', ua: 'iOS Safari', result: 1, createTime: '2026-09-26T10:05:00.000Z' },
      { userType: 'guest', uid: null, tempId: null, action: 'share_visit', targetType: LogTargetType.Link, targetId: 1, detail: 'link=1, images=6', ip: '114.88.22.10', ua: 'WeChat', result: 1, createTime: '2026-09-26T12:30:00.000Z' },
      { userType: 'user', uid: 2, tempId: null, action: 'album_create', targetType: LogTargetType.Album, targetId: 3, detail: '内部审稿 · 未定稿, visibility=admin', ip: '112.64.33.88', ua: 'Chrome', result: 1, createTime: '2026-09-27T02:20:00.000Z' },
      { userType: 'user', uid: 4, tempId: null, action: 'download_original', targetType: LogTargetType.Image, targetId: 107, detail: 'L1 无原图下载权限', ip: '223.104.5.7', ua: 'Chrome', result: 0, createTime: '2026-09-27T08:00:00.000Z' },
      { userType: 'user', uid: 1, tempId: null, action: 'login_failed', targetType: LogTargetType.User, targetId: null, detail: 'password mismatch', ip: '203.0.113.9', ua: 'curl/8.5', result: 0, createTime: '2026-09-28T01:00:00.000Z' },
      { userType: 'user', uid: 2, tempId: null, action: 'tag_merge', targetType: LogTargetType.Tag, targetId: 9, detail: 'from=21 to=9, moved=4 images', ip: '112.64.33.88', ua: 'Chrome', result: 1, createTime: '2026-09-28T03:00:00.000Z' },
      { userType: 'user', uid: 3, tempId: null, action: 'share_create', targetType: LogTargetType.Link, targetId: 1, detail: 'album=1, coser=4, snapshot=0, expire=2026-11-15', ip: '114.88.22.10', ua: 'Chrome', result: 1, createTime: '2026-09-26T12:00:00.000Z' },
      { userType: 'system', uid: null, tempId: null, action: 'cron_expire_share', targetType: LogTargetType.Link, targetId: 3, detail: '到期自动失效 1 条', ip: '-', ua: 'scheduler', result: 1, createTime: '2026-09-16T00:05:00.000Z' },
      { userType: 'user', uid: 1, tempId: null, action: 'settings_update', targetType: LogTargetType.Site, targetId: null, detail: 'watermark.enabled=false', ip: '112.64.33.88', ua: 'Chrome', result: 1, createTime: '2026-09-29T02:00:00.000Z' },
      { userType: 'user', uid: 3, tempId: null, action: 'temp_create', targetType: LogTargetType.Temp, targetId: 301, detail: 'code=PK-2026-0913, flags=preview,download,editTag', ip: '114.88.22.10', ua: 'Chrome', result: 1, createTime: '2026-09-13T02:00:00.000Z' },
      { userType: 'user', uid: 4, tempId: null, action: 'batch_visibility', targetType: LogTargetType.Image, targetId: 103, detail: 'target=public, rejected=SET_PUBLIC_FORBIDDEN', ip: '223.104.5.7', ua: 'Chrome', result: 0, createTime: '2026-09-29T12:00:00.000Z' },
  ];
  await ds
    .getRepository(AuditLog)
    .insert(logRows.map((row) => ({ ...row, createTime: iso(row.createTime)! })));

  const counts = {
    users: await users.count(),
    temp_accounts: await temps.count(),
    albums: await ds.getRepository(Album).count(),
    images: await images.count(),
    files: await files.count(),
    share_links: await links.count(),
    settings: await ds.getRepository(SiteSetting).count(),
  };
  await ds.destroy();
  // eslint-disable-next-line no-console
  console.log(
    `seed 完成：${JSON.stringify(counts)}\n` +
      `成员账号 admin/baize/acheng/xiaoman 与临时账号 PK-2026-0913/PK-2026-0920/PK-2026-0928 的口令都是 ${DEMO_PASSWORD}\n` +
      `演示图字节写入 ${env.storageRoot}`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('seed 失败：', err);
  process.exitCode = 1;
});
