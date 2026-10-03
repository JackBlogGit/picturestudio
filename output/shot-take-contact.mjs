/**
 * 取图 / 联系我们 的逐身份验收：游客展示首页两格、/take 两种口径、/contact 公开页、
 * 后台联系方式编辑器。跑之前先起 vite（默认 127.0.0.1:5173）。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeReauth } from './lib-reauth.mjs';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const PROFILE = OUT + 'edge-profile-take/';
const PORT = 9237;
const APP = 'http://127.0.0.1:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const { targetId } = await send('Target.createTarget', { url: APP + '/' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const call = (method, params = {}) => send(method, params, sessionId);

await call('Page.enable');
await call('Runtime.enable');
await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

async function evalJs(expression, awaitPromise = false) {
  const res = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (res.exceptionDetails) {
    throw new Error(JSON.stringify(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text));
  }
  return res.result.value;
}

/** D34：站点设置的保存前会先弹一次身份再验证 */
const reauth = makeReauth({ evalJs, sleep });

async function goto(url) {
  const done = new Promise((r) => setTimeout(r, 1700));
  await call('Page.navigate', { url });
  await done;
}

async function shot(file) {
  const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(OUT + file, Buffer.from(data, 'base64'));
  console.log('  wrote', file);
}

const asToken = (token) => evalJs(`localStorage.setItem('piks.accessToken', ${JSON.stringify(token)});`);

const toast = () => evalJs(`document.querySelector('.el-message')?.innerText ?? '-'`);

const log = (label, obj) => console.log(`\n[${label}]`, typeof obj === 'string' ? obj : JSON.stringify(obj));

// 1) 游客展示首页的快捷入口两格
await asToken('');
await goto(`${APP}/`);
await sleep(400);
log(
  'guest /',
  await evalJs(`(() => {
  const cells = [...document.querySelectorAll('.pk-guest .pk-work__cell')];
  const grid = document.querySelector('.pk-guest .pk-work__grid');
  return {
    path: location.pathname,
    count: cells.length,
    labels: cells.map((c) => c.innerText.trim()),
    cols: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : null,
    gridWidth: grid ? Math.round(grid.getBoundingClientRect().width) : null,
  };
})()`),
);
await shot('guest-home-cells.png');

// 2) 游客点「取图」→ /take 的口令入口
await evalJs(`[...document.querySelectorAll('.pk-guest .pk-work__cell')].find((c) => c.innerText.includes('取图')).click()`);
await sleep(1200);
log(
  'guest /take',
  await evalJs(`({
  path: location.pathname,
  hasInput: !!document.querySelector('.pk-take__token input'),
  title: document.querySelector('.pk-page-title')?.innerText,
  lead: document.querySelector('.pk-admin__head .pk-muted')?.innerText,
})`),
);
await shot('take-guest-token.png');

// 3) 贴一条完整链接：应跳到 /s/:token
await evalJs(`(() => {
  const inp = document.querySelector('.pk-take__token input');
  inp.value = 'http://localhost:5173/s/pk-youzi-cp29-a7f3?x=1';
  inp.dispatchEvent(new Event('input'));
})()`);
await evalJs(`[...document.querySelectorAll('.pk-take__token button')].find((b) => b.innerText.includes('打开')).click()`);
await sleep(1800);
log('guest token→share', await evalJs('location.pathname'));
await shot('take-guest-opened.png');

// 4) 无效口令：原地报错，不跳走
await goto(`${APP}/take`);
await evalJs(`(() => {
  const inp = document.querySelector('.pk-take__token input');
  inp.value = 'pk-revoked-0002';
  inp.dispatchEvent(new Event('input'));
})()`);
await evalJs(`[...document.querySelectorAll('.pk-take__token button')].find((b) => b.innerText.includes('打开')).click()`);
await sleep(1200);
log('guest bad token', { path: await evalJs('location.pathname'), toast: await toast() });

// 5) 带密码的口令：应当放行到 /s/:token，由那一页自己弹密码框
await goto(`${APP}/take`);
await evalJs(`(() => {
  const inp = document.querySelector('.pk-take__token input');
  inp.value = 'pk-qingye-ido-91c2';
  inp.dispatchEvent(new Event('input'));
})()`);
await evalJs(`[...document.querySelectorAll('.pk-take__token button')].find((b) => b.innerText.includes('打开')).click()`);
await sleep(1500);
log('guest password token', await evalJs('location.pathname'));

// 6) 联系我们：游客可看，渠道逐条渲染
await asToken('');
await goto(`${APP}/contact`);
log(
  'guest /contact',
  await evalJs(`({
  path: location.pathname,
  rows: [...document.querySelectorAll('.pk-contact__list li')].map((li) => li.innerText.replace(/\\s+/g, ' ').trim()),
})`),
);
await shot('contact-guest.png');

// 7) 临时账号 301：后期未完成 → 空清单 + 说明
await asToken('mock.temp.301');
await goto(`${APP}/home`);
log(
  'temp301 /home',
  await evalJs(`(() => {
  const cells = [...document.querySelectorAll('.pk-work__cell')];
  return { count: cells.length, labels: cells.map((c) => c.innerText.trim()) };
})()`),
);
await goto(`${APP}/take`);
log(
  'temp301 /take',
  await evalJs(`({
  alert: document.querySelector('.el-alert__title')?.innerText ?? null,
  groups: document.querySelectorAll('.pk-take__group').length,
  toolbar: !!document.querySelector('.pk-admin__toolbar'),
  folder: document.querySelector('.pk-take__folder')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
})`),
);
await shot('take-temp301-pending.png');

// 8) 临时账号 302：后期完成 + 开了下载 → 清单有货，能勾选与批量存图
await asToken('mock.temp.302');
await goto(`${APP}/take`);
log(
  'temp302 /take',
  await evalJs(`({
  groups: [...document.querySelectorAll('.pk-take__group')].map((g) => g.querySelector('.pk-section__title')?.innerText),
  tiles: document.querySelectorAll('.pk-tile').length,
  picks: document.querySelectorAll('.pk-tile__pick').length,
  toolbar: document.querySelector('.pk-admin__toolbar')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
})`),
);
await shot('take-temp302-list.png');

await evalJs(`[...document.querySelectorAll('.pk-admin__toolbar button')].find((b) => b.innerText.includes('全部选中')).click()`);
await sleep(400);
log('temp302 select all', await evalJs(`document.querySelector('.pk-admin__toolbar')?.innerText.replace(/\\s+/g,' ').trim()`));
await evalJs(`[...document.querySelectorAll('.pk-admin__toolbar button')].find((b) => b.innerText.includes('批量存图')).click()`);
await sleep(1500);
log('temp302 zip toast', await toast());
await shot('take-temp302-zip.png');

// 9) 302 开了下载：点格子 = 勾选，不弹预览
await asToken('mock.temp.302');
await goto(`${APP}/take`);
await evalJs(`document.querySelector('.pk-tile')?.click()`);
await sleep(700);
log(
  'temp302 click tile (can download)',
  await evalJs(`({ dialog: !!document.querySelector('.pk-take__preview'), picked: document.querySelectorAll('.pk-tile__pick.is-on').length })`),
);

// 9b) 只读口径：mock 数据在内存里，整页导航会冲掉勾选，所以全程同页操作
await asToken('mock.user.3');
await goto(`${APP}/tasks/manage`);
const flipped = await evalJs(`(() => {
  const row = [...document.querySelectorAll('article.pk-task')].find((r) => r.querySelector('.pk-task__id strong')?.innerText === 'PK-2026-0913');
  if (!row) return 'ROW_NOT_FOUND';
  row.querySelectorAll('.pk-task__switch')[1].querySelector('.el-switch').click();
  return 'clicked';
})()`);
await sleep(1400);
log('L2 flip stage2', { flipped, toast: await toast() });

// 同页切身份：顶部「演示身份」下拉点柚子，不重新加载页面
await evalJs(`[...document.querySelectorAll('.pk-header__user button')].find((b) => b.innerText.includes('演示身份')).click()`);
await sleep(700);
await evalJs(`[...document.querySelectorAll('.el-dropdown-menu__item')].find((i) => i.innerText.includes('柚子')).click()`);
await sleep(1400);
await evalJs(`history.pushState({}, '', '/take'); dispatchEvent(new PopStateEvent('popstate', { state: history.state }));`);
await sleep(1600);
log(
  'temp301 /take after stage done (same session)',
  await evalJs(`({
  path: location.pathname,
  identity: document.querySelector('.pk-identity')?.innerText ?? null,
  alert: document.querySelector('.el-alert__title')?.innerText ?? null,
  groups: document.querySelectorAll('.pk-take__group').length,
  tiles: document.querySelectorAll('.pk-tile').length,
  picks: document.querySelectorAll('.pk-tile__pick').length,
  toolbar: !!document.querySelector('.pk-admin__toolbar'),
})`),
);
await shot('take-temp301-readonly.png');
await evalJs(`document.querySelector('.pk-tile')?.click()`);
await sleep(900);
log(
  'temp301 click tile (read only)',
  await evalJs(`({ dialog: !!document.querySelector('.pk-take__preview'), img: !!document.querySelector('.pk-take__preview img') })`),
);
await shot('take-temp301-preview.png');

// 10) 后台联系方式编辑器（L4 可写）
await asToken('mock.user.1');
await goto(`${APP}/admin/settings`);
log(
  'L4 settings',
  await evalJs(`({
  rows: [...document.querySelectorAll('.pk-contacts__row')].map((r) => [...r.querySelectorAll('input')].map((i) => i.value).join(' | ')),
  hasAdd: [...document.querySelectorAll('.pk-contacts__foot button')].map((b) => b.innerText),
})`),
);
await shot('admin-contact-editor.png');

// 改一条 + 加一条 → 保存 → 回读
await evalJs(`(() => {
  const rows = [...document.querySelectorAll('.pk-contacts__row')];
  const valueInput = rows[0].querySelectorAll('input.el-input__inner')[1];
  valueInput.value = 'weibo@pikeshe';
  valueInput.dispatchEvent(new Event('input'));
  [...document.querySelectorAll('.pk-contacts__foot button')].find((b) => b.innerText.includes('添加一条')).click();
})()`);
await sleep(600);
log(
  'L4 dirty',
  await evalJs(`({
  dirtyChip: [...document.querySelectorAll('.pk-chip')].map((c) => c.innerText).filter((t) => t.includes('已改动')),
  saveBtn: [...document.querySelectorAll('.pk-admin__inline button')].map((b) => b.innerText).find((t) => t.includes('保存')),
})`),
);
await evalJs(`[...document.querySelectorAll('.pk-admin__inline button')].find((b) => b.innerText.includes('保存')).click()`);
log('D34 口令弹窗', await reauth.pass());
await sleep(1600);
log('L4 save toast', await toast());
await shot('admin-contact-saved.png');

// 11) 保存后公开页立刻读到新值：mock 数据在内存里，必须同页走前端路由，整页导航会重置
await evalJs(`history.pushState({}, '', '/contact'); dispatchEvent(new PopStateEvent('popstate', { state: history.state }));`);
await sleep(1400);
log(
  'contact after save (same session)',
  await evalJs(`({ path: location.pathname, rows: [...document.querySelectorAll('.pk-contact__list li')].map((li) => li.innerText.replace(/\\s+/g,' ').trim()) })`),
);
await shot('contact-after-save.png');

// 12) L3 只读
await asToken('mock.user.2');
await goto(`${APP}/admin/settings`);
log(
  'L3 readonly',
  await evalJs(`({
  alert: document.querySelector('.el-alert__title')?.innerText ?? null,
  addDisabled: [...document.querySelectorAll('.pk-contacts__foot button')].map((b) => b.disabled),
})`),
);

cleanup();
console.log('\ndone');
process.exit(0);
