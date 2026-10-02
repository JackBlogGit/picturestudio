import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const PROFILE = OUT + 'edge-profile-enc/';
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
    cols: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : null,
    count: cells.length,
    labels: cells.map((c) => c.querySelector('.pk-work__name')?.innerText),
  });
})()`;

for (const [label, token] of [['L4', 'mock.user.1'], ['L3', 'mock.user.2'], ['L2', 'mock.user.3'], ['L1', 'mock.user.4']]) {
  await evalJs(`localStorage.setItem('piks.accessToken', ${JSON.stringify(token)});`);
  await goto(`${APP}/home`);
  const info = JSON.parse(await evalJs(PROBE));
  console.log(`[${label}] count=${info.count} cols=${info.cols} encrypted=${info.labels.includes('加密文件')} labels=${info.labels.join(',')}`);
  await shot(`home-${label}.png`);
}

ws.close();
cleanup();
await sleep(400);
