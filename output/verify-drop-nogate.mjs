// 验证传图页第 3 步的按钮不再受第 1 步门槛限制：未选交付对象时按钮可点、能选文件入队、能拖放，
// 点「开始上传」才被挡（与网盘上传面板同一口径）
// 用法：node output/verify-drop-nogate.mjs
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const PORT = Number(process.env.CDP_PORT ?? 9253);
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
    `--user-data-dir=${OUT}edge-profile-nogate`,
    '--window-size=1440,1400',
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
const ev = async (expression) =>
  (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;

await call('Page.addScriptToEvaluateOnNewDocument', {
  source: `localStorage.setItem('piks.accessToken', 'mock.user.3');`,
});
await call('Page.navigate', { url: `${BASE}/albums?tab=upload` });
await sleep(3400);

const step = async (label, expression) => {
  const v = await ev(expression);
  console.log(`${label}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  return v;
};

await step('卡片状态', `(() => ({
  lockedCards: document.querySelectorAll('.pk-step--locked').length,
  waitBadges: [...document.querySelectorAll('.pk-step__badge')].map(e => e.innerText.trim()),
}))()`);

await step('两颗按钮可点', `(() => {
  const btns = [...document.querySelectorAll('.pk-drop__actions .el-button')];
  const inputs = [...document.querySelectorAll('.pk-drop__actions input[type=file]')];
  return JSON.stringify({
    labels: btns.map(b => b.innerText.trim()),
    btnDisabled: btns.map(b => b.disabled),
    inputDisabled: inputs.map(i => i.disabled),
  });
})()`);

await step('未选交付对象即可入队 2 张', `(async () => {
  const input = document.querySelector('.pk-drop__actions input[type=file]');
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array(2048)], 'a.jpg', { type: 'image/jpeg' }));
  dt.items.add(new File([new Uint8Array(2048)], 'b.jpg', { type: 'image/jpeg' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 700));
  return document.querySelector('.pk-queue__head')?.innerText.replace(/\\s+/g, ' ').trim() ?? 'NO QUEUE';
})()`);

await step('拖放同样入队', `(async () => {
  const zone = document.querySelector('.pk-drop');
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array(2048)], 'c.jpg', { type: 'image/jpeg' }));
  const e = new Event('drop', { bubbles: true });
  e.dataTransfer = dt;
  zone.dispatchEvent(e);
  await new Promise(r => setTimeout(r, 700));
  return document.querySelector('.pk-queue__head')?.innerText.replace(/\\s+/g, ' ').trim() ?? 'NO QUEUE';
})()`);

await step('点开始上传被挡', `(async () => {
  const btn = [...document.querySelectorAll('.pk-queue__head .el-button')].find(b => b.innerText.includes('开始上传'));
  btn.click();
  await new Promise(r => setTimeout(r, 900));
  return [...document.querySelectorAll('.el-message')].map(m => m.innerText.replace(/\\s+/g, ' ').trim()).join(' | ') || 'NO TOAST';
})()`);

await step('队列里没有会话被建（仍为排队）', `(() => {
  const states = [...document.querySelectorAll('.pk-task__name span')].map(s => s.innerText.trim());
  return JSON.stringify(states);
})()`);

const shot = await call('Page.captureScreenshot', { format: 'png' });
writeFileSync(`${OUT}nogate-full.png`, Buffer.from(shot.data, 'base64'));
const box = await ev(`(() => { const el = document.querySelector('.pk-drop'); const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height}); })()`);
const b = JSON.parse(box);
const clip = await call('Page.captureScreenshot', {
  format: 'png',
  clip: { x: Math.max(0, b.x - 20), y: Math.max(0, b.y - 60), width: b.w + 40, height: b.h + 80, scale: 1 },
});
writeFileSync(`${OUT}drop-shoot.png`, Buffer.from(clip.data, 'base64'));

cleanup();
