// M3 分享链接 + 公开返图页通道（真后端 :3000）端到端验收。
// 对着已验收的 mock 行为逐条打真接口：动态/快照两种口径、口令解锁与子会话 Cookie、
// 过期 410 与注销 404 同口径、集合外图片 404、禁下载、访客标签口径、
// 建链/列表/撤销的逐身份权限位。
// 跑之前确认 node dist/main.js 在 3000 上活着，且 piks_photo.db 已 seed。
const API = process.env.API ?? 'http://127.0.0.1:3000/api/v1';
const PWD = process.env.PWD_DEMO ?? 'demo1234';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + String(detail).slice(0, 220) : ''}`);
}

async function req(path, { method = 'GET', token, cookie, body, raw } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 字节路由不是 JSON */
  }
  return { status: res.status, headers: res.headers, body: json, text };
}

const login = async (username) => (await req('/auth/login', { method: 'POST', body: { username, password: PWD } })).body?.data?.accessToken;

const tok = { l4: await login('admin'), l3: await login('baize'), l2: await login('acheng') };
if (!tok.l3) {
  console.log('登录失败，检查 seed 与 PWD_DEMO（当前 ' + PWD + '）');
  process.exit(1);
}

const YOUZI = 'pk-youzi-cp29-a7f3'; // 相册口径 · 动态 · 可下载 · 无口令
const QINGYE = 'pk-qingye-ido-91c2'; // 相册口径 · 快照 · 禁下载 · 口令 qingye
const PERSON = 'pk-person-qingye-4d18'; // person 口径 · 跨相册
const youzi = await req(`/public/share/${YOUZI}`);
const view = youzi.body?.data ?? {};
check('无口令链接访客页 200', youzi.status === 200, youzi.status);
check('动态口径忽略图片自身档位（命中 6 张含 member 档）', view.total === 6, `total=${view.total}`);
check('相册口径页头字段', view.scope === 'album' && view.albumName.includes('CP29') && view.coserName === '柚子', `${view.scope}/${view.albumName}/${view.coserName}`);
check('allowDownload 透传且 needPassword=false', view.allowDownload === true && view.needPassword === false, `${view.allowDownload}/${view.needPassword}`);
check('访客预览改走公开通道', (view.images ?? []).every((i) => i.links.preview.includes(`/public/share/${YOUZI}/images/${i.id}/preview`)), view.images?.[0]?.links?.preview);
check('可下载时 original 指向公开通道', view.images?.[0]?.links?.original?.endsWith('/original') === true, view.images?.[0]?.links?.original);
const ids = (view.images ?? []).map((i) => i.id).sort((a, b) => a - b);
check('命中集合 = coser 标签逐张命中（101,102,105,108,109,110）', ids.join() === '101,102,105,108,109,110', ids.join());
check('排序按册内 sort', (view.images ?? []).map((i) => i.sort).join() === '1,2,5,8,9,10', (view.images ?? []).map((i) => i.sort).join());
const visitorTags = new Set((view.images ?? []).flatMap((i) => (i.tags ?? []).map((t) => t.type)));
check('访客标签只剩 event/role（status 不外泄）', [...visitorTags].every((t) => t === 'event' || t === 'role'), [...visitorTags].join());

const pv = await req(`/public/share/${YOUZI}/images/101/preview`, { raw: true });
const pvBytes = pv.ok ? await pv.arrayBuffer() : null;
check('预览字节 200 · image/webp · 非空', pv.status === 200 && (pv.headers.get('content-type') ?? '').includes('image/webp') && (pvBytes?.byteLength ?? 0) > 0, `${pv.status}/${pv.headers.get('content-type')}/${pvBytes?.byteLength}`);
const org = await req(`/public/share/${YOUZI}/images/101/original`, { raw: true });
const orgBytes = org.ok ? await org.arrayBuffer() : null;
check('原图字节 200 且按附件下发（RFC5987 中文安全）', org.status === 200 && /filename\*=UTF-8''/i.test(org.headers.get('content-disposition') ?? '') && (orgBytes?.byteLength ?? 0) > 0, `${org.status}/${org.headers.get('content-disposition')}/${orgBytes?.byteLength}`);

const offSet = await req(`/public/share/${YOUZI}/images/201/preview`);
check('集合外图片 ID 回 404 而非 403（不留存在性提示）', offSet.status === 404, `${offSet.status}/${offSet.body?.code}`);
const ghost = await req('/public/share/pk-does-not-exist-0000');
const revoked = await req(`/public/share/pk-revoked-0002`);
check('不存在的 token 与注销的 token 同口径 404', ghost.status === 404 && revoked.status === 404 && ghost.status === revoked.status, `${ghost.status}/${revoked.status}`);
const ghostByte = await req('/public/share/pk-does-not-exist-0000/images/101/preview');
check('注销/不存在链接的字节路由同样 404', (await req(`/public/share/pk-revoked-0002/images/101/preview`)).status === 404 && ghostByte.status === 404, `${ghostByte.status}`);
const expired = await req('/public/share/pk-expired-0001');
check('过期链接 410 LINK_EXPIRED', expired.status === 410 && expired.body?.code === 'LINK_EXPIRED', `${expired.status}/${expired.body?.code}`);
check('响应体里没有口令哈希', !JSON.stringify(view ?? {}).includes('$2b$'));

// —— 口令链路：没过口令连字节都拿不到（比 mock 更严，mock 的 shareImage 不校验会话）——
const locked = await req(`/public/share/${QINGYE}`);
check('口令链接未解锁 403 SHARE_PASSWORD_REQUIRED', locked.status === 403 && locked.body?.code === 'SHARE_PASSWORD_REQUIRED', `${locked.status}/${locked.body?.code}`);
const lockedByte = await req(`/public/share/${QINGYE}/images/203/preview`);
check('口令未过时预览也挡住（堵死猜 ID 绕过）', lockedByte.status === 403, `${lockedByte.status}/${lockedByte.body?.code}`);
const bad = await req(`/public/share/${QINGYE}/unlock`, { method: 'POST', body: { password: 'wrong' } });
check('错口令 401 BAD_CREDENTIALS 且不发 Cookie', bad.status === 401 && bad.body?.code === 'BAD_CREDENTIALS' && !bad.headers.get('set-cookie'), `${bad.status}/${bad.body?.code}`);
const noClass = await req(`/public/share/${QINGYE}/unlock`, { method: 'POST', body: { password: 'qingye', extraKey: 1 } });
check('解锁体多余字段被白名单挡在 400', noClass.status === 400, noClass.status);
const ok = await req(`/public/share/${QINGYE}/unlock`, { method: 'POST', body: { password: 'qingye' }, raw: true });
const setCookie = ok.headers.getSetCookie?.()[0] ?? '';
const cookie = setCookie.split(';')[0];
check('正确口令 200 并挂 HttpOnly 子会话 Cookie', ok.status === 200 && cookie.startsWith('pk_share=') && /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie), setCookie.slice(0, 140));
check('Cookie 路径收窄到本条链接', setCookie.match(/Path=([^;]*)/)?.[1] === `/api/v1/public/share/${QINGYE}`, setCookie.match(/Path=[^;]*/)?.[0]);

const unlocked = await req(`/public/share/${QINGYE}`, { cookie });
const uv = unlocked.body?.data ?? {};
check('解锁后访客页 200', unlocked.status === 200, unlocked.status);
check('快照口径固定在建链那两张（203,205）', uv.total === 2 && (uv.images ?? []).map((i) => i.id).join() === '203,205', `${uv.total}/${(uv.images ?? []).map((i) => i.id).join()}`);
check('禁下载时 original 为 null', uv.images?.[0]?.links?.original === null, uv.images?.[0]?.links?.original);
const uPv = await req(`/public/share/${QINGYE}/images/203/preview`, { cookie, raw: true });
check('解锁后能取预览字节', uPv.status === 200 && (await uPv.arrayBuffer()).byteLength > 0, uPv.status);
const uOrg = await req(`/public/share/${QINGYE}/images/203/original`, { cookie });
check('allowDownload=0 时原图 403', uOrg.status === 403, `${uOrg.status}/${uOrg.body?.code}`);
const uOff = await req(`/public/share/${QINGYE}/images/101/preview`, { cookie });
check('解锁后集合外仍是 404', uOff.status === 404, uOff.status);
const forged = await req(`/public/share/${QINGYE}`, { cookie: `pk_share=${tok.l3}` });
check('成员令牌冒充子会话无效（两套密钥隔离）', forged.status === 403, `${forged.status}/${forged.body?.code}`);

// —— person 口径：跨相册汇总，每次读取重算可对外相册 ——
const person = await req(`/public/share/${PERSON}`);
const pview = person.body?.data ?? {};
check('返给个人页 200 且 scope=person', person.status === 200 && pview.scope === 'person', `${person.status}/${pview.scope}`);
check('跨册命中并列出来源相册', (pview.images ?? []).length > 0 && pview.albumNames.length >= 1, `${(pview.images ?? []).length} 张 / 来源 [${(pview.albumNames ?? []).join('|')}]`);
const crossIds = new Set((pview.images ?? []).map((i) => i.albumId));
check('来源相册名与图片实际所在册一一对应', (pview.albumNames ?? []).length === crossIds.size, `所在册 ${[...crossIds].join()} / 页头 [${(pview.albumNames ?? []).join('|')}]`);

// —— 建链 / 列表 / 撤销 ——
const created = await req('/albums/1/share-links', {
  method: 'POST',
  token: tok.l3,
  body: { tagIds: [4], snapshot: false, allowDownload: true, expireDays: 7, password: 'pk-verify' },
});
const cv = created.body?.data ?? {};
check('相册口径建链 201', created.status === 201 && !!cv.shareToken, `${created.status}/${cv.shareToken}`);
check('url 用配置的站点地址而不是请求 Host', /^http:\/\/localhost:5176\/s\/pk-/.test(cv.url ?? ''), cv.url);
check('口令只在创建时经手，回包里 hasPassword=true 且无哈希', cv.hasPassword === true && !JSON.stringify(cv).includes('$2b$'), cv.hasPassword);
check('expireDays 生效（≈7 天）', Math.abs(new Date(cv.expireTime).getTime() - Date.now() - 7 * 864e5) < 36e5, cv.expireTime);
check('建链即回命中张数与来源相册名', cv.imageCount === 6 && (cv.albumNames ?? []).length === 1, `${cv.imageCount}/[${(cv.albumNames ?? []).join('|')}]`);

const emptySnap = await req('/albums/1/share-links', { method: 'POST', token: tok.l3, body: { tagIds: [999], snapshot: true } });
check('快照零命中 400 EMPTY_SNAPSHOT', emptySnap.status === 400 && emptySnap.body?.code === 'EMPTY_SNAPSHOT', `${emptySnap.status}/${emptySnap.body?.code}`);
const lockAlbum = await req('/albums/6/share-links', { method: 'POST', token: tok.l3, body: {} });
check('锁定相册建链被挡', lockAlbum.status !== 201, `${lockAlbum.status}/${lockAlbum.body?.code}`);
const adminAlbum = await req('/albums/3/share-links', { method: 'POST', token: tok.l3, body: {} });
check('admin 档相册建链被挡（源头不收档位外内容）', adminAlbum.status !== 201, `${adminAlbum.status}/${adminAlbum.body?.code}`);

const personal = await req('/share-links/personal', { method: 'POST', token: tok.l3, body: { coserTagId: 5, allowDownload: true } });
check('返给个人建链 201 且 scope=person', personal.status === 201 && personal.body?.data?.scope === 'person', `${personal.status}/${personal.body?.data?.scope}`);
const noCoser = await req('/share-links/personal', { method: 'POST', token: tok.l3, body: { allowDownload: true } });
check('缺 Coser 400 VALIDATION_FAILED', noCoser.status === 400 && noCoser.body?.code === 'VALIDATION_FAILED', `${noCoser.status}/${noCoser.body?.code}`);
const eventTag = await req('/share-links/personal', { method: 'POST', token: tok.l3, body: { coserTagId: 1 } });
check('非 coser 类型 400 TAG_TYPE_WRONG', eventTag.status === 400 && eventTag.body?.code === 'TAG_TYPE_WRONG', `${eventTag.status}/${eventTag.body?.code}`);

const asAdmin = await req('/share-links', { token: tok.l3 });
const asOwner = await req('/share-links', { token: tok.l2 });
const adminLinks = asAdmin.body?.data ?? [];
const ownerLinks = asOwner.body?.data ?? [];
check('L3 看全站链接、L2 只看本人创建', adminLinks.length > ownerLinks.length && ownerLinks.every((l) => l.createUid === 3), `L3=${adminLinks.length} L2=${ownerLinks.length}`);
check('清单里口令位来自库而不是实体（青野链 hasPassword=true）', adminLinks.find((l) => l.shareToken === QINGYE)?.hasPassword === true, adminLinks.find((l) => l.shareToken === QINGYE)?.hasPassword);
check('已撤销链接在清单里标 expired 且只读过滤生效', adminLinks.some((l) => l.shareToken === 'pk-revoked-0002' && l.revoked === 1) && !(await req('/share-links?onlyAlive=1', { token: tok.l3 })).body?.data?.some((l) => l.shareToken === 'pk-revoked-0002'), '');
const scoped = await req('/share-links?album=7', { token: tok.l3 });
const scopedLinks = scoped.body?.data ?? [];
check('按相册过滤只留本册链接与跨册命中该册的链接', scopedLinks.every((l) => l.albumId === 7 || l.scope === 'person'), `${scopedLinks.length} 条 [${scopedLinks.map((l) => l.shareToken).join()}]`);

const notOwner = await req(`/share-links/${cv.id}`, { method: 'DELETE', token: tok.l2 });
check('非本人撤销 403 NOT_OWNER', notOwner.status === 403 && notOwner.body?.code === 'NOT_OWNER', `${notOwner.status}/${notOwner.body?.code}`);
const revokedSelf = await req(`/share-links/${cv.id}`, { method: 'DELETE', token: tok.l3 });
check('本人撤销成功并回 revoked=1', revokedSelf.status === 200 && revokedSelf.body?.data?.revoked === 1, `${revokedSelf.status}/${revokedSelf.body?.data?.revoked}`);
const afterRevoke = await req(`/public/share/${cv.shareToken}`);
check('撤销后访客页立即 404', afterRevoke.status === 404, afterRevoke.status);

const bump = await req(`/public/share/${YOUZI}`);
const listed = (await req('/share-links', { token: tok.l3 })).body?.data ?? [];
const youziRow = listed.find((l) => l.shareToken === YOUZI);
check('每次访问累计 visitCount/lastVisitTime', youziRow?.visitCount >= 2 && !!youziRow?.lastVisitTime, `${youziRow?.visitCount}/${youziRow?.lastVisitTime}`);
// 审计写入（share_link_create / share_link_revoke / share_view）走 logs 表，GET /admin/logs 还没实现，用 sqlite 直接核。

const failed = results.filter((r) => !r.ok);
console.log(`\n合计 ${results.length} 项，FAIL ${failed.length} 项${failed.length ? '：\n  - ' + failed.map((f) => f.name).join('\n  - ') : ''}`);
process.exit(failed.length ? 1 : 0);
