import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const PROFILE = OUT + 'edge-profile/';
const PORT = 9223;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = spawn(EDGE, [
  `--headless=new`,
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  `--window-size=1440,1000`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  '--disable-features=ChromeWhatsNewUI,SyncPromos',
  '--metrics-recording-only',
  '--mute-audio',
  '--disable-gpu',
  '--hide-scrollbars',
  'about:blank',
], { stdio: 'ignore' });

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
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return await res.json();
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

function waitEvent(method, sessionId, timeoutMs = 25_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMsg);
      reject(new Error(`timed out waiting for ${method}`));
    }, timeoutMs);
    function onMsg(ev) {
      const msg = JSON.parse(ev.data);
      if (msg.method === method && msg.sessionId === sessionId) {
        clearTimeout(timer);
        resolve(msg.params);
      }
    }
    ws.addEventListener('message', onMsg);
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
await call('Page.addScriptToEvaluateOnNewDocument', {
  source: `localStorage.setItem('piks.accessToken', 'mock.user.3');`,
});

async function evalJs(expression, awaitPromise = false) {
  const res = await call('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise,
  });
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text));
  return res.result.value;
}

async function shot(file) {
  const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(OUT + file, Buffer.from(data, 'base64'));
  console.log('wrote', file);
}

await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
const loaded = waitEvent('Page.loadEventFired', sessionId);
await call('Page.navigate', { url: 'http://127.0.0.1:5173/shoot' });
await loaded;
await sleep(2500);
await shot('shoot-desktop.png');

console.log('identity:', await evalJs(`document.body.innerText.match(/阿澄|游客|admin|夜刃|白泽|小满/)?.[0] ?? '?'`));
console.log('title:', await evalJs(`document.querySelector('.pk-page-title')?.innerText ?? '?'`));

await call('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });
await sleep(800);
await shot('shoot-mobile-empty.png');

console.log('picker wired:', JSON.stringify(await evalJs(`(() => {
  const hits = [];
  const inputs = [...document.querySelectorAll('.pk-file__input')];
  inputs.forEach((inp, i) => inp.addEventListener('click', () => hits.push(i)));
  [...document.querySelectorAll('.pk-drop__actions button')].forEach((b) => b.click());
  return { buttons: document.querySelectorAll('.pk-drop__actions button').length, hits };
})()`)));

await evalJs(`(async () => {
  const input = document.querySelector('.pk-file__input');
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array(3_600_000).fill(255)], 'IMG_20261001_1830.jpg', { type: 'image/jpeg' }));
  dt.items.add(new File([new Uint8Array(2_100_000).fill(128)], 'IMG_20261001_1842.jpg', { type: 'image/jpeg' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return document.querySelectorAll('.pk-task').length;
})()`, true);
await sleep(400);
await shot('shoot-mobile-queue.png');

await evalJs(`[...document.querySelectorAll('.pk-queue__head button')].find(b => b.innerText.includes('开始上传')).click()`);
await sleep(1800);
await shot('shoot-mobile-done.png');
console.log('rows:', JSON.stringify(await evalJs(`[...document.querySelectorAll('.pk-task__name')].map(e => e.innerText.replace(/\\n/g,' / '))`)));
console.log('toast:', await evalJs(`document.querySelector('.el-message')?.innerText ?? '-'`));

ws.close();
browser.kill();
await sleep(500);
spawn('taskkill', ['-PID', String(browser.pid), '-T', '-F'], { stdio: 'ignore' });
