// 前后端契约修正验真（真后端 :3000）：/auth/me 的 position+serverTime+capsOverridden、
// D21 按人覆盖的生效与回显、临时账号的 accountId、设置 PUT 不带 remark、标签 suggest 空关键词拉池子。
// 前置：xiaoman(L1) 的 feature_grants 由外部脚本临时写入 {"zip":1}，跑完还原。
const API = process.env.API ?? 'http://127.0.0.1:3000/api/v1';
const PWD = process.env.PWD_DEMO ?? 'demo1234';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + String(detail).slice(0, 200) : ''}`);
}

async function call(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, body: json, text };
}

const login = async (u) => (await call('/auth/login', { method: 'POST', body: { username: u, password: PWD } })).body?.data?.accessToken;

const me = await call('/auth/me', { token: await login('baize') });
const p = me.body?.data ?? {};
check('GET /auth/me 200', me.status === 200, me.status);
check('position 有值（页头「名称+职务」与共享文件夹副标题都读它）', typeof p.position === 'string' && p.position.length > 0, JSON.stringify(p.position));
check('serverTime 可解析（销毁倒计时靠它校准本机时钟）', !Number.isNaN(Date.parse(p.serverTime ?? '')), p.serverTime);
check('capabilities 与 capsOverridden 形状齐备', !!p.capabilities && Array.isArray(p.capsOverridden), JSON.stringify(p.capsOverridden));

const l1 = await call('/auth/me', { token: await login('xiaoman') });
const l1p = l1.body?.data ?? {};
check('D21 强制开生效：L1 被授予 zip 后 capabilities.zip=true', l1p.capabilities?.zip === true, JSON.stringify(l1p.capabilities?.zip));
check('D21 回显：只有被覆盖的那几位进 capsOverridden', JSON.stringify(l1p.capsOverridden) === '["zip"]', JSON.stringify(l1p.capsOverridden));
check('未覆盖的能力位仍按等级默认（L1 原图下载默认关）', l1p.capabilities?.download === false, JSON.stringify(l1p.capabilities?.download));

const tempTok = await login('pk-2026-0913');
const tempMe = await call('/auth/me', { token: tempTok });
const tp = tempMe.body?.data ?? {};
check('临时账号登录并取到身份', tempMe.status === 200 && tp.kind === 'temp', `${tempMe.status}/${tp.kind ?? tempMe.body?.code}`);
check('临时身份带 accountId（自助销毁要输它的后 6 位）', typeof tp.accountId === 'string' && tp.accountId.length > 0, tp.accountId);
check('临时身份带 serverTime 且 expiresAt 是 ISO 串', !Number.isNaN(Date.parse(tp.serverTime ?? '')) && /T.*Z/.test(tp.expiresAt ?? ''), `${tp.serverTime}/${tp.expiresAt}`);

const admin = await login('admin');
const putNoRemark = await call('/admin/settings', {
  method: 'PUT',
  token: admin,
  body: { entries: [{ key: 'watermark.position', value: '右下角' }] },
});
check('设置保存不带 remark 不再被白名单打成 400', putNoRemark.status === 200, `${putNoRemark.status}/${putNoRemark.body?.code ?? ''}/${(putNoRemark.body?.message ?? '').slice(0, 60)}`);
const back = await call('/admin/settings', { token: admin });
const row = (back.body?.data ?? []).find?.((s) => s.key === 'watermark.position') ?? (back.body?.data?.list ?? []).find?.((s) => s.key === 'watermark.position');
check('写回的值读得到', row?.value === '右下角', JSON.stringify(row));
await call('/admin/settings', { method: 'PUT', token: admin, body: { entries: [{ key: 'watermark.position', value: '右下' }] } });

const pool = await call('/tags/suggest?type=coser&q=', { token: admin });
const poolList = pool.body?.data ?? [];
check('空关键词拉出标签池（打标选择器的默认列表）', pool.status === 200 && poolList.length > 0, `${pool.status}/${poolList.length} 个`);
const noQ = await call('/tags/suggest?type=coser', { token: admin });
check('完全不传 q 也当空关键词处理', noQ.status === 200 && (noQ.body?.data ?? []).length === poolList.length, `${noQ.status}/${(noQ.body?.data ?? []).length}`);
const one = await call('/tags/suggest?q=' + encodeURIComponent('柚子'), { token: admin });
check('带关键词仍是精确收窄', (one.body?.data ?? []).length === 1 && one.body.data[0].name === '柚子', JSON.stringify((one.body?.data ?? []).map((t) => t.name)));
const byType = await call('/tags/suggest?type=event&q=', { token: admin });
check('按类型过滤在池子模式下也生效', (byType.body?.data ?? []).every((t) => t.type === 'event') && (byType.body?.data ?? []).length > 0, `${(byType.body?.data ?? []).length} 个`);

const failed = results.filter((r) => !r.ok);
console.log(`\n合计 ${results.length} 项，FAIL ${failed.length} 项${failed.length ? '：\n  - ' + failed.map((f) => f.name).join('\n  - ') : ''}`);
process.exit(failed.length ? 1 : 0);
