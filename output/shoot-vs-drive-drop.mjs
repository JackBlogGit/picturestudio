// 抓两张实拍图：传图页的上传卡 vs 网盘上传面板的上传卡（L2 身份），用于逐像素比对差异
// 用法：node output/shoot-vs-drive-drop.mjs
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const PORT = Number(process.env.CDP_PORT ?? 9252);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probeBase() {
  for (const p of [5173, 5174, 5175, 5176, 5177]) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(2500) });
      const text = await res.text();
      if (res.ok && text.includes('<div id="app"')) return `http://127.0.0.1:${p}`;
    } catch {
      /* free */
    }
  }
  throw new Error('no live vite');
}
const BASE = await probeBase();

const browser = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${OUT}edge-profile-dropcmp`,
    '--window-size=1440,1100',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const cleanup = () => spawn('taskkill', ['-PID', String(browser.pid), '-T', '-F'], { stdio: 'ignore' });

async function getVersion() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return r.json();
    } catch {
      /* wait */
    }
    await sleep(300);
  }
  throw new Error('no devtools');
}

let id = 0;
const pending = new Map();
const version = await getVersion();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (!msg.id || !pending.has(msg.id)) return;
  const { resolve, reject } = pending.get(msg.id);
  pending.delete(msg.id);
  if (msg.error) reject(new Error(`${msg.error.code} ${msg.error.message}`));
  else resolve(msg.result);
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const mid = (id += 1);
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const call = (m, p = {}) => send(m, p, sessionId);
await call('Page.enable');
await call('Runtime.enable');
await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
await call('Page.addScriptToEvaluateOnNewDocument', {
  source: `localStorage.setItem('piks.accessToken', 'mock.user.3');`,
});

const jobs = [
  ['drop-shoot', '/albums?tab=upload'],
  ['drop-drive', '/drive?tab=upload'],
];

for (const [name, route] of jobs) {
  await call('Page.navigate', { url: `${BASE}${route}` });
  await sleep(3200);
  const box = await call('Runtime.evaluate', {
    expression: `(() => { const el = document.querySelector('.pk-drop'); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height}); })()`,
    returnByValue: true,
  });
  console.log(name, box.result.value);
  const b = JSON.parse(box.result.value);
  const pad = 18;
  const shot = await call('Page.captureScreenshot', {
    format: 'png',
    clip: {
      x: Math.max(0, b.x - pad),
      y: Math.max(0, b.y - pad),
      width: b.w + pad * 2,
      height: Math.min(b.h + pad * 2, 1100 - b.y),
      scale: 1,
    },
  });
  writeFileSync(`${OUT}${name}.png`, Buffer.from(shot.data, 'base64'));
}

cleanup();
