import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const PORT = 9225;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${OUT}edge-profile-probe`, '--window-size=1440,1000',
  '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-gpu', '--mute-audio',
  'about:blank',
], { stdio: 'ignore' });

function cleanup() {
  spawn('taskkill', ['-PID', String(browser.pid), '-T', '-F'], { stdio: 'ignore' });
}
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, (err) => { console.error('FATAL', err?.message ?? err); cleanup(); process.exit(1); });
}

async function getVersion() {
  for (let i = 0; i < 60; i += 1) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(300); }
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
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
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
    const timer = setTimeout(() => { ws.removeEventListener('message', onMsg); reject(new Error(`timeout ${method}`)); }, timeoutMs);
    function onMsg(ev) {
      const msg = JSON.parse(ev.data);
      if (msg.method === method && msg.sessionId === sessionId) { clearTimeout(timer); resolve(msg.params); }
    }
    ws.addEventListener('message', onMsg);
  });
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const call = (m, p = {}) => send(m, p, sessionId);
await call('Page.enable');
await call('Runtime.enable');
await call('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('piks.accessToken','mock.user.3');` });

const probe = () => call('Runtime.evaluate', {
  returnByValue: true,
  expression: `(() => {
    const nav = document.querySelector('.pk-nav');
    const inner = document.querySelector('.pk-header__inner');
    const cs = getComputedStyle(nav);
    const links = [...nav.querySelectorAll('a')];
    const nr = nav.getBoundingClientRect();
    return {
      vw: inner.clientWidth,
      navRect: { x: Math.round(nr.x), y: Math.round(nr.y), w: Math.round(nr.width) },
      flex: cs.flex, flexBasis: cs.flexBasis, width: cs.width, order: cs.order, overflowX: cs.overflowX,
      scrollW: nav.scrollWidth, clientW: nav.clientWidth,
      clipped: links.filter(a => a.getBoundingClientRect().right > nav.getBoundingClientRect().right + 1).map(a => a.innerText),
      rows: [...new Set(links.map(a => Math.round(a.getBoundingClientRect().y)))],
      media820: matchMedia('(max-width: 820px)').matches
    };
  })()`,
}).then((r) => r.result.value);

for (const w of [360, 390, 430, 820]) {
  await call('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 820 });
  const loaded = waitEvent('Page.loadEventFired', sessionId);
  await call('Page.navigate', { url: 'http://127.0.0.1:5173/' });
  await loaded;
  await sleep(1500);
  console.log(`--- ${w}px`, JSON.stringify(await probe()));
}

await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
const reloaded = waitEvent('Page.loadEventFired', sessionId);
await call('Page.navigate', { url: 'http://127.0.0.1:5173/' });
await reloaded;
await sleep(1500);

await call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 390, height: 150, scale: 2 } })
  .then(async ({ data }) => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(OUT + 'nav-390.png', Buffer.from(data, 'base64'));
    console.log('wrote nav-390.png');
  });

ws.close();
cleanup();
