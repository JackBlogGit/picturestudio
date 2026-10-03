// 加密空间页新增的「加密／解密」这对按钮（PRD 5.7 / D30）端到端验收。
// 覆盖：卡片只在解锁态出现且不污染既有读数契约 → 「加密」把本地文件封成 原名.BEKER 直接落盘
// （条目数、密文体积、配额一位不动）→ 「解密」吃这份产物按去掉后缀的原名还原、逐字节等于原文件
// → 与空间通道互通（本地加密的容器再「加密上传」入库、「解密下载」退一层仍是那份容器）
// → 三条失败路径（长度不足／版本字节不对／标签被改）都不写出半成品
// → 锁定态与只读视图收走这对按钮。
// 跑之前确认 client 的 vite 在 5173 上活着（VITE_USE_MOCK=true）；BASE 可用环境变量覆盖。
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const PROFILE = OUT + 'edge-profile-d30/';
const PORT = 9248;
const APP = process.env.BASE ?? 'http://127.0.0.1:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SIZE = 2 * 1024 * 1024;
const NAME = '返图原片-2MB.bin';
const BAKER = `${NAME}.BEKER`;
const DEMO_PASS = 'demo-vault';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
}

const browser = spawn(
  EDGE,
  [
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
  ],
  { stdio: 'ignore' },
);

function cleanup() {
  spawn('taskkill', ['-PID', String(browser.pid), '-T', '-F'], { stdio: 'ignore' });
}
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, (err) => {
    // stdout 接的是管道，exit 前不保证 flush；崩溃信息只能同步写 stderr
    writeSync(2, `FATAL ${err?.message ?? err}\n`);
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
  throw new Error('edge devtools never came up');
}

let id = 0;
const pending = new Map();
let ws;
function send(method, params = {}, sessionId) {
  const msgId = (id += 1);
  ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => pending.set(msgId, { resolve, reject }));
}

const info = await getVersion();
ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const call = (method, params = {}) => send(method, params, sessionId);
await call('Page.enable');
await call('Runtime.enable');
await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });

async function evalJs(expression, awaitPromise = false) {
  const res = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
  return res.result.value;
}

const HELPERS = `(() => {
  window.__v = {
    set(el, value) {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },
    inputs(scope) { return [...document.querySelectorAll(scope + ' input')]; },
    btn(text, scope) {
      const root = scope ? document.querySelector(scope) : document;
      if (!root) return null;
      return [...root.querySelectorAll('button')].find((n) => (n.innerText || '').includes(text)) || null;
    },
    click(text, scope) {
      const el = window.__v.btn(text, scope);
      if (!el) return 'MISSING:' + text;
      window.__v.mark();
      el.click();
      return 'CLICKED:' + text;
    },
    clickIn(scope, text) {
      const el = [...document.querySelectorAll(scope + ' button')].find((n) => (n.innerText || '').trim() === text);
      if (!el) return 'MISSING:' + text;
      window.__v.mark();
      el.click();
      return el.disabled ? 'DISABLED:' + text : 'CLICKED:' + text;
    },
    itemBtn(text, index) {
      const item = [...document.querySelectorAll('.pk-vault__item')][index];
      if (!item) return null;
      return [...item.querySelectorAll('.pk-vault__ops button')].find((n) => (n.innerText || '').includes(text)) || null;
    },
    clickItem(text, index) {
      const el = window.__v.itemBtn(text, index);
      if (!el) return 'MISSING:' + text + '#' + index;
      window.__v.mark();
      el.click();
      return el.disabled ? 'DISABLED:' + text : 'CLICKED:' + text;
    },
    mark() { window.__t0 = document.querySelectorAll('.el-message').length; return window.__t0; },
    toast() {
      return [...document.querySelectorAll('.el-message')].slice(window.__t0 ?? 0).map((n) => n.innerText.trim()).join(' | ');
    },
    pump() {
      return [...document.querySelectorAll('.pk-vault__qtask')].map((li) => {
        const strong = li.querySelector('.pk-vault__qname strong');
        const meta = li.querySelector('.pk-vault__qname span');
        const inner = li.querySelector('.el-progress-bar__inner');
        return {
          label: strong ? strong.innerText.trim() : '',
          meta: (meta ? meta.innerText : '').replace(/\\s+/g, ' ').trim(),
          detail: (li.querySelector('.pk-vault__qdetail') || {}).innerText || '',
          width: inner ? inner.style.width : '',
        };
      });
    },
    row(label) { return window.__v.pump().find((t) => t.label === label) || null; },
    state(label) { const r = window.__v.row(label); return r ? r.meta.split(' · ')[0] : ''; },
    pct(label) { const r = window.__v.row(label); return r ? Number((r.meta.match(/(\\d+)%/) || [])[1] ?? -1) : -1; },
    detail(label) { const r = window.__v.row(label); return r ? r.detail : ''; },
    watch(label) {
      window.__seen = [];
      window.__watchLabel = label;
      const push = () => {
        const r = window.__v.row(window.__watchLabel);
        if (!r) return;
        const key = r.meta + '|' + r.width;
        if (window.__seen[window.__seen.length - 1] !== key) window.__seen.push(key);
      };
      if (window.__obs) window.__obs.disconnect();
      window.__obs = new MutationObserver(push);
      window.__obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
      push();
      return true;
    },
    seenStates() {
      return JSON.stringify([...new Set((window.__seen ?? []).map((k) => k.split(' · ')[0]))]);
    },
    seenPcts() {
      return JSON.stringify((window.__seen ?? []).map((k) => Number((k.match(/(\\d+)%/) || [])[1] ?? -1)).filter((n) => n >= 0));
    },
    stopWatch() { if (window.__obs) window.__obs.disconnect(); return true; },
    capture() {
      window.__blobs = [];
      window.__dl = [];
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        window.__blobs.push({ size: blob.size, type: blob.type, blob });
        return orig(blob);
      };
      const anchorClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) {
          const last = window.__blobs[window.__blobs.length - 1];
          window.__dl.push({ name: this.download, size: last ? last.size : -1, type: last ? last.type : '' });
          return undefined;
        }
        return anchorClick.call(this);
      };
      return true;
    },
    dl() { return JSON.stringify(window.__dl); },
    blobs() { return JSON.stringify((window.__blobs ?? []).map((b) => ({ size: b.size, type: b.type }))); },
    // 原始素材：每个字节都按位置取模，内容不是一块常数，好让逐字节对账有意义
    seed(name) {
      const bytes = new Uint8Array(${SIZE});
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + 7) % 251;
      window.__seed = bytes;
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: 'application/octet-stream' }));
      const input = document.querySelectorAll('.pk-vault__tool-input')[0];
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return bytes.length;
    },
    async bytesOf(src) {
      if (src === 'seed') return window.__seed;
      return new Uint8Array(await window.__held.arrayBuffer());
    },
    async hold(index) { window.__held = window.__blobs[index].blob; return window.__held.size; },
    // index 0 = 「加密」的框，1 = 「解密」的框；truncate / version / flip 用来造三种坏容器
    async feedTool(index, opts) {
      const bytes = await window.__v.bytesOf(opts.src);
      let out = bytes;
      if (opts.truncate != null) out = out.subarray(0, opts.truncate);
      if (opts.version != null) out = Uint8Array.from(out, (_, i) => (i === 0 ? opts.version : out[i]));
      if (opts.flip) out = Uint8Array.from(out, (_, i) => (i === out.length - 1 ? out[i] ^ 0xff : out[i]));
      const copy = new Uint8Array(out.length);
      copy.set(out);
      const dt = new DataTransfer();
      dt.items.add(new File([copy], opts.name, { type: 'application/octet-stream' }));
      const input = document.querySelectorAll('.pk-vault__tool-input')[index];
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return copy.length;
    },
    async feedSpace(name, src) {
      const bytes = await window.__v.bytesOf(src);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: 'application/octet-stream' }));
      const input = document.querySelector('.pk-vault__input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return bytes.length;
    },
    async sameAsSeed(index) {
      const b = new Uint8Array(await window.__blobs[index].blob.arrayBuffer());
      const s = window.__seed;
      let diff = 0;
      let first = -1;
      const n = Math.min(b.length, s.length);
      for (let k = 0; k < n; k += 1) if (b[k] !== s[k]) { if (first < 0) first = k; diff += 1; }
      return { length: b.length, seedLength: s.length, diff, first, equal: b.length === s.length && diff === 0 };
    },
    snap() {
      const t = (sel) => (document.querySelector(sel) || {}).innerText || '';
      return {
        path: location.pathname + location.search,
        chip: (document.querySelector('.pk-vault__who .pk-chip') || {}).innerText || '',
        title: t('.pk-vault__title'),
        entries: t('.pk-vault__stats div strong'),
        stats: t('.pk-vault__stats').replace(/\\s+/g, ' '),
        quota: t('.pk-vault__quota').replace(/\\s+/g, ' '),
        toolCount: document.querySelectorAll('.pk-vault__tool').length,
        toolTitle: t('.pk-vault__tooltitle'),
        toolBtns: [...document.querySelectorAll('.pk-vault__toolbtns button')].map((b) => (b.innerText || '').trim() + (b.disabled ? '=off' : '=on')),
        toolNote: t('.pk-vault__toolnote').replace(/\\s+/g, ''),
        actions: [...document.querySelectorAll('.pk-vault__actions button')].map((b) => (b.disabled ? 1 : 0)),
        opButtons: document.querySelectorAll('.pk-vault__ops button').length,
        forms: document.querySelectorAll('.pk-vault__form').length,
        drop: t('.pk-vault__drop'),
        names: [...document.querySelectorAll('.pk-vault__name')].map((n) => n.innerText.trim()),
        subs: [...document.querySelectorAll('.pk-vault__sub')].map((n) => n.innerText.replace(/\\s+/g, ' ').trim()),
        qrows: window.__v.pump(),
        toast: window.__v.toast(),
      };
    },
  };
})()`;

async function snap() {
  return JSON.parse(await evalJs('JSON.stringify(window.__v.snap())'));
}

async function until(expr, timeout = 60000) {
  const started = Date.now();
  for (;;) {
    const ok = await evalJs(`(() => { try { return Boolean(${expr}); } catch { return false; } })()`);
    if (ok) return true;
    if (Date.now() - started > timeout) return false;
    await sleep(120);
  }
}

async function shot(file) {
  const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(OUT + file, Buffer.from(data, 'base64'));
  console.log('     wrote ' + file);
}

async function goto(url, settle = 900) {
  await call('Page.navigate', { url });
  await sleep(settle);
  await evalJs(HELPERS);
}

async function unlockWith(pass) {
  await evalJs(`window.__v.set(window.__v.inputs('.pk-vault__form')[0], ${JSON.stringify(pass)})`);
  await evalJs(`window.__v.click('解锁')`);
  return until(`window.__v.toast().includes('已解锁') || window.__v.toast().includes('口令不对')`);
}

/** 收掉已结束行：队列按标签找行，留着上一轮的同名旧行会把新任务的状态盖掉 */
async function clearQueue() {
  await evalJs(`window.__v.click('清除已结束')`);
  return until('window.__v.pump().length === 0');
}

/** 队列某一行的阶段序列里出现过这些阶段 */
const statesOf = async () => JSON.parse(await evalJs('window.__v.seenStates()'));
const pctsOf = async () => JSON.parse(await evalJs('window.__v.seenPcts()'));

// ---------------- A. 卡片只在解锁态出现，且不碰既有读数契约 ----------------
await goto(`${APP}/login`);
await evalJs(`localStorage.setItem('piks.accessToken', 'mock.user.1')`);
await goto(`${APP}/drive/encrypted`);

let s = await snap();
check('A1 L4 直达加密文件页', s.path === '/drive/encrypted', s.path);
check('A2 锁定态不渲染这对按钮', s.toolCount === 0 && s.title.includes('解锁加密空间'), `tool=${s.toolCount} title=${s.title}`);

const unlocked = (await unlockWith(DEMO_PASS)) && (await snap()).toast.includes('已解锁');
check('A3 演示口令可解锁', unlocked, (await snap()).toast);
s = await snap();
check('A4 卡片标题为「本地加解密」', s.toolCount === 1 && s.toolTitle === '本地加解密', `${s.toolCount} / ${s.toolTitle}`);
check('A5 恰好两枚按钮：加密、解密', s.toolBtns.length === 2 && s.toolBtns[0] === '加密=on' && s.toolBtns[1] === '解密=on', String(s.toolBtns));
check('A6 说明写明不上传不入库不占配额', s.toolNote.includes('不上传、不入库、不占配额'), s.toolNote.slice(0, 40));
check(
  'A7 既有契约没被污染：动作四枚、无口令框、拖放区仍在',
  s.actions.length === 4 && s.actions.every((d) => d === 0) && s.forms === 0 && s.drop !== '',
  `actions=${s.actions} forms=${s.forms} drop=${s.drop ? 1 : 0}`,
);
const baseEntries = s.entries;
const baseStats = s.stats;
const baseQuota = s.quota;

// ---------------- B. 「加密」：本地文件 → .BEKER 直接落盘，空间不动 ----------------
await evalJs('window.__v.capture()');
await evalJs(`window.__v.watch(${JSON.stringify(BAKER)})`);
const seeded = await evalJs(`window.__v.seed(${JSON.stringify(NAME)})`);
await until(`window.__v.state(${JSON.stringify(BAKER)}) === '已完成'`);
const bStates = await statesOf();
const bPcts = await pctsOf();
const bDl = JSON.parse(await evalJs('window.__v.dl()'));
const bDetail = await evalJs(`window.__v.detail(${JSON.stringify(BAKER)})`);
check('B1 种子文件按预期大小喂入', seeded === SIZE, String(seeded));
check('B2 队列行走过读取与加密两段', bStates.includes('读取中') && bStates.includes('加密中'), bStates.join(' → '));
check('B3 本地加密不碰接口：没有提交与取回两段', !bStates.includes('提交中') && !bStates.includes('取回中'), bStates.join(' → '));
check('B4 百分位单调不降', bPcts.every((n, i) => i === 0 || n >= bPcts[i - 1]), String([...new Set(bPcts)]));
check('B5 落盘名是 原名.BEKER', bDl[0] && bDl[0].name === BAKER, JSON.stringify(bDl[0]));
check('B6 落盘体积 = 明文 + 29 容器开销', bDl[0] && bDl[0].size === SIZE + 29, `${bDl[0] && bDl[0].size} vs ${SIZE + 29}`);
check('B7 容器不按原 MIME 落盘', bDl[0] && bDl[0].type === 'application/octet-stream', String(bDl[0] && bDl[0].type));
check('B8 明细写明未上传与 + 29 字节开销', bDetail.includes('未上传') && bDetail.includes('29 字节开销'), bDetail);
s = await snap();
check('B9 空间条目数一位没动', s.entries === baseEntries, `${baseEntries} → ${s.entries}`);
check('B10 密文体积与配额一位没动', s.stats === baseStats && s.quota === baseQuota, `${s.stats} / ${s.quota}`);
await shot('d30-01-encrypted.png');

// ---------------- C. 「解密」吃 B 的产物：原名落盘、逐字节回到原文件 ----------------
await clearQueue();
await evalJs(`window.__v.hold(0)`, true);
await evalJs('window.__v.capture()');
await evalJs(`window.__v.watch(${JSON.stringify(NAME)})`);
await evalJs(`window.__v.feedTool(1, ${JSON.stringify({ src: 'held', name: BAKER })})`, true);
await until(`window.__v.state(${JSON.stringify(NAME)}) === '已完成'`);
const cStates = await statesOf();
const cDl = JSON.parse(await evalJs('window.__v.dl()'));
const cSame = await evalJs(`window.__v.sameAsSeed(0)`, true);
const cDetail = await evalJs(`window.__v.detail(${JSON.stringify(NAME)})`);
check('C1 队列行按去掉后缀的原名挂出', cStates.length > 0 && !!cDl[0], JSON.stringify(cDl[0]));
check('C2 本地解密走过读取与解密两段', cStates.includes('读取中') && cStates.includes('解密中'), cStates.join(' → '));
check('C3 本地解密不取回密文', !cStates.includes('取回中') && !cStates.includes('提交中'), cStates.join(' → '));
check('C4 落盘名回到原名、不被 .BEKER 取代', cDl[0] && cDl[0].name === NAME, JSON.stringify(cDl[0]));
check('C5 落盘体积回到明文大小', cDl[0] && cDl[0].size === SIZE, String(cDl[0] && cDl[0].size));
check('C6 解出的字节与原文件逐字节相同', cSame.equal === true, JSON.stringify(cSame));
check('C7 明细写明未经服务端与 − 29', cDetail.includes('未经服务端') && cDetail.includes('字节开销'), cDetail);
await shot('d30-02-roundtrip.png');

// ---------------- D. 与空间通道互通：本地容器 →「加密上传」→「解密下载」退一层 ----------------
const entriesBefore = (await snap()).entries;
await clearQueue();
await evalJs(`window.__v.feedSpace(${JSON.stringify(BAKER)}, 'held')`, true);
await until(`document.querySelectorAll('.pk-vault__name').length > ${Number(entriesBefore)}`);
s = await snap();
const newIndex = s.names.indexOf(BAKER);
check('D1 本地加密产物可作为普通文件入库', newIndex >= 0, String(s.names));
check('D2 条目数只加了这一条', s.entries === String(Number(entriesBefore) + 1), `${entriesBefore} → ${s.entries}`);
await evalJs('window.__v.capture()');
const clickPlain = await evalJs(`window.__v.clickItem('解密下载', ${newIndex})`);
await until('window.__dl.length >= 1');
const dDl = JSON.parse(await evalJs('window.__v.dl()'));
check('D3 解密下载退一层得到的就是那份 .BEKER 容器', clickPlain.startsWith('CLICKED') && dDl[0] && dDl[0].name === BAKER && dDl[0].size === SIZE + 29, `${clickPlain} / ${JSON.stringify(dDl[0])}`);
await clearQueue();
await evalJs('window.__v.hold(0)', true);
await evalJs('window.__v.capture()');
await evalJs(`window.__v.watch(${JSON.stringify(NAME)})`);
await evalJs(`window.__v.feedTool(1, ${JSON.stringify({ src: 'held', name: BAKER })})`, true);
await until(`window.__v.state(${JSON.stringify(NAME)}) === '已完成'`);
const dSame = await evalJs(`window.__v.sameAsSeed(0)`, true);
check('D4 这一份容器再走本地解密仍回到原文件', dSame.equal === true, JSON.stringify(dSame));
await shot('d30-03-interop.png');

// ---------------- E. 三条失败路径都不写出半成品 ----------------
const fails = [
  { tag: 'E1', label: '假容器.txt', opts: { src: 'seed', name: '假容器.txt.BEKER', truncate: 10 }, want: '不是 .BEKER 容器' },
  { tag: 'E2', label: '版本不对.bin', opts: { src: 'held', name: '版本不对.bin.BEKER', version: 2 }, want: '版本字节是 2' },
  { tag: 'E3', label: '被改过.bin', opts: { src: 'held', name: '被改过.bin.BEKER', flip: true }, want: '解不开' },
];
for (const f of fails) {
  await evalJs('window.__v.capture()');
  await evalJs(`window.__v.watch(${JSON.stringify(f.label)})`);
  await evalJs(`window.__v.feedTool(1, ${JSON.stringify(f.opts)})`, true);
  const done = await until(`window.__v.state(${JSON.stringify(f.label)}) === '失败'`);
  const why = await evalJs(`window.__v.detail(${JSON.stringify(f.label)})`);
  const wrote = JSON.parse(await evalJs('window.__v.dl()')).length;
  check(`${f.tag} 坏容器被判失败而不是写出文件`, done && wrote === 0, `done=${done} wrote=${wrote} 失败明细=${why}`);
  check(`${f.tag}b 失败原因可诊断`, String(why).includes(f.want), String(why));
}
s = await snap();
const failRows = s.qrows.filter((r) => r.meta.startsWith('失败'));
check('E4 三条失败都留在队列里可回看', failRows.length === 3, s.qrows.map((r) => r.meta).join(' / '));
check('E5 失败路径不改变空间条目', s.entries === String(Number(entriesBefore) + 1), `${entriesBefore} → ${s.entries}`);
await shot('d30-04-failures.png');

// ---------------- F. 不带后缀的容器按原名写回、锁定后这对按钮一起收走 ----------------
await evalJs('window.__v.capture()');
await evalJs(`window.__v.watch('随手改过名的.bin')`);
await evalJs(`window.__v.feedTool(1, ${JSON.stringify({ src: 'held', name: '随手改过名的.bin' })})`, true);
await until(`window.__v.state('随手改过名的.bin') === '失败' || window.__v.state('随手改过名的.bin') === '已完成'`);
const bare = JSON.parse(await evalJs('window.__v.dl()'));
const bareState = await evalJs(`window.__v.state('随手改过名的.bin')`);
check('F1 没有 .BEKER 后缀时落盘名原样保留（不硬造名字）', bareState === '已完成' && bare[0] && bare[0].name === '随手改过名的.bin', `${bareState} / ${JSON.stringify(bare[0])}`);

await evalJs(`window.__v.click('锁定')`);
await until(`window.__v.snap().title.includes('解锁加密空间')`);
s = await snap();
check('F2 锁定后这对按钮随整张工作卡一起收走', s.toolCount === 0 && s.actions.length === 0, `tool=${s.toolCount} actions=${s.actions.length}`);
check('F3 重新解锁后回到可用态', (await unlockWith(DEMO_PASS)) && (await snap()).toolCount === 1, (await snap()).toolBtns.join(','));

// ---------------- G. 他人只读视图：这对按钮不出现，D26 边界不变 ----------------
await goto(`${APP}/drive/encrypted?owner=3`);
await until(`window.__v.snap().title.includes('只读容量视图')`);
s = await snap();
check('G1 他人空间不渲染本地加解密卡', s.toolCount === 0, `tool=${s.toolCount}`);
check('G2 只读视图仍没有口令框与拖放区', s.forms === 0 && s.drop === '', `forms=${s.forms} drop=${JSON.stringify(s.drop)}`);
check('G3 他人条目仍是每项两枚按钮', s.opButtons === s.names.length * 2, `ops=${s.opButtons} names=${s.names.length}`);
await shot('d30-05-readonly.png');
await evalJs('window.__v.stopWatch()');

cleanup();
const failed = results.filter((r) => !r.ok);
await writeFile(
  OUT + 'd30-verify.log',
  results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  → ' + r.detail : ''}`).join('\n') + '\n',
);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
