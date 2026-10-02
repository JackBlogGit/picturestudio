/**
 * D25「相册级功能开关」的端到端验证（PRD 6.5）。纯 mock，权限数据活在页面内存里，
 * 所以全程不刷新：身份走顶栏「演示身份」，换页走 router.push。
 * 覆盖：L4 关 5 项 → 前台详情页／多选条／预览三处自适应 → 内核层证据（批量打包逐条 403、
 * 建链 403、原图链接直接为 null、相册自身管理豁免）→ 子相册继承父册 → L3 看不到开关入口 →
 * L2 在关掉改档位的册 2 上批量改档位被拒 → tempAccess 关闭前后临时账号列表／详情／取图三处对照 → 复原。
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const PROFILE = OUT + 'edge-profile-caps/';
const PORT = 9237;
const APP = 'http://127.0.0.1:5173';
const CHILD_NAME = 'D25 继承测试子册';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass });
  console.log((pass ? '  OK  ' : '  FAIL ') + name + (detail === undefined ? '' : ' — ' + detail));
}

const browser = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--window-size=1440,1000',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    '--disable-gpu',
    '--hide-scrollbars',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

function cleanup() {
  spawn('taskkill', ['-PID', String(browser.pid), '-T', '-F'], { stdio: 'ignore' });
}
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, (err) => {
    console.error('FATAL', err?.message ?? err);
    cleanup();
    process.exit(1);
  });
}

async function getVersion() {
  for (let i = 0; i < 60; i += 1) {
    try {
      return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    } catch {
      await sleep(300);
    }
  }
  throw new Error('edge devtools never came up');
}

let id = 0;
const pending = new Map();
let ws;

function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const msgId = (id += 1);
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
  });
}

const version = await getVersion();
ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${msg.error.code} ${msg.error.message}`));
    else resolve(msg.result);
  }
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const call = (method, params = {}) => send(method, params, sessionId);
await call('Page.enable');
await call('Runtime.enable');
await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

async function evalJs(expression) {
  const res = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
  }
  return res.result.value;
}

/** 页面里的探针一律返回 JSON 字符串，Node 侧再 parse */
async function probe(expression) {
  const raw = await evalJs(expression);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function goto(token, path) {
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('piks.accessToken', ${JSON.stringify(token)});`,
  });
  await call('Page.navigate', { url: APP + path });
  await sleep(2400);
}

async function click(selector, text, { index } = {}) {
  const done = await evalJs(`(() => {
    let els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    if (${JSON.stringify(text ?? '')}) els = els.filter((e) => e.innerText.trim().includes(${JSON.stringify(text ?? '')}));
    if (!els.length) return 'missing:' + ${JSON.stringify(selector)};
    els[${index ?? 0}].click();
    return 'clicked';
  })()`);
  await sleep(text === '演示身份' ? 700 : 900);
  return done;
}

/** 不刷新换页：优先拿 Vue Router 实例，拿不到再退回 pushState + popstate */
async function nav(path) {
  const how = await evalJs(`(async () => {
    const router = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$router;
    if (router) {
      await router.push(${JSON.stringify(path)});
      return 'router:' + router.currentRoute.value.fullPath;
    }
    history.pushState({}, '', ${JSON.stringify(path)});
    window.dispatchEvent(new PopStateEvent('popstate'));
    return 'pushState:' + location.pathname;
  })()`);
  await sleep(1300);
  return how;
}

async function identity(label) {
  await click('.pk-header__user button', '演示身份');
  await click('.el-dropdown-menu__item', label);
  await sleep(900);
  return (await probe(WHO)).who;
}

async function shot(file) {
  const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(OUT + file, Buffer.from(data, 'base64'));
  console.log('  wrote', file);
}

const WHO = `(() => JSON.stringify({
  who: document.querySelector('.pk-identity')?.innerText.trim().replace(/\\s+/g, ' ') ?? null,
  path: location.pathname + location.search,
  toasts: (window.__toasts ?? []).length,
}))()`;

const ADMIN = `(() => JSON.stringify({
  who: document.querySelector('.pk-identity')?.innerText.trim().replace(/\\s+/g, ' ') ?? null,
  rows: [...document.querySelectorAll('.el-table__row')].map((r) => ({
    name: r.querySelector('.pk-admin__link')?.innerText.trim() ?? '',
    capsBtn: [...r.querySelectorAll('button')].some((b) => b.innerText.includes('功能开关')),
    chips: [...r.querySelectorAll('.pk-album__caps .pk-chip')].map((c) => c.innerText.trim()),
  })),
}))()`;

const CAP_DIALOG = `(() => JSON.stringify({
  titles: [...document.querySelectorAll('.el-dialog__title')].map((t) => t.innerText.trim()),
  items: [...document.querySelectorAll('.pk-album__cap')].map((c) => {
    const sw = c.querySelector('.el-switch');
    const inp = sw?.querySelector('input');
    return {
      label: c.querySelector('b')?.innerText.trim() ?? '',
      on: inp ? inp.checked : !!sw?.classList.contains('is-checked'),
      disabled: inp ? inp.disabled : !!sw?.classList.contains('is-disabled'),
      from: !!c.querySelector('.pk-album__from'),
    };
  }),
}))()`;

const DETAIL = `(() => JSON.stringify({
  who: document.querySelector('.pk-identity')?.innerText.trim().replace(/\\s+/g, ' ') ?? null,
  capsLine: document.querySelector('.pk-detail-caps')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
  actions: [...document.querySelectorAll('.pk-detail-actions button')].map((b) => b.innerText.trim()),
  tiles: document.querySelectorAll('.pk-tile').length,
}))()`;

const BATCH = `(() => JSON.stringify({
  buttons: [...document.querySelectorAll('.pk-batchbar button')].map((b) => b.innerText.trim()).filter(Boolean),
  note: document.querySelector('.pk-batchbar__note')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
}))()`;

const PREVIEW = `(() => {
  const box = document.querySelector('.pk-preview');
  return JSON.stringify({
    open: !!box,
    actions: box?.querySelector('.pk-preview__actions')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
    hasLink: !!box?.querySelector('.pk-preview__actions a'),
  });
})()`;

const ALBUM_CARDS = `(() => JSON.stringify({
  empty: !!document.querySelector('.el-empty'),
  cards: [...document.querySelectorAll('.pk-masonry')].flatMap((m) =>
    [...m.children].map((c) => c.innerText.replace(/\\s+/g, ' ').trim().slice(0, 40)),
  ),
}))()`;

/** 打开某一行的「功能开关」弹窗 */
async function openCapsDialog(rowText) {
  const got = await evalJs(`(() => {
    const row = [...document.querySelectorAll('.el-table__row')].find((r) => r.innerText.includes(${JSON.stringify(rowText)}));
    const btn = [...(row?.querySelectorAll('button') ?? [])].find((b) => b.innerText.includes('功能开关'));
    if (!btn) return 'missing';
    btn.click();
    return 'clicked';
  })()`);
  await sleep(800);
  return got;
}

/** 点开关：按 ALBUM_CAP_KEYS 下标翻转（0 upload 1 editTag 2 changeVisibility 3 download 4 zip 5 shareLink 6 delete 7 tempAccess） */
async function toggleSwitches(indices) {
  const n = await evalJs(`(() => {
    const els = [...document.querySelectorAll('.pk-album__cap .el-switch')];
    for (const i of ${JSON.stringify(indices)}) els[i]?.click();
    return els.length;
  })()`);
  await sleep(500);
  return n;
}

async function saveCaps() {
  const before = (await probe(WHO)).toasts;
  await click('.el-dialog__footer button', '保存开关');
  await sleep(600);
  const all = JSON.parse(await evalJs('JSON.stringify(window.__toasts ?? [])'));
  return all.slice(before);
}

async function apiProbe(body) {
  return probe(`(async () => {
    const api = window.__api;
    if (!api) return JSON.stringify({ err: 'no __api' });
    const out = {};
    ${body}
    return JSON.stringify(out);
  })()`);
}

// ============ 0) 以 L4 进相册管理 ============
await goto('mock.user.1', '/admin/albums');
await evalJs(`(() => {
  window.__toasts = [];
  const seen = new WeakSet();
  const pick = () => {
    for (const el of document.querySelectorAll('.el-message')) {
      if (seen.has(el)) continue;
      seen.add(el);
      window.__toasts.push(el.innerText.trim().replace(/\\s+/g, ' '));
    }
  };
  new MutationObserver(pick).observe(document.body, { childList: true, subtree: true });
  pick();
})()`);
await evalJs(`(async () => { const m = await import('/src/api/client.ts'); window.__api = m.api; })()`);

const boot = await probe(ADMIN);
console.log('[身份]', boot.who, ' 行数', boot.rows.length);
const row1Before = boot.rows.find((r) => r.name.includes('雷电将军'));
check('L4 能看到「功能开关」入口', row1Before?.capsBtn === true, row1Before?.name);
check('初始册 1 无关闭标记', (row1Before?.chips ?? []).length === 0, row1Before?.chips.join('/'));

// ============ 1) 关掉册 1 的 5 项：传图/打标/原图下载/批量打包/建返图链接 ============
console.log('弹窗:', await openCapsDialog('雷电将军'));
const dlg1 = await probe(CAP_DIALOG);
const capTitle = (dlg1.titles ?? []).find((t) => t.includes('册内功能开关'));
check('开关弹窗 8 项齐全', dlg1.items.length === 8, dlg1.items.map((i) => i.label).join('|'));
check('弹窗标题带相册名', !!capTitle, capTitle);
check('初始全为允许', dlg1.items.length === 8 && dlg1.items.every((i) => i.on === true && !i.disabled));
check(
  '直连层 capsOff 基线为空（与页面同一份内存）',
  JSON.stringify((await apiProbe('out.off = (await api.get("/albums/1")).capsOff ?? [];')).off) === '[]',
);
await toggleSwitches([0, 1, 3, 4, 5]);
const toast1 = await saveCaps();
const admin1 = await probe(ADMIN);
const row1 = admin1.rows.find((r) => r.name.includes('雷电将军'));
console.log('[保存回执]', toast1.join(' | '));
check('保存回执出现', toast1.some((t) => t.includes('册内功能开关')));
check('列表出现 5 枚关闭标记', row1.chips.length === 5, row1.chips.join('/'));
await shot('caps-01-admin-chips.png');

// ============ 2) 前台册详情自适应 ============
console.log('[nav]', await nav('/albums/1'));
const d1 = await probe(DETAIL);
console.log('[册 1 头部]', d1.capsLine);
check('头部列出被关闭的功能', (d1.capsLine ?? '').includes('传图') && (d1.capsLine ?? '').includes('批量打包'), d1.capsLine);
check('「生成返图链接」不渲染', !d1.actions.some((a) => a.includes('生成返图链接')), d1.actions.join('|'));
check('「拍展传图」不渲染', !d1.actions.some((a) => a.includes('拍展传图')));
check('「新建子相册」仍在（相册管理不受约束）', d1.actions.some((a) => a.includes('新建子相册')));
check('册内图片照常可见', d1.tiles > 0, 'tiles=' + d1.tiles);
await shot('caps-02-detail.png');

await click('.pk-detail-actions button', '多选批处理');
const b1 = await probe(BATCH);
console.log('[多选条]', JSON.stringify(b1));
check('关闭打标后只剩批量改档位', b1.buttons.includes('改档位') && !b1.buttons.some((x) => x.includes('加标签')), b1.buttons.join('|'));
check('多选条给出关闭说明', (b1.note ?? '').includes('打标已被超管关闭'), b1.note);
await click('.pk-detail-actions button', '退出多选');
await sleep(400);

await evalJs(`(() => { document.querySelector('.pk-tile')?.click(); return 1; })()`);
await sleep(800);
const p1 = await probe(PREVIEW);
console.log('[预览侧栏]', p1.actions);
check('预览里原图下载换成关闭说明', (p1.actions ?? '').includes('原图下载已被超管关闭'), p1.actions);
check('且不再渲染下载链接', p1.hasLink === false);
await shot('caps-03-preview.png');
await click('.pk-preview .el-dialog__headerbtn');

// ============ 3) 内核层证据：不是只藏按钮，接口照样拦 ============
const kernel = await apiProbe(`
  const detail = await api.get('/albums/1');
  out.capsOff = detail.capsOff;
  const page = await api.get('/albums/1/images', { query: { page: 1, pageSize: 3 } });
  out.originals = page.list.map((i) => i.links.original);
  const ids = page.list.slice(0, 2).map((i) => i.id);
  try { out.zip = await api.post('/images/batch-zip', { imageIds: ids }); } catch (e) { out.zip = { threw: e.code }; }
  try { out.share = { ok: true }; await api.post('/albums/1/share-links', {}); } catch (e) { out.share = { code: e.code, status: e.status, message: e.message }; }
  try { out.self = 'OK ' + (await api.patch('/albums/1', { description: detail.description })).name; } catch (e) { out.self = 'ERR ' + e.code + ' ' + e.message; }
`);
console.log(
  '[内核] capsOff=',
  kernel.capsOff.join(','),
  ' zip回执=',
  JSON.stringify(kernel.zip?.rejected ?? kernel.zip),
);
check('接口层 capsOff 含 5 项', kernel.capsOff.length === 5, kernel.capsOff.join(','));
check('原图下载关闭后 links.original 直接为 null', kernel.originals.every((v) => v === null), JSON.stringify(kernel.originals));
const zipRejected = (kernel.zip?.rejected ?? [])[0];
check('批量打包逐条退回 403 ALBUM_CAP_CLOSED', zipRejected?.code === 'ALBUM_CAP_CLOSED' && zipRejected?.status === 403, JSON.stringify(zipRejected));
check('建返图链接被 403 拦下', kernel.share?.code === 'ALBUM_CAP_CLOSED', JSON.stringify(kernel.share));
check('相册自身管理豁免：关着打标仍能改相册简介', String(kernel.self).startsWith('OK '), kernel.self);

// ============ 4) 子相册继承父册 ============
console.log('[建子册弹窗]', await click('.pk-detail-actions button', '新建子相册'));
const filled = await evalJs(`(() => {
  const box = [...document.querySelectorAll('.el-dialog')].find((d) =>
    (d.querySelector('.el-dialog__title')?.innerText ?? '').includes('在本相册内新建子相册'));
  if (!box) return 'no dialog';
  const input = box.querySelector('input');
  input.value = ${JSON.stringify(CHILD_NAME)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.value;
})()`);
console.log('[子册名称]', filled);
await sleep(300);
const tCreate = (await probe(WHO)).toasts;
// 这个弹窗把按钮写在 body 里（没有 #footer 槽），所以只能按标题定位到弹窗再找按钮
const submitChild = await evalJs(`(() => {
  const box = [...document.querySelectorAll('.el-dialog')].find((d) =>
    (d.querySelector('.el-dialog__title')?.innerText ?? '').includes('在本相册内新建子相册'));
  const btn = [...(box?.querySelectorAll('button') ?? [])].find((b) => b.innerText.includes('创建子相册'));
  if (!btn) return 'missing';
  btn.click();
  return 'clicked';
})()`);
await sleep(1100);
console.log('[建子册提交]', submitChild, '回执', JSON.parse(await evalJs('JSON.stringify(window.__toasts.slice(' + tCreate + '))')).join(' | '));
const listAfter = await apiProbe(`
  const kids = await api.get('/albums/1/children');
  out.hit = (kids ?? []).find((a) => a.name === ${JSON.stringify(CHILD_NAME)}) ?? null;
  out.kidCount = (kids ?? []).length;
`);
console.log('[册 1 子册数]', listAfter.kidCount);
const child = listAfter.hit;
check('子相册创建成功', !!child, child ? 'id=' + child.id : 'no row');
check('子册有效关闭项继承父册 5 项', !!child && (child.capsOff ?? []).length === 5, (child?.capsOff ?? []).join(','));
check('子册自身没写 albumCaps（继承不落子册）', !!child && (child.capsOwnOff ?? []).length === 0, JSON.stringify(child?.capsOwnOff));
check('继承项单列为 capsInheritedOff', !!child && (child.capsInheritedOff ?? []).length === 5);

if (child) {
  console.log('[nav]', await nav('/admin/albums'));
  await sleep(600);
  console.log('[子册弹窗]', await openCapsDialog(CHILD_NAME));
  const dlgChild = await probe(CAP_DIALOG);
  const off = dlgChild.items.filter((i) => !i.on);
  console.log('[子册弹窗项]', dlgChild.items.map((i) => i.label + ':' + i.on + (i.disabled ? '/锁' : '') + (i.from ? '/父' : '')).join(' '));
  check('子册弹窗 5 项显示为关闭且锁定', off.length === 5 && off.every((i) => i.disabled), off.length + ' off');
  check('锁定项标注「由父相册关闭」', off.length === 5 && off.every((i) => i.from));
  check('未继承的 3 项仍可编辑', dlgChild.items.filter((i) => i.on && !i.disabled).length === 3);
  await shot('caps-04-child-dialog.png');
  await click('.el-dialog__footer button', '取消');

  console.log('[nav]', await nav('/albums/' + child.id));
  const cd = await probe(DETAIL);
  console.log('[子册头部]', cd.capsLine);
  check('子册详情提示父册带下来', (cd.capsLine ?? '').includes('需回父册打开'), cd.capsLine);
} else {
  console.log('  SKIP 子相册未创建，继承相关检查跳过');
}

// ============ 5) L3 没有开关入口，但看得见关闭结果 ============
console.log('[切身份]', await identity('L3 管理员'));
console.log('[nav]', await nav('/admin/albums'));
const asL3 = await probe(ADMIN);
const row1L3 = asL3.rows.find((r) => r.name.includes('雷电将军'));
console.log('[L3 行]', asL3.rows.length, '行 · 有按钮的行', asL3.rows.filter((r) => r.capsBtn).length);
check('L3 看不到「功能开关」按钮', asL3.rows.every((r) => !r.capsBtn));
check('L3 仍看得见关闭标记', (row1L3?.chips ?? []).length === 5, row1L3?.chips.join('/'));
await shot('caps-05-l3-admin.png');

// ============ 6) 册 2 关「改档位 + 批量打包」，L2 的批量改档位被拒 ============
console.log('[切身份]', await identity('L4 超管'));
console.log('[nav]', await nav('/admin/albums'));
await openCapsDialog('芙莉莲');
await toggleSwitches([2, 4]);
console.log('[册 2 保存]', (await saveCaps()).join(' | '));
const admin2 = await probe(ADMIN);
check('册 2 出现 2 枚标记', (admin2.rows.find((r) => r.name.includes('芙莉莲'))?.chips ?? []).length === 2);

console.log('[切身份]', await identity('L2 成员'));
console.log('[nav]', await nav('/albums/2'));
const d2 = await probe(DETAIL);
check('册 2 头部只列改档位与批量打包', /改档位/.test(d2.capsLine ?? '') && /批量打包/.test(d2.capsLine ?? '') && !/传图/.test(d2.capsLine ?? ''), d2.capsLine);
await click('.pk-detail-actions button', '多选批处理');
const b2 = await probe(BATCH);
console.log('[册 2 多选条]', JSON.stringify(b2));
check('改档位按钮被摘下、打标保留', !b2.buttons.includes('改档位') && b2.buttons.some((x) => x.includes('加标签')), b2.buttons.join('|'));
await shot('caps-06-l2-album2.png');

const kernel2 = await apiProbe(`
  const p = await api.get('/albums/2/images', { query: { page: 1, pageSize: 2 } });
  const ids = p.list.map((i) => i.id);
  try { out.vis = await api.patch('/images/batch-visibility', { imageIds: ids, visibility: 'public' }); } catch (e) { out.vis = { threw: e.code }; }
  try { out.zip = await api.post('/images/batch-zip', { imageIds: ids }); } catch (e) { out.zip = { threw: e.code }; }
`);
const visRejected = (kernel2.vis?.rejected ?? [])[0];
console.log('[L2 批量改档位回执]', JSON.stringify(visRejected), ' zip=', JSON.stringify((kernel2.zip?.rejected ?? [])[0]));
check('L2 批量改档位逐条 403 ALBUM_CAP_CLOSED', visRejected?.code === 'ALBUM_CAP_CLOSED', JSON.stringify(visRejected));
check('闸门顺序：相册级开关排在归属判定之前', visRejected?.code === 'ALBUM_CAP_CLOSED' && visRejected?.code !== 'OWNER_ONLY');
check('册 2 的打包同样被逐条退回', (kernel2.zip?.rejected ?? [])[0]?.code === 'ALBUM_CAP_CLOSED');

// ============ 7) tempAccess：先拿柚子基线，再关掉，三处同步消失 ============
console.log('[切身份]', await identity('柚子'));
console.log('[nav]', await nav('/albums'));
const cardsBefore = await probe(ALBUM_CARDS);
const baseBefore = await apiProbe(`
  try { out.detail = { ok: (await api.get('/albums/1')).name }; } catch (e) { out.detail = { code: e.code, status: e.status }; }
  try { const t = await api.get('/take/pending'); out.take = JSON.stringify(t).includes('雷电将军'); } catch (e) { out.take = 'ERR ' + e.code; }
`);
console.log('[柚子基线]', JSON.stringify(cardsBefore.cards), JSON.stringify(baseBefore));
check('基线：临时账号看得到册 1', cardsBefore.cards.some((c) => c.includes('雷电将军')), cardsBefore.cards.join(' / '));
check('基线：直连册 1 详情通过', baseBefore.detail?.ok !== undefined, JSON.stringify(baseBefore.detail));
check('基线：取图清单里有册 1 分组', baseBefore.take === true);

console.log('[切身份]', await identity('L4 超管'));
console.log('[nav]', await nav('/admin/albums'));
await openCapsDialog('雷电将军');
await toggleSwitches([7]);
console.log('[关 tempAccess]', (await saveCaps()).join(' | '));
const admin3 = await probe(ADMIN);
check('册 1 标记变成 6 枚', (admin3.rows.find((r) => r.name.includes('雷电将军'))?.chips ?? []).length === 6);
await shot('caps-07-tempaccess-off.png');

console.log('[切身份]', await identity('柚子'));
console.log('[nav]', await nav('/albums'));
const cardsAfter = await probe(ALBUM_CARDS);
const baseAfter = await apiProbe(`
  try { out.detail = { ok: (await api.get('/albums/1')).name }; } catch (e) { out.detail = { code: e.code, status: e.status, message: e.message }; }
  try { const t = await api.get('/take/pending'); out.take = JSON.stringify(t).includes('雷电将军'); out.groups = (t.preGroups ?? []).map((g) => g.name); } catch (e) { out.take = 'ERR ' + e.code; }
  try { const a = await api.get('/albums', { query: { page: 1, pageSize: 50 } }); out.list = a.list.map((x) => x.name); } catch (e) { out.list = 'ERR ' + e.code; }
`);
console.log('[柚子关闭后]', JSON.stringify(cardsAfter.cards), JSON.stringify(baseAfter.groups), JSON.stringify(baseAfter.detail));
check('相册列表不再出现册 1', !cardsAfter.cards.some((c) => c.includes('雷电将军')));
check('只摘掉册 1：未关的白名单册仍在取图分组里', (baseAfter.groups ?? []).includes('IDO 春日祭 · 芙莉莲专题'), JSON.stringify(baseAfter.groups));
check('直连详情 404 且伪装成白名单未命中', baseAfter.detail?.status === 404 && baseAfter.detail?.code === 'NOT_IN_WHITELIST', JSON.stringify(baseAfter.detail));
check('回执文案与档位 404 同形（不泄露开关存在）', (baseAfter.detail?.message ?? '').includes('不在临时账号授权范围内'), baseAfter.detail?.message);
check('取图清单里册 1 的分组同步消失', baseAfter.take === false, JSON.stringify(baseAfter.groups));
check('接口层相册列表同样摘掉册 1', !JSON.stringify(baseAfter.list).includes('雷电将军'), JSON.stringify(baseAfter.list));
await shot('caps-08-temp-list.png');

// ============ 8) 复原：全部打开，前台按钮回来 ============
console.log('[切身份]', await identity('L4 超管'));
console.log('[nav]', await nav('/admin/albums'));
await openCapsDialog('雷电将军');
await toggleSwitches([0, 1, 3, 4, 5, 7]);
console.log('[复原保存]', (await saveCaps()).join(' | '));
await openCapsDialog('芙莉莲');
await toggleSwitches([2, 4]);
await saveCaps();
const restored = await probe(ADMIN);
check('册 1 标记清空', (restored.rows.find((r) => r.name.includes('雷电将军'))?.chips ?? []).length === 0);
check('册 2 标记清空', (restored.rows.find((r) => r.name.includes('芙莉莲'))?.chips ?? []).length === 0);
const cleaned = await apiProbe(`
  const kids = await api.get('/albums/1/children');
  const c = (kids ?? []).find((a) => a.name === ${JSON.stringify(CHILD_NAME)});
  out.removed = c ? (await api.delete('/albums/' + c.id)).removedImages : 'gone';
  out.left = (await api.get('/albums/1/children')).map((a) => a.name);
`);
console.log('[清理测试子册]', JSON.stringify(cleaned.removed), ' 剩余', JSON.stringify(cleaned.left));
check('测试子册已删除，册 1 子册列表清空', !child ? true : cleaned.removed === 0 && (cleaned.left ?? []).length === 0, String(cleaned.removed));

console.log('[nav]', await nav('/albums/1'));
const dEnd = await probe(DETAIL);
check('复原后「生成返图链接」回来', dEnd.actions.some((a) => a.includes('生成返图链接')), dEnd.actions.join('|'));
check('复原后「拍展传图」回来', dEnd.actions.some((a) => a.includes('拍展传图')));
check('复原后头部说明消失', dEnd.capsLine === null, dEnd.capsLine);
const endKernel = await apiProbe(`
  const p = await api.get('/albums/1/images', { query: { page: 1, pageSize: 2 } });
  out.originals = p.list.map((i) => (i.links.original ? 'url' : null));
`);
check('复原后原图链接恢复下发', endKernel.originals.every((v) => v === 'url'), JSON.stringify(endKernel.originals));
await shot('caps-09-restored.png');

const failed = results.filter((r) => !r.pass);
console.log('\n==== 合计 ' + results.length + ' 项，通过 ' + (results.length - failed.length) + '，失败 ' + failed.length + ' ====');
for (const f of failed) console.log('  FAILED:', f.name);

ws.close();
cleanup();
await sleep(400);
process.exit(failed.length ? 1 : 0);
