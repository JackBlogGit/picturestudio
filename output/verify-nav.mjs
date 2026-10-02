import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const PORT = 9224;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${OUT}edge-profile-nav`,
  '--window-size=1440,1000',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  '--disable-gpu',
  '--mute-audio',
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
      return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    } catch {
      await sleep(300);
    }
  }
  throw new Error('devtools never came up');
}

let id = 0;
const pending = new Map();
const version = await getVersion();
const ws = new WebSocket(version.webSocketDebuggerUrl);
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

function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const msgId = (id += 1);
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
  });
}

function waitEvent(method, sessionId, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMsg);
      reject(new Error(`timeout waiting for ${method}`));
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

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const call = (method, params = {}) => send(method, params, sessionId);
await call('Page.enable');
await call('Runtime.enable');

async function evalJs(expr) {
  const res = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) {
    const detail = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
    throw new Error(`${detail}\n  ---- expr head: ${expr.slice(0, 60)}\n  ---- expr tail: ${expr.slice(-60)}`);
  }
  return res.result.value;
}

async function loadWith(token) {
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: token
      ? `localStorage.setItem('piks.accessToken', ${JSON.stringify(token)});`
      : `localStorage.removeItem('piks.accessToken');`,
  });
  const loaded = waitEvent('Page.loadEventFired', sessionId);
  await call('Page.navigate', { url: 'http://127.0.0.1:5173/' });
  await loaded;
  await sleep(1600);
}

const WHO = [
  ['', '游客'],
  ['mock.user.4', 'L1 小满'],
  ['mock.user.3', 'L2 阿澄'],
  ['mock.user.1', 'L4 夜刃'],
  ['mock.temp.301', '临时 柚子'],
];

for (const [token, label] of WHO) {
  await loadWith(token);
  const nav = await evalJs(`[...document.querySelectorAll('.pk-nav a')].map(a => a.innerText)`);
  console.log(`${label.padEnd(9)} caps.upload=${nav.includes('拍展传图') ? 'Y' : 'N'}  nav=[${nav.join(' ')}]`);
}

await loadWith('mock.user.3');
const clicked = await evalJs(`(() => {
  const a = [...document.querySelectorAll('.pk-nav a')].find(x => x.innerText === '拍展传图');
  if (!a) return 'link missing';
  a.click();
  return 'clicked';
})()`);
await sleep(1400);
console.log(clicked, JSON.stringify(await evalJs(`({
  path: location.pathname,
  h2: document.querySelector('.pk-page-title')?.innerText,
  active: [...document.querySelectorAll('.pk-nav a.router-link-active')].map(a => a.innerText),
  buttons: [...document.querySelectorAll('.pk-drop__actions button')].map(b => b.innerText),
  fileInputs: document.querySelectorAll('.pk-file__input').length,
  hits: (() => {
    const hits = [];
    document.querySelectorAll('.pk-file__input').forEach((inp, i) => inp.addEventListener('click', () => hits.push(i)));
    document.querySelectorAll('.pk-drop__actions button').forEach((b) => b.click());
    return hits;
  })(),
  overflowX: document.querySelector('.pk-nav').scrollWidth > document.querySelector('.pk-nav').clientWidth
})`)));

await call('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });
await sleep(900);
const { data } = await call('Page.captureScreenshot', { format: 'png' });
const { writeFile } = await import('node:fs/promises');
await writeFile(OUT + 'nav-shoot-mobile.png', Buffer.from(data, 'base64'));
console.log('wrote nav-shoot-mobile.png');

ws.close();
cleanup();
