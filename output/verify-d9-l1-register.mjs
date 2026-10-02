import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const PORT = 9230;
const APP = 'http://127.0.0.1:5178';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${OUT}edge-profile-d9`,
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
  nav: [...document.querySelectorAll('.pk-nav a')].map(a => a.innerText),
})`;

console.log('=== D9 L1 注册入口验收 ===');

// 1. L1 在顶栏能看到「入口」「任务」
await goto('mock.user.4', '/home');
const l1Nav = await evalJs(STATE);
console.log(`L1 顶栏: nav=[${l1Nav.nav.join('|')}]`);

// 2. L1 点「入口」能进，三扇门里「注入新游客」可见
await goto('mock.user.4', '/entry');
const entryL1 = await evalJs(`[...document.querySelectorAll('.pk-entry__name')].map(e => e.innerText)`);
console.log(`L1 入口页门: [${entryL1.join('|')}]`);

// 3. L1 进注册页，时长上限被压到 7 天
await goto('mock.user.4', '/guest/new');
const regL1 = await evalJs(`({
  maxDays: document.querySelector('.pk-reg__row--days .pk-muted')?.innerText.includes('最多 7 天'),
  inputMax: Number(document.querySelector('.pk-reg__field label').nextElementSibling?.querySelector('input[type="number"]')?.max || -1),
})`);
console.log(`L1 注册页: maxDays提示=${regL1.maxDays}, input-max=${regL1.inputMax}`);

// 4. L2 同样能进，但上限是 365（并行会话的 mock 还没改 server 口径）
await goto('mock.user.3', '/guest/new');
const regL2 = await evalJs(`({
  maxDaysHint: document.querySelector('.pk-reg__row--days .pk-muted')?.innerText,
})`);
console.log(`L2 注册页: ${regL2.maxDaysHint}`);

// 5. 临时账号手敲 /guest/new → 弹回 /home
await goto('mock.temp.301', '/guest/new');
const tempBlock = await evalJs(STATE);
console.log(`临时账号撞墙: path=${tempBlock.path} toast=[${tempBlock.toasts.join('|')}]`);

ws.close();
cleanup();
