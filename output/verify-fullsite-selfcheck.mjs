// 全站自检：逐身份 × 逐路由走一遍，抓「未捕获异常 / console.error / Vue 警告 / HTTP 失败 / 白屏 / 错误 toast」
// 用法：node output/verify-fullsite-selfcheck.mjs        （自动探 5173~5177 上活着的 vite）
//       BASE=http://127.0.0.1:5174 node output/verify-fullsite-selfcheck.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const PORT = Number(process.env.CDP_PORT ?? 9241);
const LABEL = process.env.LABEL ?? 'run';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probeBase() {
  if (process.env.BASE) return process.env.BASE;
  for (const p of [5173, 5174, 5175, 5176, 5177]) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(2500) });
      const text = await res.text();
      if (res.ok && text.includes('<div id="app"')) return `http://127.0.0.1:${p}`;
    } catch {
      /* 端口空着 */
    }
  }
  throw new Error('5173~5177 上没有活的 vite —— 先在 client/ 里 npx vite --port 5173');
}
const BASE = await probeBase();

const browser = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${OUT}edge-profile-selfcheck`,
    '--window-size=1440,1000',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-gpu',
    '--mute-audio',
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
  throw new Error('devtools never came up');
}

let id = 0;
const pending = new Map();
const listeners = new Set();
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
    return;
  }
  if (msg.method) for (const fn of listeners) fn(msg);
});

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
      listeners.delete(onMsg);
      reject(new Error(`timeout waiting for ${method}`));
    }, timeoutMs);
    function onMsg(msg) {
      if (msg.method === method && msg.sessionId === sessionId) {
        clearTimeout(timer);
        listeners.delete(onMsg);
        resolve(msg.params);
      }
    }
    listeners.add(onMsg);
  });
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const call = (method, params = {}) => send(method, params, sessionId);
await call('Page.enable');
await call('Runtime.enable');
await call('Network.enable');

/** 每次导航前清空，导航后收拢：本路由期间冒出来的所有硬信号 */
let bag = [];
function resetBag() {
  bag = [];
}
listeners.add((msg) => {
  const sidOk = (m) => !m.sessionId || m.sessionId === sessionId;
  if (msg.method === 'Runtime.exceptionThrown' && sidOk(msg)) {
    const d = msg.params.exceptionDetails;
    bag.push(`EXCEPTION ${d.exception?.description?.split('\n')[0] ?? d.text}`);
  }
  if (msg.method === 'Runtime.consoleAPICalled' && sidOk(msg)) {
    const { type, args } = msg.params;
    if (type !== 'error' && type !== 'warning') return;
    const text = args
      .map((a) => a.value ?? a.description ?? a.type ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .slice(0, 260);
    if (/favicon|Download the Vue Devtools|ResizeObserver loop/i.test(text)) return;
    bag.push(`CONSOLE_${type} ${text}`);
  }
  if (msg.method === 'Network.responseReceived' && sidOk(msg)) {
    const { status, url } = msg.params.response;
    if (status >= 400 && !url.startsWith(BASE)) return;
    if (status >= 400) bag.push(`HTTP_${status} ${url.replace(BASE, '')}`);
  }
  if (msg.method === 'Network.loadingFailed' && sidOk(msg)) {
    bag.push(`NET_FAIL ${msg.params.errorText}`);
  }
});

const WHO = [
  ['', '游客'],
  ['mock.user.4', 'L1 小满'],
  ['mock.user.3', 'L2 阿澄'],
  ['mock.user.2', 'L3 白泽'],
  ['mock.user.1', 'L4 夜刃'],
  ['mock.temp.301', '临时·柚子'],
];
const LIST = process.env.WHO ? WHO.filter(([, l]) => l.includes(process.env.WHO)) : WHO;

const ROUTES = [
  '/',
  '/home',
  '/albums',
  '/albums?tab=upload',
  '/albums/1',
  '/entry',
  '/guest/new',
  '/tasks',
  '/tasks/manage',
  '/drive',
  '/drive?tab=upload',
  '/drive/encrypted',
  '/take',
  '/contact',
  '/me',
  '/s/pk-youzi-cp29-a7f3',
  '/s/pk-person-qingye-4d18',
  '/s/pk-revoked-0002',
  '/nope-not-a-route',
  '/login',
  '/admin',
  '/admin/albums',
  '/admin/members',
  '/admin/tags',
  '/admin/drive',
  '/admin/shares',
  '/admin/logs',
  '/admin/settings',
  '/admin/crawler',
];

async function snapshot() {
  return (
    await call('Runtime.evaluate', {
      expression: `(() => ({
        path: location.pathname + location.search,
        title: document.title,
        mount: (document.querySelector('#app')?.innerText ?? '').trim().length,
        errToasts: [...document.querySelectorAll('.el-message--error')].map(t => t.innerText.replace(/\\s+/g,' ').trim()),
      }))()`,
      returnByValue: true,
      awaitPromise: true,
    })
  ).result.value;
}

/** 轮询到 #app 有内容为止：mock 会话要先 await /auth/me，固定 sleep 会在挂载前抓拍，误报白屏 */
async function waitMounted(budgetMs = 4000) {
  const deadline = Date.now() + budgetMs;
  let snap = await snapshot();
  while (snap.mount === 0 && Date.now() < deadline) {
    await sleep(120);
    snap = await snapshot();
  }
  if (snap.mount > 0) {
    await sleep(450); // 挂载后留一点余量，晚到的请求失败与错误 toast 也要抓到
    snap = await snapshot();
  }
  return snap;
}

const rows = [];
const seen = new Map();

for (const [token, label] of LIST) {
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: token
      ? `localStorage.setItem('piks.accessToken', ${JSON.stringify(token)});`
      : `localStorage.removeItem('piks.accessToken');`,
  });
  for (const route of ROUTES) {
    resetBag();
    const loaded = waitEvent('Page.loadEventFired', sessionId);
    await call('Page.navigate', { url: `${BASE}${route}` });
    await loaded;
    const snap = await waitMounted();
    const problems = [...new Set(bag)];
    if (snap.mount === 0) problems.push('BLANK #app 没有任何内容');
    for (const t of snap.errToasts) problems.push(`ERROR_TOAST ${t}`);
    rows.push({ label, route, landed: snap.path, blank: snap.mount === 0, problems });
    for (const p of problems) seen.set(p.replace(/\d+/g, 'N'), (seen.get(p.replace(/\d+/g, 'N')) ?? 0) + 1);
  }
}

let fail = 0;
console.log(`BASE=${BASE}  label=${LABEL}  identities=${LIST.length}  routes=${ROUTES.length}`);
for (const r of rows) {
  if (!r.problems.length) continue;
  fail += 1;
  console.log(`\n✗ [${r.label}] ${r.route} → ${r.landed}${r.blank ? ' (白屏)' : ''}`);
  for (const p of r.problems) console.log(`    · ${p}`);
}

console.log(`\n—— 落点矩阵（守卫重定向是否符合预期，人工核） ——`);
for (const [, label] of LIST) {
  const mine = rows.filter((r) => r.label === label);
  console.log(`[${label}] ${mine.map((r) => `${r.route.split('?')[0]}→${r.landed.split('?')[0]}`).join('  ')}`);
}

console.log(`\n汇总：${rows.length} 次导航，${fail} 次带硬信号，涉及 ${seen.size} 类签名`);
for (const [sig, n] of [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ×${n}  ${sig}`);
}
console.log(fail === 0 ? 'RESULT=CLEAN' : `RESULT=${fail} PROBLEM NAVIGATIONS`);

cleanup();
