/**
 * /guest/new 的「名称」字段验收：注册页现在能设显示名（PRD 6.2 的 display_name），
 * 不再一律回落成帐户ID。全程不刷新（mock 数据活在页面内存）：换页走 router.push，
 * 登录走 /login 的「游客 / 返图链接」表单。
 * 覆盖：字段位置与长度上限 → 空名／纯空格挡住「创立」→ 创立回执与完成卡 →
 * 「复制帐号信息」含名称行 → 任务列表按名称渲染 → 用新账号的 ID+口令登录后 /me 显示名称 →
 * D9 的 7 天上限提示未被挤坏。
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const PROFILE = OUT + 'edge-profile-tempname/';
const PORT = 9241;
const APP = process.env.BASE ?? 'http://127.0.0.1:5173';
const NAME = '验收·雪乃';
const PW = 'demo1234';
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

async function goto(token, path) {
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('piks.accessToken', ${JSON.stringify(token)});`,
  });
  await call('Page.navigate', { url: APP + path });
  await sleep(2200);
}

/** 不刷新换页 */
async function nav(path) {
  await evalJs(`(async () => {
    const router = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$router;
    if (router) await router.push(${JSON.stringify(path)});
  })()`);
  await sleep(1200);
}

/** v-model 吃的就是 input 事件，直接改 value 再派发即可 */
async function type(fieldIndex, value) {
  return evalJs(`(() => {
    const field = document.querySelectorAll('.pk-reg__field')[${fieldIndex}];
    const input = field?.querySelector('input') ?? field?.querySelector('textarea');
    if (!input) return 'missing';
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
}

const FORM = `(JSON.stringify({
  labels: [...document.querySelectorAll('.pk-reg__field > label')].map((l) => l.innerText.trim()),
  nameMax: document.querySelectorAll('.pk-reg__field')[1]?.querySelector('input')?.maxLength ?? null,
  nameValue: document.querySelectorAll('.pk-reg__field')[1]?.querySelector('input')?.value ?? null,
  createDisabled: !!document.querySelector('.pk-reg__actions button.el-button--primary')?.disabled,
  code: document.querySelectorAll('.pk-reg__field')[0]?.querySelector('input')?.value ?? '',
  daysHint: document.querySelector('.pk-reg__row--days .pk-muted')?.innerText ?? '',
}))`;

const toastText = () =>
  evalJs(`[...document.querySelectorAll('.el-message')].map((t) => t.innerText.trim()).join(' | ') || '-'`);

async function shot(file) {
  const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(OUT + file, Buffer.from(data, 'base64'));
  console.log('  wrote', file);
}

console.log(`=== 临时账号「名称」字段验收 @ ${APP} ===\n`);

// 1) L2 进注册页：字段在帐户ID 之后，30 字上限，D9 的 7 天提示还在
await goto('mock.user.3', '/guest/new');
const f1 = await probe(FORM);
check('字段顺序：名称紧跟帐户ID', f1.labels[0]?.startsWith('帐户ID') && f1.labels[1] === '名称（必填）', f1.labels.slice(0, 3));
check('名称输入框 maxlength=30', f1.nameMax === 30, f1.nameMax);
check('D9 时长上限提示未被打乱', f1.daysHint.includes('最多 7 天'), f1.daysHint);

// 2) 空名 / 纯空格都挡住「创立」
await type(2, PW);
await type(3, PW);
const blank = await probe(FORM);
check('密码填好但名称为空 → 创立禁用', blank.createDisabled === true && blank.nameValue === '', {
  createDisabled: blank.createDisabled,
});
await type(1, '   ');
const spaces = await probe(FORM);
check('名称纯空格 → 创立仍禁用', spaces.createDisabled === true, spaces.nameValue);

// 3) 填名称 → 创立
await type(1, NAME);
const ready = await probe(FORM);
check('名称填好 → 创立可用', ready.createDisabled === false);
await shot('reg-with-name.png');
await evalJs(`document.querySelector('.pk-reg__actions button.el-button--primary').click()`);
await sleep(1600);
const done = await probe(`(JSON.stringify({
  strong: document.querySelector('.pk-reg__done strong')?.innerText ?? '',
  toast: [...document.querySelectorAll('.el-message')].map((t) => t.innerText.trim()).join(' | '),
  path: location.pathname,
}))`);
check('完成卡显示「名称 · 帐户ID」', done.strong === `${NAME} · ${f1.code}`, done.strong);
check('成功回执仍在', done.toast.includes('账号已创立'), done.toast);

// 4) 复制帐号信息里带名称（劫持剪贴板取文本）
await evalJs(`(() => {
  window.__clip = null;
  Object.defineProperty(navigator.clipboard, 'writeText', {
    value: (t) => { window.__clip = t; return Promise.resolve(); },
    configurable: true,
  });
  document.querySelectorAll('.pk-reg__actions button')[0].click();
  return true;
})()`);
await sleep(600);
const clip = await evalJs(`window.__clip ?? ''`);
check('复制文本含「名称：xxx」行', clip.includes(`名称：${NAME}`), clip.split('\n').slice(0, 3));

// 5) 任务列表按名称渲染（同页内存，不刷新）
await nav('/tasks');
const row = await probe(`(() => {
  const el = [...document.querySelectorAll('.pk-task')].find((r) => r.innerText.includes(${JSON.stringify(f1.code)}));
  return JSON.stringify({ found: !!el, text: (el?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 80) });
})()`);
check('任务列表那一行写出名称', row.found && row.text.includes(NAME), row.text);

// 6) 用新账号的 ID + 口令登录，/me 显示名称
await nav('/login');
await evalJs(`(() => {
  const tabs = [...document.querySelectorAll('.el-tabs__item')];
  tabs.find((t) => t.innerText.includes('游客'))?.click();
  return tabs.map((t) => t.innerText.trim());
})()`);
await sleep(500);
const logged = await evalJs(`(async () => {
  const inputs = [...document.querySelectorAll('.el-tab-pane')].flatMap((p) => [...p.querySelectorAll('input')])
    .filter((i) => i.type !== 'checkbox' && i.offsetParent !== null);
  const id = inputs.find((i) => i.placeholder === 'PK-2026-0913');
  if (!id) return 'no-temp-form';
  id.value = ${JSON.stringify(f1.code)};
  id.dispatchEvent(new Event('input', { bubbles: true }));
  const pw = inputs.find((i) => i.type === 'password');
  pw.value = ${JSON.stringify(PW)};
  pw.dispatchEvent(new Event('input', { bubbles: true }));
  return 'filled';
})()`);
check('登录页游客表单已填', logged === 'filled', logged);
await evalJs(`(() => {
  const btn = [...document.querySelectorAll('.el-tab-pane button')].find((b) => b.innerText.includes('进入') && b.offsetParent !== null);
  btn?.click();
  return !!btn;
})()`);
await sleep(1600);
const after = await probe(`(JSON.stringify({ path: location.pathname, toast: [...document.querySelectorAll('.el-message')].map((t)=>t.innerText.trim()).join(' | ') }))`);
check('以新临时账号登录成功', after.path === '/home', after);
await nav('/me');
const me = await probe(`(JSON.stringify({ name: document.querySelector('.pk-me__id h2, .pk-page-title')?.innerText ?? '' }))`);
check('/me 显示的是名称而不是帐户ID', me.name.includes(NAME), me.name);
await shot('me-as-new-temp.png');

// 7) 回归：L1 进来同一把尺子（名称为空照样挡住创立，D9 的 7 天上限仍在）
await goto('mock.user.4', '/guest/new');
await type(2, PW);
await type(3, PW);
const l1 = await probe(FORM);
check('L1 注册页同样要求名称', l1.createDisabled === true && l1.labels[1] === '名称（必填）', l1.labels.slice(1, 2));
check('L1 的 D9 提示未被打乱', l1.daysHint.includes('最多 7 天'), l1.daysHint);

const failed = results.filter((r) => !r.pass);
console.log(`\nRESULT=${failed.length ? 'FAIL' : 'CLEAN'} — ${results.length - failed.length}/${results.length} 通过`);
for (const f of failed) console.log('  未过：' + f.name);
cleanup();
process.exit(failed.length ? 1 : 0);
