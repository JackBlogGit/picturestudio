import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const PORT = 9226;
const APP = 'http://127.0.0.1:5174';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${OUT}edge-profile-register`,
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

/** 每次导航前重新注入令牌，SPA 内部跳转不经过这里 */
async function goto(token, path) {
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: token
      ? `localStorage.setItem('piks.accessToken', ${JSON.stringify(token)});`
      : `localStorage.removeItem('piks.accessToken');`,
  });
  const loaded = waitEvent('Page.loadEventFired', sessionId);
  await call('Page.navigate', { url: APP + path });
  await loaded;
  await sleep(1500);
}

const STATE = `({
  path: location.pathname,
  title: document.querySelector('.pk-page-title')?.innerText ?? '',
  ops: [...document.querySelectorAll('.pk-tasks__ops button')].map((b) => b.innerText.trim()),
  toasts: [...document.querySelectorAll('.el-message')].map((t) => t.innerText.trim()),
})`;

const CASES = [
  ['', '游客', '/guest/new'],
  ['mock.temp.301', '临时 柚子', '/guest/new'],
  ['mock.temp.301', '临时 柚子', '/tasks'],
  ['mock.user.4', 'L1 小满', '/guest/new'],
  ['mock.user.3', 'L2 阿澄', '/guest/new'],
  ['mock.user.3', 'L2 阿澄', '/tasks'],
];

for (const [token, label, path] of CASES) {
  await goto(token, path);
  const s = await evalJs(STATE);
  console.log(`${label.padEnd(9)} ${path.padEnd(12)} -> ${s.path.padEnd(11)} ${s.title.padEnd(14)} ops=[${s.ops.join('|')}] toast=[${s.toasts.join('|')}]`);
}

// 点按钮真跳一次：L2 在任务列表页点「注册临时账号」应落到注册页
await goto('mock.user.3', '/tasks');
console.log('click:', await evalJs(`(() => {
  const b = [...document.querySelectorAll('.pk-tasks__ops button')].find((x) => x.innerText.includes('注册临时账号'));
  if (!b) return 'button missing';
  b.click();
  return 'clicked';
})()`));
await sleep(1200);
console.log('L2 点击后:', JSON.stringify(await evalJs(STATE)));

ws.close();
cleanup();
