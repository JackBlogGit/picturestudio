/**
 * D34 验收：超级管理员后台的改动要先验口令，弹窗里「重置」与「保存」成对出现（PRD 6.1 / 6.5 / 10.5）。
 * 三段——
 *  A. 内核（在页面里直接调 api）：/admin/* 的写不带口令 = 401 REAUTH_REQUIRED、带错口令 = 401 REAUTH_FAILED、
 *     带对口令才落库；等级判定仍然排在口令之前；前台共用的 /albums 路由不带口令照旧能写；
 *     口令不落任何浏览器存储、不进审计日志。
 *  B. 站点设置页：取消不发请求、错口令改动不落库、空口令被输入框挡在弹窗里、填对才保存；
 *     页尾新增的「重置 / 保存」条与页头同一组动作；一次提交结束后口令不留存（下一次保存照样弹窗）。
 *  C. 相册「功能开关」弹窗与成员「网盘授权」弹窗：footer 三枚按钮 取消／重置／保存，
 *     「重置」只回到打开时的值，保存仍然先要口令。
 * 用法：node output/verify-admin-reauth.mjs   （BASE= 可覆盖，默认 5173；跑之前先起 vite）
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DEMO_PASSWORD, makeReauth } from './lib-reauth.mjs';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const PROFILE = OUT + 'edge-profile-reauth/';
const PORT = Number(process.env.CDP_PORT ?? 9251);
const APP = process.env.BASE ?? 'http://127.0.0.1:5173';
const WRONG = 'wu-quan-kou-ling';
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

async function probe(expression) {
  const raw = await evalJs(expression);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

const reauth = makeReauth({ evalJs, sleep });

async function goto(token, path) {
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('piks.accessToken', ${JSON.stringify(token)});`,
  });
  await call('Page.navigate', { url: APP + path });
  await sleep(2400);
}

async function nav(path) {
  await evalJs(`(async () => {
    const router = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$router;
    if (router) await router.push(${JSON.stringify(path)});
  })()`);
  await sleep(1200);
}

async function click(selector, text, { index } = {}) {
  return evalJs(`(() => {
    const list = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const btn = ${index !== undefined ? `list[${index}]` : `list.find((b) => b.innerText.includes(${JSON.stringify(text)}))`};
    if (!btn) return 'missing:' + ${JSON.stringify(selector)} + ':' + ${JSON.stringify(text ?? String(index))};
    btn.click();
    return 'clicked';
  })()`);
}

async function shot(file) {
  const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(OUT + file, Buffer.from(data, 'base64'));
  console.log('  wrote', file);
}

/** toast 由 MutationObserver 攒进 window.__toasts，页面上飘过去也读得到 */
async function installToastSpy() {
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
}

let toastMark = 0;
async function toastsSince(mark = toastMark) {
  const all = await evalJs('JSON.stringify(window.__toasts ?? [])');
  const list = JSON.parse(all);
  toastMark = list.length;
  return list.slice(mark);
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

/* ------------------------------------------------------------------ 站点设置页读数 */

const SETTING = (key) => `(() => {
  const row = [...document.querySelectorAll('.pk-setting')].find(
    (r) => (r.querySelector('.pk-admin__mono')?.innerText ?? '').trim() === ${JSON.stringify(key)},
  );
  if (!row) return JSON.stringify({ missing: true });
  const ctl = row.querySelector('input.el-input__inner') ?? row.querySelector('textarea');
  return JSON.stringify({
    value: ctl?.value ?? null,
    dirty: [...row.querySelectorAll('.pk-chip')].some((c) => c.innerText.includes('已改动')),
    dirtyLine: document.querySelector('.pk-admin__dirty')?.innerText.replace(/\\s+/g, ' ').trim() ?? '',
    footBtns: [...document.querySelectorAll('.pk-setting__foot button')].map((b) => b.innerText.trim().replace(/\\s+/g, ' ')),
    footResetDisabled: !!document.querySelector('.pk-setting__foot button')?.disabled,
  });
})()`;

function setSetting(key, value) {
  return evalJs(`(() => {
    const row = [...document.querySelectorAll('.pk-setting')].find(
      (r) => (r.querySelector('.pk-admin__mono')?.innerText ?? '').trim() === ${JSON.stringify(key)},
    );
    const ctl = row?.querySelector('input.el-input__inner') ?? row?.querySelector('textarea');
    if (!ctl) return 'missing';
    ctl.value = ${JSON.stringify(value)};
    ctl.dispatchEvent(new Event('input', { bubbles: true }));
    return ctl.value;
  })()`);
}

/* --------------------------------------------------------------- 相册 / 成员弹窗读数 */

const CAPS_DIALOG = `(() => {
  const box = [...document.querySelectorAll('.el-dialog')].find((d) =>
    (d.querySelector('.el-dialog__title')?.innerText ?? '').includes('册内功能开关'));
  return JSON.stringify({
    open: !!box,
    items: [...(box?.querySelectorAll('.pk-album__cap .el-switch input') ?? [])].map((i) => i.checked),
    footBtns: [...(box?.querySelectorAll('.el-dialog__footer button') ?? [])].map((b) => b.innerText.trim()),
  });
})()`;

const GRANT_DIALOG = `(() => {
  const box = [...document.querySelectorAll('.el-dialog')].find((d) =>
    (d.querySelector('.el-dialog__title')?.innerText ?? '').includes('网盘授权'));
  return JSON.stringify({
    open: !!box,
    gates: [...(box?.querySelectorAll('.pk-admin__grant .el-switch input') ?? [])].map((i) => i.checked),
    footBtns: [...(box?.querySelectorAll('.el-dialog__footer button') ?? [])].map((b) => b.innerText.trim()),
  });
})()`;

async function openRowDialog(rowText, btnText) {
  return evalJs(`(() => {
    const row = [...document.querySelectorAll('.el-table__row')].find((r) => r.innerText.includes(${JSON.stringify(rowText)}));
    const btn = [...(row?.querySelectorAll('button') ?? [])].find((b) => b.innerText.includes(${JSON.stringify(btnText)}));
    if (!btn) return 'missing';
    btn.click();
    return 'clicked';
  })()`);
}

/* ============================================================ A. 内核层：闸门在哪一层 */

console.log(`=== A. 内核层（页面里直接调 api）@ ${APP} ===\n`);
await goto('mock.user.1', '/admin/settings');
await installToastSpy();
await evalJs(`(async () => { const m = await import('/src/api/client.ts'); window.__api = m.api; })()`);

const kernel = await apiProbe(`
  const KEY = 'watermark.text';
  const rows = await api.get('/admin/settings');
  out.before = (rows.find((r) => r.key === KEY) ?? {}).value;
  const next = out.before + '|D34';
  try { await api.put('/admin/settings', { settings: { [KEY]: next } }); out.nocred = 'passed'; }
  catch (e) { out.nocred = e.status + ' ' + e.code + ' ' + e.message; }
  out.afterNoCred = (await api.get('/admin/settings')).find((r) => r.key === KEY).value;
  try { await api.put('/admin/settings', { settings: { [KEY]: next } }, { reauth: ${JSON.stringify(WRONG)} }); out.badcred = 'passed'; }
  catch (e) { out.badcred = e.status + ' ' + e.code + ' ' + e.message; }
  out.afterBadCred = (await api.get('/admin/settings')).find((r) => r.key === KEY).value;
  try { out.goodcred = (await api.put('/admin/settings', { settings: { [KEY]: next } }, { reauth: ${JSON.stringify(DEMO_PASSWORD)} })).find((r) => r.key === KEY).value; }
  catch (e) { out.goodcred = 'ERR ' + e.status + ' ' + e.code; }
  // 等级排在口令之前：L3 带着对的口令改站点设置，先吃 403，不该知道自己差一个口令
  const t3 = 'mock.user.2';
  const keep = localStorage.getItem('piks.accessToken');
  localStorage.setItem('piks.accessToken', t3);
  try { out.l3order = 'passed'; await api.put('/admin/settings', { settings: { [KEY]: 'x' } }, { reauth: ${JSON.stringify(DEMO_PASSWORD)} }); }
  catch (e) { out.l3order = e.status + ' ' + e.code; }
  // 前台共用的相册路由：不带口令也照写（后台的硬门槛只在 /admin/* 上）
  localStorage.setItem('piks.accessToken', keep);
  try { out.shared = 'passed'; await api.patch('/albums/1', { description: 'D34 前台不设门槛' }); }
  catch (e) { out.shared = e.status + ' ' + e.code; }
  // 口令既不进请求体，也不进审计明文
  const logs = await api.get('/admin/logs', { query: { page: 1, pageSize: 30 } });
  out.logLeak = logs.list.some((l) => JSON.stringify(l).includes(${JSON.stringify(DEMO_PASSWORD)}));
  out.storeLeak = [Object.entries(localStorage), Object.entries(sessionStorage)]
    .flat()
    .filter(([k, v]) => String(v).includes(${JSON.stringify(DEMO_PASSWORD)}) || k.toLowerCase().includes('password'))
    .map(([k]) => k);
`);
console.log('[内核]', JSON.stringify(kernel));
check('不带口令的后台写被 401 REAUTH_REQUIRED 挡下', String(kernel.nocred).startsWith('401 REAUTH_REQUIRED'), kernel.nocred);
check('缺口令时改动没有落库', kernel.afterNoCred === kernel.before, `${kernel.before} → ${kernel.afterNoCred}`);
check('口令不对的后台写退回 401 REAUTH_FAILED', String(kernel.badcred).startsWith('401 REAUTH_FAILED'), kernel.badcred);
check('口令不对时改动同样没有落库', kernel.afterBadCred === kernel.before, kernel.afterBadCred);
check('口令对了才落库（值真的写进去了）', kernel.goodcred === `${kernel.before}|D34`, kernel.goodcred);
check('错误回执里不复述口令本身', !String(kernel.badcred).includes(DEMO_PASSWORD) && !String(kernel.nocred).includes(WRONG), kernel.badcred);
check('L3 带着对的口令改站点设置先吃 403（等级在口令之前）', String(kernel.l3order).startsWith('403'), kernel.l3order);
check('前台共用的 PATCH /albums 不带口令照写（硬门槛只在 /admin/*）', String(kernel.shared).startsWith('2') || kernel.shared === 'passed', kernel.shared);
check('审计日志里没有明文口令', kernel.logLeak === false, kernel.logLeak);
check('localStorage / sessionStorage 里搜不到口令', (kernel.storeLeak ?? []).length === 0, (kernel.storeLeak ?? []).join(','));
await shot('reauth-01-kernel.png');

/* ================================================= B. 站点设置页：取消／错／空／对 + 重置 */

console.log(`\n=== B. 站点设置页 /admin/settings ===\n`);
const TITLE = 'site.title';
const baseTitle = (await probe(SETTING(TITLE))).value;

console.log('  改动:', await setSetting(TITLE, `${baseTitle}·D34`));
await sleep(400);
const d1 = await probe(SETTING(TITLE));
check('页头与页尾各有一组「重置 / 保存」', d1.footBtns[0] === '重置' && d1.footBtns[1].includes('保存'), d1.footBtns.join('/'));
check('脏值计数进入保存按钮文案', /\(1\)/.test(d1.footBtns[1]), d1.footBtns[1]);
check('脏值提示写明「点保存要先填登录口令」', d1.dirtyLine.includes('登录口令') && d1.dirtyLine.includes('D34'), d1.dirtyLine);

// 1) 取消：请求根本不发
await click('.pk-admin__inline button', '保存');
const box1 = await reauth.waitFor();
check('保存前先弹身份再验证（标题 + 口令框 + 两个按钮）',
  box1.open && box1.title === '身份再验证' && box1.type === 'password' && box1.buttons.includes('确认提交') && box1.buttons.includes('取消'),
  JSON.stringify({ title: box1.title, type: box1.type, buttons: box1.buttons }));
check('提示语里点名演示层的缺省口令，超管不至于卡住', box1.message.includes(DEMO_PASSWORD), box1.message.slice(0, 80));
await reauth.cancel();
const c1 = await probe(SETTING(TITLE));
check('点「取消」后脏值仍在（说明这次没提交）', c1.dirty === true && c1.value === `${baseTitle}·D34`, JSON.stringify(c1));
check('取消这一支没有发出请求（无成功回执）', (await toastsSince()).length === 0, 'toasts');

// 2) 错口令：401 挡回，改动留在草稿里
await click('.pk-admin__inline button', '保存');
await reauth.fill(WRONG);
await reauth.press('confirm');
await sleep(900);
const wrongToasts = await toastsSince();
const c2 = await probe(SETTING(TITLE));
check('错口令被后端挡回「登录口令不正确，改动没有提交」', wrongToasts.some((t) => t.includes('口令不正确')), wrongToasts.join(' | '));
check('错口令时改动不落库、弹窗关掉但脏值还在', c2.dirty === true && c2.value === `${baseTitle}·D34`, JSON.stringify(c2));
await shot('reauth-02-wrong-password.png');

// 3) 空口令：输入框自己挡住，请求不发
await click('.pk-admin__inline button', '保存');
await reauth.fill('');
await reauth.press('confirm');
await sleep(500);
const box3 = await reauth.state();
check('空口令被 inputValidator 挡住，弹窗不关', box3.open === true && box3.error.includes('不能为空'), JSON.stringify({ open: box3.open, err: box3.error }));
check('空口令这一支同样没有回执', (await toastsSince()).length === 0, 'toasts');

// 4) 填对：落库 + 脏值清零
await reauth.fill(DEMO_PASSWORD);
await reauth.press('confirm');
await sleep(1100);
const okToasts = await toastsSince();
const c4 = await probe(SETTING(TITLE));
check('口令正确后保存成功（出现「后端每次读取」回执）', okToasts.some((t) => t.includes('项，后端')), okToasts.join(' | '));
check('保存后脏值清零、页尾按钮重新置灰', c4.dirty === false && c4.footResetDisabled === true, JSON.stringify({ dirty: c4.dirty, resetDisabled: c4.footResetDisabled }));
check('落库的就是页面上那一个新值', c4.value === `${baseTitle}·D34`, c4.value);

// 5) 口令不留存：下一次改动照样弹窗
await setSetting(TITLE, `${baseTitle}·D34-2`);
await sleep(400);
await click('.pk-setting__foot button.el-button--primary', '', { index: 0 });
const box5 = await reauth.waitFor();
check('一次提交结束就清掉口令：第二次保存重新要口令', box5.open === true && box5.value === '', JSON.stringify({ open: box5.open, value: box5.value }));

// 6) 页尾「重置」只回到打开页面时的值
await reauth.press('cancel');
await sleep(400);
await click('.pk-setting__foot button', '重置');
await sleep(600);
const c6 = await probe(SETTING(TITLE));
check('页尾「重置」把草稿清干净（回到上一次保存的值）',
  c6.dirty === false && c6.value === `${baseTitle}·D34`, JSON.stringify({ value: c6.value, dirty: c6.dirty }));
check('重置后页尾两枚按钮一起置灰', c6.footResetDisabled === true, c6.footBtns.join('/'));
await shot('reauth-03-settings-reset.png');

/* ============================================== C. 相册「功能开关」弹窗：重置 + 保存要口令 */

console.log(`\n=== C. 相册功能开关弹窗 /admin/albums ===\n`);
await nav('/admin/albums');
console.log('  打开弹窗:', await openRowDialog('雷电将军', '功能开关'));
await sleep(900);
const cap1 = await probe(CAPS_DIALOG);
const allOn = cap1.items.filter((v) => v).length;
check('开关弹窗 footer 三枚按钮：取消 / 重置 / 保存开关',
  cap1.footBtns.join('|') === '取消|重置|保存开关', cap1.footBtns.join('|'));

// 关掉一项再点「重置」——只回到打开那一刻的状态
await click('.pk-album__cap .el-switch', '', { index: 4 });
await sleep(500);
const capOff = await probe(CAPS_DIALOG);
check('关掉「批量打包」后弹窗里少一枚允许', capOff.items[4] === false && capOff.items.filter((v) => v).length === allOn - 1, capOff.items.join(','));
await click('.el-dialog__footer button', '重置');
await sleep(500);
const capBack = await probe(CAPS_DIALOG);
check('弹窗内「重置」把开关拨回打开时的样子', capBack.items.join(',') === cap1.items.join(','), capBack.items.join(','));
await shot('reauth-04-caps-reset.png');

// 保存：先要口令；这一次先取消，确认什么都没落库
const rowChipsBefore = (await probe(`(() => {
  const row = [...document.querySelectorAll('.el-table__row')].find((r) => r.innerText.includes('雷电将军'));
  return JSON.stringify({ chips: [...row.querySelectorAll('.pk-album__caps .pk-chip')].map((c) => c.innerText.trim()) });
})()`)).chips;
await click('.pk-album__cap .el-switch', '', { index: 4 });
await sleep(400);
await click('.el-dialog__footer button', '保存开关');
const capGate = await reauth.waitFor();
check('保存开关也先要口令', capGate.open === true && capGate.type === 'password', JSON.stringify({ open: capGate.open, type: capGate.type }));
await reauth.cancel();
await sleep(400);
const chipsAfterCancel = (await probe(`(() => {
  const row = [...document.querySelectorAll('.el-table__row')].find((r) => r.innerText.includes('雷电将军'));
  return JSON.stringify({ chips: [...row.querySelectorAll('.pk-album__caps .pk-chip')].map((c) => c.innerText.trim()) });
})()`)).chips;
check('取消这一支没落库（行上的关闭标记数量不变）', chipsAfterCancel.length === rowChipsBefore.length, `${rowChipsBefore.length} → ${chipsAfterCancel.length}`);

// 再存一次：填对口令才落库
await click('.el-dialog__footer button', '保存开关');
const label = await reauth.pass();
await sleep(900);
const capSaved = await probe(`(() => {
  const box = [...document.querySelectorAll('.el-dialog')].find((d) =>
    (d.querySelector('.el-dialog__title')?.innerText ?? '').includes('册内功能开关'));
  const row = [...document.querySelectorAll('.el-table__row')].find((r) => r.innerText.includes('雷电将军'));
  return JSON.stringify({
    dialogOpen: !!box && box.offsetParent !== null,
    chips: [...row.querySelectorAll('.pk-album__caps .pk-chip')].map((c) => c.innerText.trim()),
    toasts: (window.__toasts ?? []).slice(-2).join(' | '),
  });
})()`);
check('口令对了才写入册内开关（按「确认提交」放行）', label === '确认提交' && capSaved.chips.length === rowChipsBefore.length + 1,
  `${rowChipsBefore.length} → ${capSaved.chips.length} · ${capSaved.chips.join('/')}`);
check('保存回执出现', capSaved.toasts.includes('册内功能开关'), capSaved.toasts);
check('保存后弹窗自己关闭', capSaved.dialogOpen === false, capSaved.dialogOpen);
await shot('reauth-05-caps-saved.png');

// 复原，别把下一轮 D25 的验收改掉
console.log('  复原:', await openRowDialog('雷电将军', '功能开关'));
await sleep(900);
await click('.pk-album__cap .el-switch', '', { index: 4 });
await sleep(400);
await click('.el-dialog__footer button', '保存开关');
await reauth.pass();
await sleep(900);
const restored = (await probe(`(() => {
  const row = [...document.querySelectorAll('.el-table__row')].find((r) => r.innerText.includes('雷电将军'));
  return JSON.stringify({ chips: [...row.querySelectorAll('.pk-album__caps .pk-chip')].map((c) => c.innerText.trim()) });
})()`)).chips;
check('复跑无回归：关闭标记回到初始数量', restored.length === rowChipsBefore.length, `${rowChipsBefore.length} → ${restored.length}`);
await click('.el-dialog__footer button', '取消');

/* ===================================================== D. 成员「网盘授权」弹窗：按钮成对 */

console.log(`\n=== D. 成员网盘授权弹窗 /admin/members ===\n`);
await nav('/admin/members');
console.log('  打开弹窗:', await openRowDialog('小满', '网盘授权'));
await sleep(900);
const grant1 = await probe(GRANT_DIALOG);
check('网盘授权弹窗 footer 三枚按钮：取消 / 重置 / 保存授权',
  grant1.footBtns.join('|') === '取消|重置|保存授权', grant1.footBtns.join('|'));
check('四档门槛按打开时的值渲染', grant1.gates.length === 4, grant1.gates.join(','));
await click('.pk-admin__grant .el-switch', '', { index: 0 });
await sleep(500);
await click('.el-dialog__footer button', '重置');
await sleep(500);
const grantBack = await probe(GRANT_DIALOG);
check('「重置」把四档拨回打开时的样子', grantBack.gates.join(',') === grant1.gates.join(','), grantBack.gates.join(','));

// 保存这一支：口令不对就什么都不改
await click('.pk-admin__grant .el-switch', '', { index: 0 });
await sleep(400);
await click('.el-dialog__footer button', '保存授权');
const grantGate = await reauth.waitFor();
check('保存授权也先要口令', grantGate.open === true && grantGate.title === '身份再验证', JSON.stringify({ open: grantGate.open, title: grantGate.title }));
await reauth.fill(WRONG);
await reauth.press('confirm');
await sleep(900);
const grantToast = await toastsSince();
check('错口令下授权没落库（回执是口令不正确，不是「已更新」）',
  grantToast.some((t) => t.includes('口令不正确')) && !grantToast.some((t) => t.includes('文件权限授权')), grantToast.join(' | '));
await click('.el-dialog__footer button', '取消');
await shot('reauth-06-grant-gate.png');

const failed = results.filter((r) => !r.pass);
console.log(`\n==== 合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length} ====`);
for (const f of failed) console.log('  未过：' + f.name);
console.log(failed.length ? 'RESULT=FAIL' : 'RESULT=CLEAN');
cleanup();
process.exit(failed.length ? 1 : 0);
