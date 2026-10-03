/**
 * M3 拍展传图链路的真后端验真（不是 mock）：进程跑在 :3101，库是 piks_photo.db 的副本
 * piks_photo_verify.db，免得动另一个会话正在用的 :3000 与主库。
 * 覆盖：D27 点名交付的四级闸门（缺 tempId / 不存在 / 已过期 / 不在白名单）→ D31 的 stage
 * 建会话回显与落库、不传即回落相册阶段 → images.img_stage / upload_temp_id / upload_uid 与
 * 临时账号 used_space 的真实写入 → ImageView.stage 投影（成员/临时/游客三口径）→ 原图链接按
 * 临时账号的下载开关下发 → accountTail 自助销毁（改名后的线字段）与销毁前会话照常入库。
 */
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';

const API = process.env.API ?? 'http://127.0.0.1:3101/api/v1';
const DB =
  process.env.DB_FILE ?? 'C:/Users/javam/Documents/picture皮克社工作室/server/piks_photo_verify.db';
const PWD = process.env.PWD_DEMO ?? 'demo1234';

const require = createRequire(import.meta.url);
const Sqlite = require('C:/Users/javam/Documents/picture皮克社工作室/server/node_modules/better-sqlite3');
const db = new Sqlite(DB, { readonly: false });
db.pragma('busy_timeout = 5000');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  → ' + String(detail).slice(0, 220)}`);
}

async function call(path, { method = 'GET', token, body, raw } = {}) {
  const headers = {};
  if (raw !== undefined) headers['Content-Type'] = 'application/octet-stream';
  else if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, body: json, data: json?.data, code: json?.code, message: json?.message };
}

const login = async (u) =>
  (await call('/auth/login', { method: 'POST', body: { username: u, password: PWD } })).data?.accessToken;

/** 1x1 PNG + 随机 tEXt：既要是能被 sharp 解出的真图，又要每轮 md5 不同，免得撞 409 查重 */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
const BASE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
function png(nonce) {
  const iend = BASE_PNG.subarray(BASE_PNG.length - 12);
  const head = BASE_PNG.subarray(0, BASE_PNG.length - 12);
  const text = Buffer.from(`nonce\0${nonce}`, 'latin1');
  const type = Buffer.from('tEXt', 'ascii');
  const body = Buffer.concat([type, text]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(text.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, len, body, crc, iend]);
}

async function upload(token, { albumId, tempId, stage, bytes, filename }) {
  const md5 = createHash('md5').update(bytes).digest('hex');
  const created = await call('/uploads', {
    method: 'POST',
    token,
    body: {
      albumId,
      filename: filename ?? `verify-${md5.slice(0, 8)}.png`,
      fileSize: bytes.length,
      ...(tempId ? { tempId } : {}),
      ...(stage ? { stage } : {}),
      md5Client: md5,
    },
  });
  if (created.status !== 201 && created.status !== 200) return { created, done: null };
  const uploadId = created.data.uploadId;
  const put = await call(`/uploads/${uploadId}/chunk/0`, { method: 'PUT', token, raw: new Uint8Array(bytes) });
  const done = await call(`/uploads/${uploadId}/complete`, { method: 'POST', token, body: { md5Client: md5 } });
  return { created, put, done, uploadId, md5 };
}

const row = (sql, ...args) => db.prepare(sql).get(...args);
const TEMP = 301; // 柚子：白名单 [1,2]，原图下载关着，归属成员 3（阿澄）
const BEFORE_USED = Number(row('SELECT usedSpace FROM temp_accounts WHERE id = ?', TEMP).usedSpace);

/* ---------- 1. D27 点名交付的闸门 ---------- */
const acheng = await login('acheng');
check('acheng 登录拿到令牌', !!acheng);

const noTemp = await call('/uploads', {
  method: 'POST',
  token: acheng,
  body: { albumId: 1, filename: 'a.png', fileSize: 1000 },
});
check('不点名临时账号 → 400', noTemp.status === 400, `${noTemp.status} ${noTemp.code} ${noTemp.message}`);
check('400 的业务码是 VALIDATION_FAILED', noTemp.code === 'VALIDATION_FAILED', noTemp.code);

const ghostTemp = await call('/uploads', {
  method: 'POST',
  token: acheng,
  body: { albumId: 1, filename: 'a.png', fileSize: 1000, tempId: 999999 },
});
check('点名不存在的工单 → 404 TEMP_NOT_FOUND', ghostTemp.status === 404 && ghostTemp.code === 'TEMP_NOT_FOUND', `${ghostTemp.status} ${ghostTemp.code}`);

const expiredTemp = await call('/uploads', {
  method: 'POST',
  token: acheng,
  body: { albumId: 1, filename: 'a.png', fileSize: 1000, tempId: 303 },
});
check('点名已到期的工单 → 404（与不存在同口径，不区分）', expiredTemp.status === 404 && expiredTemp.code === 'TEMP_NOT_FOUND', `${expiredTemp.status} ${expiredTemp.code}`);

const offWhitelist = await call('/uploads', {
  method: 'POST',
  token: acheng,
  body: { albumId: 4, filename: 'a.png', fileSize: 1000, tempId: TEMP },
});
check('相册不在该工单白名单 → 403 NOT_IN_WHITELIST', offWhitelist.status === 403 && offWhitelist.code === 'NOT_IN_WHITELIST', `${offWhitelist.status} ${offWhitelist.code}`);
check('403 文案点名是哪本相册（便于当场看出配错了哪）', /阿澄的个人试机片/.test(offWhitelist.message ?? ''), offWhitelist.message);

const badStage = await call('/uploads', {
  method: 'POST',
  token: acheng,
  body: { albumId: 1, filename: 'a.png', fileSize: 1000, tempId: TEMP, stage: 'seed' },
});
check('stage 只能是 pre/post → 400', badStage.status === 400, `${badStage.status} ${badStage.code}`);

/* ---------- 2. D31：建会话带阶段、完成落库 ---------- */
const bytesPre = png(`pre-${randomBytes(6).toString('hex')}`);
const pre = await upload(acheng, { albumId: 1, tempId: TEMP, stage: 'pre', bytes: bytesPre });
check('建会话（album 1 + 工单 301 + stage=pre）→ 201', pre.created?.status === 201, `${pre.created?.status} ${pre.created?.message}`);
check('会话视图回显 stage=pre（完成行的阶段读的就是它）', pre.created?.data?.stage === 'pre', pre.created?.data?.stage);
check('分片 PUT 200', pre.put?.status === 200, `${pre.put?.status} ${pre.put?.code}`);
const preView = pre.done?.data ?? {};
check('complete → 200 且图片视图 stage=pre', pre.done?.status === 200 && preView.stage === 'pre', `${pre.done?.status} ${preView.stage}`);
check('图片归属＝被点名工单的创建者（upload_uid=3）', preView.uploadUid === 3, preView.uploadUid);
check('图片记上交付工单（upload_temp_id=301）', preView.uploadTempId === TEMP, preView.uploadTempId);
check('成员拿得到原图链接', typeof preView.links?.original === 'string', preView.links?.original);

const preRow = row('SELECT * FROM images WHERE id = ?', preView.id);
check('库里 img_stage 真写成 pre', preRow?.imgStage === 'pre', preRow?.imgStage);
check('库里 upload_temp_id 真写成 301', Number(preRow?.uploadTempId) === TEMP, preRow?.uploadTempId);
check('库里 upload_uid 真写成 3', Number(preRow?.uploadUid) === 3, preRow?.uploadUid);
const afterUsed = Number(row('SELECT usedSpace FROM temp_accounts WHERE id = ?', TEMP).usedSpace);
check('配额记在被点名工单头上（PRD 6.3，与已验收 mock 不同口径）', afterUsed === BEFORE_USED + bytesPre.length, `${BEFORE_USED} → ${afterUsed} / +${bytesPre.length}`);

/* ---------- 3. 不传 stage = 回落相册阶段 ---------- */
const bytesBare = png(`bare-${randomBytes(6).toString('hex')}`);
const bare = await upload(acheng, { albumId: 1, tempId: TEMP, bytes: bytesBare });
check('不传 stage 时会话回显 null', bare.created?.data?.stage === null, bare.created?.data?.stage);
check('不传 stage 时视图回落到相册的 post', bare.done?.data?.stage === 'post', bare.done?.data?.stage);
check('库里这一列保持 NULL（回落发生在投影层）', row('SELECT imgStage FROM images WHERE id = ?', bare.done?.data?.id)?.imgStage === null);

/* ---------- 4. 直传小图同一套口径 ---------- */
const bytesDirect = png(`direct-${randomBytes(6).toString('hex')}`);
const md5Direct = createHash('md5').update(bytesDirect).digest('hex');
const direct = await call(`/uploads/direct?albumId=1&filename=d-${md5Direct.slice(0, 8)}.png&tempId=${TEMP}&stage=pre&md5Client=${md5Direct}`, {
  method: 'POST',
  token: acheng,
  raw: new Uint8Array(bytesDirect),
});
check('直传带 tempId+stage → 201', direct.status === 201, `${direct.status} ${direct.code} ${direct.message}`);
check('直传落库 img_stage=pre', row('SELECT imgStage FROM images WHERE id = ?', direct.data?.id)?.imgStage === 'pre', direct.data?.stage);

/* ---------- 5. 投影：三种身份看同一本相册 ---------- */
const listed = await call('/albums/1/images?pageSize=100', { token: acheng });
const items = listed.data?.items ?? listed.data?.list ?? [];
check('相册列表 200 且非空', listed.status === 200 && items.length > 0, `${listed.status} n=${items.length}`);
check('每条图片都带 stage（前端按它分前期/后期段）', items.every((i) => i.stage === 'pre' || i.stage === 'post'), JSON.stringify([...new Set(items.map((i) => i.stage))]));
check('成员视角原图链接全下发', items.every((i) => typeof i.links?.original === 'string'), items.find((i) => !i.links?.original)?.id);
const seenPre = items.find((i) => i.id === preView.id);
check('新传的 pre 图在列表里就是 pre', seenPre?.stage === 'pre', seenPre?.stage);

/* 临时账号：先工单 301（下载关），再造一张开了下载的工单 */
const created301 = await call('/temp-accounts', {
  method: 'POST',
  token: await login('admin'),
  body: { displayName: '验真·可下载', wantLink: true, password: 'verifypass1', days: 1, albumIds: [1, 2], allowPreview: 1, allowDownload: 1, spaceQuota: 2_147_483_648 },
});
check('admin 建出可下载工单', created301.status === 201 && !!created301.data?.accessToken, `${created301.status} ${created301.code}`);
const openId = created301.data?.tempId;
const openToken = (await call('/auth/temp-token', { method: 'POST', body: { accessToken: created301.data.accessToken, password: 'verifypass1' } })).data?.accessToken;
check('专属链接口令换到临时令牌', !!openToken);

/** 301 的 access_token 种子是空的（真实工单由后台建号时才生成），直接在副本库里补一个再换令牌 */
db.prepare('UPDATE temp_accounts SET accessToken = ? WHERE id = ?').run('verify-301-token', TEMP);
const closedToken = (await call('/auth/temp-token', { method: 'POST', body: { accessToken: 'verify-301-token', password: PWD } })).data?.accessToken;
check('下载关着的工单也换到令牌', !!closedToken);
const listClosed = await call('/albums/1/images?pageSize=100', { token: closedToken });
const closedItems = listClosed.data?.items ?? listClosed.data?.list ?? [];
check('301 能读到自己白名单内的相册', listClosed.status === 200 && closedItems.length > 0, `${listClosed.status} ${listClosed.code}`);
check('301 的下载开关确实是关的（这条断言的前提）', row('SELECT allowDownload FROM temp_accounts WHERE id = ?', TEMP).allowDownload === 0);
check('没开下载开关的工单一条原图链接都拿不到', closedItems.every((i) => i.links?.original === null), closedItems.find((i) => i.links?.original)?.id);
check('但阶段与归属照常下发', closedItems.every((i) => (i.stage === 'pre' || i.stage === 'post') && typeof i.uploadUid === 'number'), JSON.stringify(closedItems[0] ?? {}).slice(0, 120));
check('开关关着时原图字节也拿不到 → 403', (await call(`/images/${closedItems[0]?.id}/original`, { token: closedToken })).status === 403);
const offListTemp = await call('/uploads', {
  method: 'POST',
  token: closedToken,
  body: { albumId: 4, filename: 'x.png', fileSize: 1000, tempId: TEMP },
});
check('D27 排在白名单之后：越界相册仍按 404 不存在回', offListTemp.status === 404 && offListTemp.code === 'NOT_IN_WHITELIST', `${offListTemp.status} ${offListTemp.code}`);
const listAsOpen = await call('/albums/1/images?pageSize=100', { token: openToken });
const openItems = listAsOpen.data?.items ?? listAsOpen.data?.list ?? [];
check('可下载工单能看到相册列表', listAsOpen.status === 200 && openItems.length > 0, `${listAsOpen.status} n=${openItems.length}`);
check('D31 阶段对工单同样下发', openItems.every((i) => i.stage === 'pre' || i.stage === 'post'), openItems[0]?.stage);
check('开了下载开关的工单拿到原图链接', openItems.every((i) => typeof i.links?.original === 'string'), openItems.find((i) => !i.links?.original)?.id);
check('工单看得到上传归属（要靠它判断仅本人上传）', openItems.every((i) => typeof i.uploadUid === 'number'), openItems[0]?.uploadUid);

const tempUpload = await call('/uploads', {
  method: 'POST',
  token: openToken,
  body: { albumId: 1, filename: 'x.png', fileSize: 1000, tempId: openId },
});
check('D27：临时账号连会话都建不出来 → 403 TEMP_UPLOAD_FORBIDDEN', tempUpload.status === 403 && tempUpload.code === 'TEMP_UPLOAD_FORBIDDEN', `${tempUpload.status} ${tempUpload.code}`);

const guestList = await call('/albums/1/images?pageSize=100');
const guestItems = guestList.data?.items ?? guestList.data?.list ?? [];
check('公开相册游客可读', guestList.status === 200 && guestItems.length > 0, `${guestList.status}`);
check('游客也带 stage（阶段不是内部信息）', guestItems.every((i) => i.stage === 'pre' || i.stage === 'post'), guestItems[0]?.stage);
check('游客原图链接恒空', guestItems.every((i) => i.links?.original === null), guestItems.find((i) => i.links?.original)?.id);
check('游客看不到上传归属（PRD 12.8）', guestItems.every((i) => i.uploadUid === null), guestItems[0]?.uploadUid);

/* ---------- 6. accountTail 自助销毁（改名后的字段） ---------- */
const notTemp = await call('/auth/temp-destroy', { method: 'POST', token: acheng, body: { accountTail: '202601' } });
check('成员调用自助销毁 → 403 TEMP_ONLY', notTemp.status === 403 && notTemp.code === 'TEMP_ONLY', `${notTemp.status} ${notTemp.code}`);

const wrongTail = await call('/auth/temp-destroy', { method: 'POST', token: openToken, body: { accountTail: '000000' } });
check('尾号不对 → 400 CONFIRM_MISMATCH 且账号还在', wrongTail.status === 400 && wrongTail.code === 'CONFIRM_MISMATCH', `${wrongTail.status} ${wrongTail.code}`);
const staleKey = await call('/auth/temp-destroy', { method: 'POST', token: openToken, body: { accountTail: '000000', confirmNo: '000000' } });
check('旧字段 confirmNo 已不在契约里（带上就被白名单管道拒掉）', staleKey.status === 400 && staleKey.code !== 'CONFIRM_MISMATCH', `${staleKey.status} ${staleKey.code}`);

/** 会话建在销毁之前：交付对象没了之后 complete 必须失败，而不是悄悄改挂到上传者头上 */
const bytesOrphan = png(`orphan-${randomBytes(6).toString('hex')}`);
const orphanCreated = await call('/uploads', {
  method: 'POST',
  token: acheng,
  body: { albumId: 1, filename: 'orphan.png', fileSize: bytesOrphan.length, tempId: openId, stage: 'post' },
});
const orphanId = orphanCreated?.data?.uploadId;
await call(`/uploads/${orphanId}/chunk/0`, { method: 'PUT', token: acheng, raw: new Uint8Array(bytesOrphan) });
check('销毁前会话建得出来（工单当时还活着）', orphanCreated?.status === 201 && !!orphanId, `${orphanCreated?.status} ${orphanCreated?.code}`);

const tail = String(created301.data?.accountNo ?? '').slice(-6);
const destroyed = await call('/auth/temp-destroy', { method: 'POST', token: openToken, body: { accountTail: tail } });
check(`回传帐户ID 后 6 位（${tail}）即销毁`, destroyed.status === 200 && destroyed.data?.destroyed === true, `${destroyed.status} ${destroyed.code}`);
check('销毁落库为 disabled=1，行不删', row('SELECT disabled FROM temp_accounts WHERE id = ?', openId)?.disabled === 1);

const afterDestroy = await call(`/uploads/${orphanId}/complete`, {
  method: 'POST',
  token: acheng,
  body: { md5Client: createHash('md5').update(bytesOrphan).digest('hex') },
});
check('销毁前建好的会话仍能入库（D15：已上传资源与归属一律保留）', afterDestroy.status === 200, `${afterDestroy.status} ${afterDestroy.code} ${afterDestroy.message}`);
check('入库的图仍记在已销毁的工单头上，不悄悄改挂上传者', Number(afterDestroy.data?.uploadTempId) === Number(openId), `${afterDestroy.data?.uploadTempId} vs ${openId}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过${failed.length ? '：' + failed.map((f) => f.name).join(' | ') : ''}`);
db.close();
process.exit(failed.length ? 1 : 0);
