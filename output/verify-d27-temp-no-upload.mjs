// D27 验证：临时账号只能取图——拍展传图入口（导航/tab/入口门/深链）按身份整体消失，成员不受影响
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
const PORT = 9231;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${OUT}edge-profile-d27`,
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
    throw new Error(`${detail}\n  ---- expr head: ${expr.slice(0, 60)}`);
  }
  return res.result.value;
}

async function goto(path) {
  const loaded = waitEvent('Page.loadEventFired', sessionId);
  await call('Page.navigate', { url: `${BASE}${path}` });
  await loaded;
  await sleep(1500);
  return evalJs(`(() => ({
    path: location.pathname + location.search,
    nav: [...document.querySelectorAll('.pk-nav a, .pk-nav .el-menu-item')].map(a => a.innerText.trim()),
    tabs: [...document.querySelectorAll('.pk-tabs .pk-tab')].map(t => t.innerText.trim()).filter(Boolean),
    doors: [...document.querySelectorAll('.pk-entry__door .pk-entry__name')].map(d => d.innerText),
    entryEmpty: document.querySelector('.pk-entry__grid')?.children.length === 0,
    fileInputs: document.querySelectorAll('.pk-file__input').length,
    shootTitle: document.querySelector('.pk-page-title')?.innerText ?? '',
    toasts: [...document.querySelectorAll('.el-message')].map(t => t.innerText),
    flags: [...document.querySelectorAll('.pk-flags .el-tag')].map(t => t.innerText.trim()),
    caps: (document.querySelector('.pk-caps')?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
  }))()`);
}

const WHO = [
  ['', '游客'],
  ['mock.user.4', 'L1 小满'],
  ['mock.user.3', 'L2 阿澄'],
  ['mock.user.1', 'L4 夜刃'],
  ['mock.temp.301', '临时 柚子'],
];

const LIST = process.env.WHO
  ? WHO.filter(([, label]) => label.includes(process.env.WHO))
  : WHO;

for (const [token, label] of LIST) {
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: token
      ? `localStorage.setItem('piks.accessToken', ${JSON.stringify(token)});`
      : `localStorage.removeItem('piks.accessToken');`,
  });
  const home = await goto('/');
  const albums = await goto('/albums');
  const deep = await goto('/albums?tab=upload');
  const entry = await goto('/entry');
  const take = await goto('/take');
  const caps = await goto('/me');
  console.log(
    `\n[${label}]  nav传图=${albums.nav.includes('拍展传图') ? 'Y' : 'N'} nav传文件=${albums.nav.includes('传文件') ? 'Y' : 'N'}  nav=[${albums.nav.join('|')}]` +
      `\n  /albums tabs=[${albums.tabs.join('|')}] fileInputs=${albums.fileInputs}` +
      `\n  深链 /albums?tab=upload → ${deep.path} ${deep.toasts.length ? `toast=${deep.toasts.join('/')}` : ''}` +
      `\n  /entry doors=[${entry.doors.join('|')}]${entry.entryEmpty ? ' (空态)' : ''}` +
      `\n  /take 「${take.shootTitle}」 /me 「${caps.shootTitle}」` +
      `\n  flags=[${caps.flags.join('|')}]  caps=${caps.caps}`,
  );
}

cleanup();
