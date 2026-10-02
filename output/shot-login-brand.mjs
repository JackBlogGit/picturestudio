import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const PROFILE = OUT + 'edge-profile-login/';
const PORT = 9227;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = spawn(EDGE, [
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
], { stdio: 'ignore' });

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

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const call = (method, params = {}) => send(method, params, sessionId);

await call('Page.enable');
await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await call('Page.navigate', { url: 'http://127.0.0.1:5173/login' });
await sleep(3000);

const { data } = await call('Page.captureScreenshot', { format: 'png' });
await writeFile(OUT + 'login-brand.png', Buffer.from(data, 'base64'));
console.log('wrote login-brand.png');

const probe = await call('Runtime.evaluate', {
  expression: `(() => {
    const brand = document.querySelector('.pk-login__brand');
    const cs = (el) => el && getComputedStyle(el);
    return {
      brandText: brand?.innerText.replace(/\\n/g, ' | ') ?? 'MISSING',
      hasShe: document.body.innerText.includes('皮克设'),
      imgSrc: document.querySelector('.pk-login__logo')?.getAttribute('src'),
      imgNatural: (() => { const i = document.querySelector('.pk-login__logo'); return i ? i.naturalWidth + 'x' + i.naturalHeight : '-'; })(),
      strongColor: cs(document.querySelector('.pk-login__wordmark strong'))?.color,
      spanColor: cs(document.querySelector('.pk-login__wordmark span'))?.color,
      box: brand ? (function (r) { return Math.round(r.width) + 'x' + Math.round(r.height) + ' @' + Math.round(r.x) + ',' + Math.round(r.y); })(brand.getBoundingClientRect()) : '-',
    };
  })()`,
  returnByValue: true,
});
console.log(JSON.stringify(probe.result.value ?? probe.exceptionDetails, null, 2));

ws.close();
browser.kill();
await sleep(400);
spawn('taskkill', ['-PID', String(browser.pid), '-T', '-F'], { stdio: 'ignore' });
