// 只读探针：以 L2 身份逐页抓「标题 / tab / 所有按钮文案」，定位用户口中的「我的相册 页面的 上传照片」到底在哪一页
// 用法：node output/probe-upload-labels.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const PORT = Number(process.env.CDP_PORT ?? 9251);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probeBase() {
  for (const p of [5173, 5174, 5175, 5176, 5177]) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(2500) });
      const text = await res.text();
      if (res.ok && text.includes('<div id="app"')) return `http://127.0.0.1:${p}`;
    } catch {
      /* port free */
    }
  }
  throw new Error('no live vite on 5173~5177');
}
const BASE = await probeBase();

const browser = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${OUT}edge-profile-labelprobe`,
    '--window-size=1440,1000',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
function cleanup() {
  spawn('taskkill', ['-PID', String(browser.pid), '-T', '-F'], { stdio: 'ignore' });
}

async function getVersion() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return r.json();
    } catch {
      /* not up yet */
    }
    await sleep(300);
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

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const call = (method, params = {}) => send(method, params, sessionId);
await call('Page.enable');
await call('Runtime.enable');

const EXPR = `(() => {
  const t = (el) => (el.innerText || '').replace(/\\s+/g, ' ').trim();
  return {
    path: location.pathname + location.search,
    h: [...document.querySelectorAll('h1,h2,h3')].map(t).filter(Boolean).slice(0, 8),
    tabs: [...document.querySelectorAll('.pk-tab, .pk-tabs button, [role=tablist] button, [role=tab]')].map(t).filter(Boolean),
    nav: [...document.querySelectorAll('.pk-nav a')].map(t).filter(Boolean),
    buttons: [...document.querySelectorAll('button, .el-button')].map(t).filter(Boolean),
    dropTitles: [...document.querySelectorAll('.pk-drop__title')].map(t).filter(Boolean),
  };
})()`;

const ROUTES = ['/albums', '/albums?tab=upload', '/albums/1', '/drive?tab=upload', '/me', '/home'];
await call('Page.addScriptToEvaluateOnNewDocument', {
  source: `localStorage.setItem('piks.accessToken', 'mock.user.3');`,
});

console.log(`BASE=${BASE}`);
for (const route of ROUTES) {
  await call('Page.navigate', { url: `${BASE}${route}` });
  await sleep(2600);
  const { result } = await call('Runtime.evaluate', { expression: EXPR, returnByValue: true });
  const v = result.value ?? {};
  console.log(`\n### ${route}  →  ${v.path}`);
  console.log('h1/h2/h3 :', (v.h ?? []).join(' | '));
  console.log('nav      :', (v.nav ?? []).join(' | '));
  console.log('tabs     :', (v.tabs ?? []).join(' | '));
  console.log('dropTitle:', (v.dropTitles ?? []).join(' | '));
  console.log('buttons  :', (v.buttons ?? []).filter((x) => x.length < 24).join(' / '));
}

cleanup();
