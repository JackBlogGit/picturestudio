import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const PROFILE = OUT + 'edge-profile-home/';
const PORT = 9231;
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

const { targetId } = await send('Target.createTarget', { url: APP + '/login' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const call = (method, params = {}) => send(method, params, sessionId);

await call('Page.enable');
await call('Runtime.enable');
await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await goto(`${APP}/login`);

async function evalJs(expression, awaitPromise = false) {
  const res = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text));
  return res.result.value;
}

async function goto(url) {
  const done = new Promise((r) => setTimeout(r, 1600));
  await call('Page.navigate', { url });
  await done;
}

async function shot(file) {
  const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(OUT + file, Buffer.from(data, 'base64'));
  console.log('  wrote', file);
}

const PROBE = `(() => {
  const cells = [...document.querySelectorAll('.pk-work__cell')];
  const grid = document.querySelector('.pk-work__grid');
  return JSON.stringify({
    path: location.pathname,
    nav: !!document.querySelector('.pk-nav'),
    welcome: document.querySelector('.pk-welcome')?.innerText ?? null,
    identity: document.querySelector('.pk-identity')?.innerText ?? null,
    cols: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : null,
    count: cells.length,
    labels: cells.map((c) => c.querySelector('.pk-work__name')?.innerText),
    danger: cells.filter((c) => c.className.includes('danger')).map((c) => c.querySelector('.pk-work__name')?.innerText),
    iconBox: cells[0] ? (() => { const r = cells[0].querySelector('.pk-work__icon').getBoundingClientRect(); return Math.round(r.width / r.height * 100) / 100; })() : null,
    banner: document.querySelector('.pk-count__label')?.innerText ?? null,
    bannerValue: document.querySelector('.pk-count__value')?.innerText ?? null,
    bannerUrgent: !!document.querySelector('.pk-count--urgent, .pk-count--expired'),
  });
})()`;

async function asToken(token) {
  await evalJs(`localStorage.setItem('piks.accessToken', ${JSON.stringify(token)});`);
}

const IDENTITIES = [
  ['L4', 'mock.user.1'],
  ['L3', 'mock.user.2'],
  ['L2', 'mock.user.3'],
  ['L1', 'mock.user.4'],
  ['temp', 'mock.temp.301'],
];

for (const [label, token] of IDENTITIES) {
  await asToken(token);
  await goto(`${APP}/home`);
  const info = JSON.parse(await evalJs(PROBE));
  console.log(`\n[${label}]`, JSON.stringify(info, null, 1));
  await shot(`home-${label}.png`);
}

await asToken('mock.temp.301');
await goto(`${APP}/home`);
await evalJs(`[...document.querySelectorAll('.pk-work__cell')].find((c) => c.innerText.includes('取图')).click()`);
await sleep(600);
console.log(
  '\n[pending cell] toast =',
  await evalJs(`document.querySelector('.el-message')?.innerText ?? '-'`),
  'path =',
  await evalJs('location.pathname'),
);

await asToken('');
await goto(`${APP}/home`);
console.log('\n[guest->/home] path =', await evalJs('location.pathname'));
await goto(`${APP}/`);
console.log('[guest] path =', await evalJs('location.pathname'), 'nav =', await evalJs('String(!!document.querySelector(".pk-nav"))'));

await asToken('mock.temp.301');
await call('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });
await goto(`${APP}/home`);
const mobile = JSON.parse(await evalJs(PROBE));
console.log('\n[temp mobile] cols =', mobile.cols, 'count =', mobile.count, 'wordmarkShown =', await evalJs('String(!!document.querySelector(".pk-logo__word em")?.offsetParent)'));
await shot('home-temp-mobile.png');

await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await goto(`${APP}/home`);
await evalJs(`[...document.querySelectorAll('.pk-work__cell')].find((c) => c.innerText.includes('销毁')).click()`);
await sleep(900);
const dialogText = await evalJs(`document.querySelector('.el-message-box__title')?.innerText + ' || ' + document.querySelector('.el-message-box__message')?.innerText`);
console.log('\n[danger] dialog =', dialogText);
const accountId = /帐户ID\s+(\S+)\s+的后/.exec(String(dialogText))?.[1] ?? '';
const tail = accountId.slice(-6);
console.log('[danger] accountId =', accountId, 'tail =', tail);
await shot('home-destroy-confirm.png');

function fillAndConfirm(value) {
  return evalJs(`(() => {
  const inp = document.querySelector('.el-message-box__input input');
  if (!inp) return 'NO_INPUT';
  inp.value = ${JSON.stringify(value)};
  inp.dispatchEvent(new Event('input'));
  const btn = [...document.querySelectorAll('.el-message-box__btns button')].find((b) => b.innerText.includes('确认'));
  if (!btn) return 'NO_BUTTON';
  btn.click();
  return 'clicked';
})()`);
}

console.log('[danger] wrong attempt =', await fillAndConfirm('WRONG1'));
await sleep(700);
console.log(
  '[danger] wrong code error =',
  await evalJs(
    `document.querySelector('.el-message-box__errormsg')?.innerText ?? document.querySelector('.el-message-box__error')?.innerText ?? '(none)'`,
  ),
);
await shot('home-destroy-wrong.png');
console.log('[danger] still open =', await evalJs(`String(!!document.querySelector('.el-message-box'))`));

console.log('[danger] right attempt =', await fillAndConfirm(tail));
await sleep(1600);
console.log('[danger] after destroy path =', await evalJs('location.pathname'));
console.log('[danger] toast =', await evalJs(`document.querySelector('.el-message')?.innerText ?? '-'`));
console.log('[danger] token cleared =', await evalJs(`String(localStorage.getItem('piks.accessToken'))`));
await shot('home-after-destroy.png');

ws.close();
cleanup();
await sleep(400);
