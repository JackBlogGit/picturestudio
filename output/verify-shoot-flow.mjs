/**
 * 拍展传图面板的三步排版验收（PRD D33）：
 * ① 交付对象 → ② 相册与阶段 → ③ 挑照片，第 1 步没选定之前第 3 步点不动。
 * 覆盖：三步卡渲染 → 锁定态（按钮与 input 都 disabled、拖放被拦）→ 选定后摘要回显 →
 * 解锁并可排队 → 换交付对象提示「只改没开传的」→ 整批上传成功并按新归属回执 →
 * D27 回归（临时账号连面板都不挂载）→ L1 名下无账号时空态仍锁死第 3 步。
 * 全程不换页（mock 数据活在页面内存），只在换身份时整页重载。
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const PROFILE = OUT + 'edge-profile-shootflow/';
const PORT = 9246;
const APP = process.env.BASE ?? 'http://127.0.0.1:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass });
  console.log((pass ? '  OK  ' : '  FAIL ') + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail)));
}

const browser = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--window-size=1440,1100',
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
await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

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

let scriptId = null;
async function goto(token, path) {
  if (scriptId) {
    await call('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId });
    scriptId = null;
  }
  const added = await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('piks.accessToken', ${JSON.stringify(token)});`,
  });
  scriptId = added.identifier;
  await call('Page.navigate', { url: APP + path });
  await sleep(2600);
}

const SNAP = `(JSON.stringify({
  steps: document.querySelectorAll('.pk-step').length,
  titles: [...document.querySelectorAll('.pk-step__title')].map((e) => e.innerText.trim()),
  locked: [...document.querySelectorAll('.pk-step')].map((e) => e.className.includes('pk-step--locked')),
  dropButtons: [...document.querySelectorAll('.pk-drop__actions button')].map((b) => b.innerText.trim() + '=' + (b.disabled ? 'off' : 'on')),
  fileInputs: [...document.querySelectorAll('.pk-file__input')].map((i) => (i.disabled ? 'off' : 'on')),
  badges: [...document.querySelectorAll('.pk-step__badge')].map((e) => e.innerText.trim()),
  brief: [...document.querySelectorAll('.pk-brief__row')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim()),
  queueRows: (document.querySelectorAll('.pk-queue')[0]?.querySelectorAll('.pk-task') ?? []).length,
  queueHead: (document.querySelector('.pk-queue__head > span')?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
  tabBadges: [...document.querySelectorAll('.pk-tab__badge')].map((e) => e.innerText.trim()),
  taskStates: [...(document.querySelectorAll('.pk-queue')[0]?.querySelectorAll('.pk-task__name span') ?? [])].map((e) => e.innerText.trim()),
  taskDetails: [...(document.querySelectorAll('.pk-queue')[0]?.querySelectorAll('.pk-task__detail') ?? [])].map((e) => e.innerText.trim()),
  lockedHint: [...document.querySelectorAll('.pk-drop__hint')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim()),
}))`;

const toastText = () =>
  evalJs(`[...document.querySelectorAll('.el-message')].map((t) => t.innerText.trim()).join(' | ') || '-'`);

async function shot(file) {
  const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(OUT + file, Buffer.from(data, 'base64'));
  console.log('  wrote', file);
}

/** 打开指定 el-select 并点第 idx 项，回它读到的文本 */
async function pickOption(selectClass, idx) {
  return probe(`(async () => {
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const box = document.querySelector(${JSON.stringify('.' + selectClass)});
    const input = box?.querySelector('input');
    input?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    input?.click();
    await nap(600);
    const pops = [...document.querySelectorAll('.el-select-dropdown')].filter((p) => p.getBoundingClientRect().height > 0);
    const items = pops.length ? [...pops[pops.length - 1].querySelectorAll('.el-select-dropdown__item')] : [];
    if (!items.length) return JSON.stringify({ ok: false, pops: pops.length, items: 0 });
    const label = items[${idx}]?.innerText.replace(/\\s+/g, ' ').trim() ?? '';
    items[${idx}]?.click();
    await nap(500);
    return JSON.stringify({ ok: true, label, items: items.length });
  })()`);
}

/** 拖放：直接给 .pk-drop 派一个带 DataTransfer 的 drop 事件（绕开按钮的 disabled） */
async function dropFiles(names) {
  return probe(`(async () => {
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const dt = new DataTransfer();
    for (const n of ${JSON.stringify(names)}) {
      dt.items.add(new File([new Uint8Array(400000)], n, { type: 'image/jpeg' }));
    }
    const zone = document.querySelector('.pk-drop');
    const ev = new Event('drop', { bubbles: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    zone.dispatchEvent(ev);
    await nap(500);
    return JSON.stringify({ rows: (document.querySelectorAll('.pk-queue')[0]?.querySelectorAll('.pk-task') ?? []).length });
  })()`);
}

/** 本地选择：给第一个 file input 塞文件并派 change（disabled 的 input 也能被程序写入 files） */
async function feedFiles(names) {
  return probe(`(async () => {
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const dt = new DataTransfer();
    for (const n of ${JSON.stringify(names)}) {
      dt.items.add(new File([new Uint8Array(400000)], n, { type: 'image/jpeg' }));
    }
    const input = document.querySelector('.pk-file__input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await nap(500);
    return JSON.stringify({ rows: (document.querySelectorAll('.pk-queue')[0]?.querySelectorAll('.pk-task') ?? []).length });
  })()`);
}

async function clickButton(scope, text) {
  return evalJs(`(() => {
    const b = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button')].find((x) => x.innerText.includes(${JSON.stringify(text)}));
    if (!b) return 'missing';
    b.click();
    return b.disabled ? 'disabled' : 'clicked';
  })()`);
}

console.log(`=== 拍展传图三步排版验收 @ ${APP} ===`);
console.log(`被测版本：ShootUploadView.vue mtime=${statSync('../client/src/views/ShootUploadView.vue').mtime.toISOString()}\n`);

// A) L4 进「拍展传图」标签：三步都在，第 3 步锁着
await goto('mock.user.1', '/albums?tab=upload');
const a = await probe(SNAP);
check('渲染出 3 张步骤卡', a.steps === 3, { steps: a.steps, titles: a.titles });
check('步骤标题依次为 交付对象 / 相册 / 挑照片', a.titles.join('|') === '交付给哪位临时账号|传到哪本相册|挑照片', a.titles);
check('未选交付对象时只有第 3 步锁着', a.locked.join(',') === 'false,false,true', a.locked);
check('第 3 步两枚按钮都 disabled', a.dropButtons.length === 2 && a.dropButtons.every((b) => b.endsWith('=off')), a.dropButtons);
check('两个 file input 都 disabled', a.fileInputs.join(',') === 'off,off', a.fileInputs);
check('成员仍挂载两个 file input（D27 回归）', a.fileInputs.length === 2, a.fileInputs.length);
check('未选时不渲染摘要卡', a.brief.length === 0, a.brief);
check('徽标写明「先定这一步 / 等第 1 步」', a.badges[0] === '先定这一步' && a.badges[1] === '等第 1 步', a.badges);
check('锁定态给出「点不动」的说明', a.lockedHint.some((h) => h.includes('第 1 步还没定交付对象')), a.lockedHint.length);
await shot('shoot-1-locked.png');

// B) 锁定态下直接拖文件：不进货，且单独报一句
const dropA = await dropFiles(['drag-locked.jpg']);
const toastA = await toastText();
check('锁定态拖放被拦下（队列 0 行）', dropA.rows === 0, dropA);
check('拖放被拦时给了「请先在第 1 步」提示', toastA.includes('请先在第 1 步'), toastA);

// C) 选第 1 位临时账号 → 摘要回显 + 第 3 步解锁
const pickA = await pickOption('pk-upload__temp', 0);
check('临时账号下拉可点并选中一项', pickA.ok && pickA.label.includes('PK-'), pickA);
const codeA = (pickA.label.match(/PK-[\w-]+/) ?? [''])[0];
const nameA = pickA.label.replace(codeA, '').replace(/·/g, ' ').trim();
const c = await probe(SNAP);
check('摘要卡按 6 行列出所选项', c.brief.length === 6, c.brief);
check('摘要写出名称与帐户ID', c.brief[0].includes(nameA) && c.brief[1].includes(codeA), c.brief.slice(0, 2));
check('摘要含登记人／拍摄内容／有效期／目录现状', c.brief.join(' ').includes('登记人') && c.brief.join(' ').includes('拍摄内容') && c.brief.join(' ').includes('有效期') && c.brief.join(' ').includes('目录现状'), c.brief.slice(2));
check('有效期给出剩余天数', /剩 \d+ 天|已过期/.test(c.brief.join(' ')), c.brief[4]);
check('选定后第 3 步解锁', c.locked[2] === false, c.locked);
check('选定后按钮与 input 都可用', c.dropButtons.every((b) => b.endsWith('=on')) && c.fileInputs.join(',') === 'on,on', { b: c.dropButtons, i: c.fileInputs });
check('第 1、3 步徽标改口为「已选定 / 可传 · 交付给 <code>」', c.badges[0] === '已选定' && c.badges[1] === `可传 · 交付给 ${codeA}`, c.badges);
await shot('shoot-2-picked.png');

// D) 排队两张，队列头显出交付对象与目的地
const rowsBefore = (await probe(SNAP)).queueRows;
await feedFiles(['batch-a.jpg', 'batch-b.jpg']);
const d = await probe(SNAP);
check('本地选择后按增量排队（+2 行）', d.queueRows === rowsBefore + 2, { rowsBefore, after: d.queueRows });
check('队列头回显交付对象与相册', d.queueHead.includes(codeA) && d.queueHead.includes('进「'), d.queueHead);

// E) 换交付对象：只改没开传的那些张
const pickB = await pickOption('pk-upload__temp', 1);
const codeB = (pickB.label.match(/PK-[\w-]+/) ?? [''])[0];
const toastE = await toastText();
check('换人后队列不丢（行数不变）', (await probe(SNAP)).queueRows === d.queueRows, { want: d.queueRows });
check('换人时明说改了哪几张、已进相册的不搬', toastE.includes('还没开传') && toastE.includes(codeB) && toastE.includes('已进相册'), { toastE, codeB });
check('摘要与徽标跟着换成新的帐户ID', codeA !== codeB && ((await probe(SNAP)).badges[1] ?? '').includes(codeB));

// F) 整批开传：成功回执按新归属报
await clickButton('.pk-queue__head', '开始上传');
await sleep(3500);
const f = await probe(SNAP);
const toastF = await toastText();
check('队列里的照片都跑到「已完成」', f.taskStates.length > 0 && f.taskStates.every((s) => s.includes('已完成')), {
  states: f.taskStates,
  details: f.taskDetails,
});
check('「已完成」标签徽标与队列行数对上', f.tabBadges.includes(String(d.queueRows)), { want: d.queueRows, badges: f.tabBadges });
check('成功回执写明交付给第二位', toastF.includes('已进入相册') && toastF.includes(codeB), toastF);
check('回执按前/后期分组报数', /前期 \d+ 张 \/ 后期 \d+ 张/.test(toastF), toastF);
await shot('shoot-3-done.png');

// G) D27 回归：临时账号连面板都不该挂载
await goto('mock.temp.301', '/albums');
const g = await probe(SNAP);
check('临时账号看不到「拍展传图」标签', !(await evalJs(`[...document.querySelectorAll('.pk-tabs .pk-tab')].map((t)=>t.innerText.trim()).join('|')`)).includes('拍展传图'));
check('临时账号名下不挂传图面板', g.steps === 0 && g.fileInputs.length === 0, { steps: g.steps, inputs: g.fileInputs.length });

// H) 名下没有临时账号的成员（L1）：空态 + 第 3 步照样锁死
await goto('mock.user.4', '/albums?tab=upload');
const h = await probe(SNAP);
check('L1 也看到三步骨架', h.steps === 3 && h.titles[0] === '交付给哪位临时账号', h.titles);
check('L1 名下无账号 → 给出注册引导', (await evalJs(`document.querySelector('.pk-step__body')?.innerText ?? ''`)).includes('注册临时账号'));
check('L1 的第 3 步仍锁死', h.locked[2] === true && h.dropButtons.every((b) => b.endsWith('=off')), h.dropButtons);
await shot('shoot-4-l1-empty.png');

const failed = results.filter((r) => !r.pass);
console.log(`\nRESULT=${failed.length ? 'FAIL' : 'CLEAN'} — ${results.length - failed.length}/${results.length} 通过`);
for (const x of failed) console.log('  未过：' + x.name);
cleanup();
process.exit(failed.length ? 1 : 0);
