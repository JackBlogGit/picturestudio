/**
 * 规则 13（超管给个人开启文件权限）的端到端验证：
 * 同一个页面上下文里先用 L1 小满看网盘基线 → 切超管在成员管理开「文件权限1 + 文件权限3」→
 * 再切回小满看网盘，目录应当从「什么都没有」变成「工作室 + 她自己的共享文件夹」。
 * mock 数据活在页面内存里，所以全程靠顶栏「演示身份」切换，不能刷新页面。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeReauth } from './lib-reauth.mjs';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const PROFILE = OUT + 'edge-profile-grant/';
const PORT = 9236;
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

/** D34：保存授权前会先弹一次身份再验证 */
const reauth = makeReauth({ evalJs, sleep });

async function goto(token, path) {
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('piks.accessToken', ${JSON.stringify(token)});`,
  });
  await call('Page.navigate', { url: APP + path });
  await sleep(2200);
}

async function click(selector, text, { index } = {}) {
  const done = await evalJs(`(() => {
    let els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    if (${JSON.stringify(text ?? '')}) els = els.filter((e) => e.innerText.trim().includes(${JSON.stringify(text ?? '')}));
    if (!els.length) return 'missing:' + ${JSON.stringify(selector)};
    const el = els[${index ?? 0}];
    el.click();
    return 'clicked';
  })()`);
  await sleep(900);
  return done;
}

async function shot(file) {
  const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(OUT + file, Buffer.from(data, 'base64'));
  console.log('  wrote', file);
}

const DRIVE = `(() => {
  const cards = [...document.querySelectorAll('article.pk-item:not(.pk-item--file)')];
  return JSON.stringify({
    path: location.pathname + location.search,
    folders: cards.map((c) => c.querySelector('.pk-item__name')?.innerText.trim()),
    empty: !!document.querySelector('.pk-drive__empty'),
  });
})()`;

const MEMBERS = `(() => {
  const row = [...document.querySelectorAll('.el-table__row')].find((r) => r.innerText.includes('小满'));
  return JSON.stringify({
    toasts: [...document.querySelectorAll('.el-message')].map((t) => t.innerText.trim()),
    grantCell: row?.innerText.replace(/\\s+/g, ' ').slice(0, 120) ?? null,
    gates: [...document.querySelectorAll('.pk-admin__grant')].map((g) => g.innerText.replace(/\\s+/g, ' ').trim()),
  });
})()`;

async function driveView() {
  const info = JSON.parse(await evalJs(DRIVE));
  console.log(`  ${info.path} -> folders=[${info.folders.join(' | ')}] empty=${info.empty}`);
  return info;
}

/** /home 是工作台模式、顶栏 nav 不渲染，所以进网盘要两条路：顶栏链接 → 宫格「传文件」＋一级标签「文件」 */
async function goDrive() {
  const viaNav = await click('.pk-nav a', '网盘');
  if (viaNav === 'missing:.pk-nav a') {
    await click('.pk-work__cell', '传文件');
    await sleep(1200);
    await click('.pk-drive__tabs *', '文件');
  }
  await sleep(1400);
  return driveView();
}

/** 进后台成员页：宫格「管理」→ 侧栏「成员」 */
async function goMembers() {
  await click('.pk-admin__menu a', '成员');
  if (!(await evalJs(`!!document.querySelector('.pk-admin__menu a')`))) {
    await click('.pk-work__cell', '管理');
    await sleep(1600);
    await click('.pk-admin__menu a', '成员');
  }
  await sleep(1400);
}

// 1) 基线：L1 小满能进哪些目录
await goto('mock.user.4', '/drive');
const before = JSON.parse(await evalJs(DRIVE));
console.log('[基线 L1 小满] folders=[', before.folders.join(' | '), '] empty=', before.empty);
await shot('grant-01-l1-before.png');

// 2) 切超管，进成员管理给小满开 文件权限1 + 文件权限3
await click('.pk-header__user button', '演示身份');
await click('.el-dropdown-menu__item', 'L4 超管');
await sleep(900);
await goMembers();
console.log('[成员页]', (await evalJs(MEMBERS)).slice(0, 200));
console.log('  点小满行的网盘授权:', await evalJs(`(() => {
  const row = [...document.querySelectorAll('.el-table__row')].find((r) => r.innerText.includes('小满'));
  const btn = [...(row?.querySelectorAll('button') ?? [])].find((b) => b.innerText.includes('网盘授权'));
  if (!btn) return 'missing';
  btn.click();
  return 'clicked';
})()`));
await sleep(900);
const opened = await evalJs(`!!document.querySelector('.pk-admin__grant')`);
console.log('  授权弹窗打开:', opened);
const gateInfo = JSON.parse(await evalJs(MEMBERS));
for (const line of gateInfo.gates) console.log('   ·', line);
await shot('grant-02-dialog.png');
await click('.pk-admin__grant .el-switch', '', { index: 0 });
await click('.pk-admin__grant .el-switch', '', { index: 2 });
await click('.el-dialog__footer button', '保存授权');
console.log('  口令弹窗:', await reauth.pass());
await sleep(900);
console.log('[保存后]', await evalJs(MEMBERS));
await shot('grant-03-granted.png');

// 3) 切回小满，网盘里应当多出「工作室」与她的共享文件夹
await click('.pk-header__user button', '演示身份');
await click('.el-dropdown-menu__item', 'L1 见习');
await sleep(900);
const after = await goDrive();
await shot('grant-04-l1-after.png');

// 4) L3 白泽视角：授权入口是超管独占，成员页不该出现这枚按钮
await click('.pk-header__user button', '演示身份');
await click('.el-dropdown-menu__item', 'L3 管理员');
await sleep(900);
await goMembers();
const asL3 = await evalJs(`(() => {
  const rows = [...document.querySelectorAll('.el-table__row')];
  return JSON.stringify({
    rows: rows.length,
    grantBtns: rows.filter((r) => r.innerText.includes('网盘授权')).length,
    toast: [...document.querySelectorAll('.el-message')].map((t) => t.innerText.trim()).join('|'),
  });
})()`);
console.log('[L3 白泽看成员页]', asL3);

const okWorkspace = after.folders.includes('工作室');
const okShared = after.folders.includes('小满');
console.log(
  '结论: 工作室=',
  okWorkspace,
  ' 本人共享文件夹=',
  okShared,
  ' 基线为空=',
  before.folders.length === 0,
  okWorkspace && okShared ? 'PASS' : 'FAIL',
);

ws.close();
cleanup();
await sleep(400);
