// 加密文件页的 .BEKER 落盘名与传输进度（PRD 5.7 / D29）端到端验收。
// 覆盖：解锁 → 条目显示 .BEKER 标记（原名一栏不掺后缀）→ 4MB 文件加密上传（进度阶段与百分位由
// MutationObserver 逐次渲染记录，不靠采样撞时机）→ 「下载加密文件」得到 原名.BEKER 容器
// （体积 = 明文 + 29、版本字节为 1）→ 用同一个内核就地解回明文（证明 .BEKER 是真能还原的容器）
// → 清除已结束 → 「解密下载」得到原名与明气体积 → 锁定后整片条目区收走
// → 他人只读视图仍保持「每项两枚按钮」的 D26 结构。
// 跑之前确认 client 的 vite 在 5173 上活着（VITE_USE_MOCK=true）；BASE 可用环境变量覆盖。
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const PROFILE = OUT + 'edge-profile-beker/';
const PORT = 9247;
const APP = process.env.BASE ?? 'http://127.0.0.1:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SIZE = 4 * 1024 * 1024;
const NAME = '摊位素材-4MB.bin';
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
    snap() {
      return {
        path: location.pathname + location.search,
        chip: (document.querySelector('.pk-vault__who .pk-chip') || {}).innerText || '',
        title: (document.querySelector('.pk-vault__title') || {}).innerText || '',
        names: [...document.querySelectorAll('.pk-vault__name')].map((n) => n.innerText.trim()),
        tags: [...document.querySelectorAll('.pk-vault__tag')].map((n) => n.innerText.replace(/\\s/g, '')),
        subs: [...document.querySelectorAll('.pk-vault__sub')].map((n) => n.innerText.replace(/\\s+/g, ' ').trim()),
        ops: [...document.querySelectorAll('.pk-vault__ops button')].map((b) => (b.disabled ? 1 : 0)),
        opText: [...document.querySelectorAll('.pk-vault__item')]
          .map((it) => [...it.querySelectorAll('.pk-vault__ops button')].map((b) => b.innerText.trim()).join('+')),
        qrows: window.__v.pump(),
        drop: (document.querySelector('.pk-vault__drop') || {}).innerText || '',
        toast: window.__v.toast(),
      };
    },
    // 队列行的真实读数：文本态 + 内层条宽度，两者同源不同属性
    pump() {
      return [...document.querySelectorAll('.pk-vault__qtask')].map((li) => {
        const strong = li.querySelector('.pk-vault__qname strong');
        const meta = li.querySelector('.pk-vault__qname span');
        const inner = li.querySelector('.el-progress-bar__inner');
        const detail = li.querySelector('.pk-vault__qdetail');
        return {
          label: strong ? strong.innerText.trim() : '',
          meta: (meta ? meta.innerText : '').replace(/\\s+/g, ' ').trim(),
          width: inner ? inner.style.width : '',
          detail: (detail ? detail.innerText : '').replace(/\\s+/g, ' ').trim(),
        };
      });
    },
    // 只盯某一行（按落盘名认），把每次 DOM 渲染记下来——快慢都不漏中间态
    watch(label) {
      window.__seen = [];
      window.__watchLabel = label;
      const push = () => {
        const row = window.__v.pump().find((t) => t.label === window.__watchLabel);
        if (!row) return;
        const key = row.meta + '|' + row.width;
        if (window.__seen[window.__seen.length - 1] !== key) window.__seen.push(key);
      };
      if (window.__obs) window.__obs.disconnect();
      window.__pushSeen = push;
      window.__obs = new MutationObserver(push);
      window.__obs.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
      push();
      return true;
    },
    seen() { return JSON.stringify(window.__seen ?? []); },
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
    payload() {
      const bytes = new Uint8Array(${SIZE});
      for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i % 251;
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], ${JSON.stringify(NAME)}, { type: 'application/octet-stream' }));
      const input = document.querySelector('.pk-vault__input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    // .BEKER 容器就地解回明文：动态 import 页面同一份内核，用空间口令重新派生密钥
    async reopen(index, pass) {
      const entry = window.__blobs[index];
      const bytes = new Uint8Array(await entry.blob.arrayBuffer());
      const c = await import('/src/utils/crypto.ts');
      const v = await import('/src/api/vault.ts');
      const st = await v.vaultStatus();
      const key = await c.deriveVaultKey(pass, { salt: st.salt, iterations: st.iterations });
      const plain = await c.decryptBytes(key, bytes);
      return {
        version: bytes[0],
        overhead: bytes.length - plain.length,
        plainLength: plain.length,
        at0: plain[0],
        at4096: plain[4096],
        ext: c.CIPHER_EXT,
        cost: c.CONTAINER_OVERHEAD,
      };
    },
  };
})()`;

async function snap() {
  return JSON.parse(await evalJs('JSON.stringify(window.__v.snap())'));
}

async function until(expr, timeout = 45000) {
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

/** 从「取回中 · 42%」这种读数里取百分位与阶段 */
const pctOf = (row) => Number((row.meta.match(/(\d+)%/) || [])[1] ?? -1);
const stageOf = (row) => row.meta.split(' · ')[0];

// ---------------- A. 解锁后的条目命名 ----------------
await goto(`${APP}/login`);
await evalJs(`localStorage.setItem('piks.accessToken', 'mock.user.1')`);
await goto(`${APP}/drive/encrypted`);

let s = await snap();
check('A1 L4 直达加密文件页', s.path === '/drive/encrypted', s.path);
check('A2 锁定态不渲染条目与标记', s.names.length === 0 && s.tags.length === 0, `names=${s.names.length} tags=${s.tags.length}`);

const unlocked = (await unlockWith(DEMO_PASS)) && (await snap()).toast.includes('已解锁');
check('A3 演示口令可解锁', unlocked, (await snap()).toast);
await until(`document.querySelectorAll('.pk-vault__name').length >= 2`);
s = await snap();
check('A4 文件名一栏仍是纯原名', s.names.length === 2 && s.names.every((n) => !n.includes('BEKER')), String(s.names));
check('A5 每条目挂出 .BEKER 落盘后缀', s.tags.length === 2 && s.tags.every((t) => t === '.BEKER'), String(s.tags));
await shot('beker-01-unlocked.png');

// ---------------- B. 4MB 加密上传的进度 ----------------
await evalJs('window.__v.capture()');
await evalJs('window.__v.payload()');
await evalJs(`window.__v.watch(${JSON.stringify(NAME)})`);
await until(`window.__v.pump().some((t) => t.meta.includes('已完成'))`);
const upSeen = JSON.parse(await evalJs('window.__v.seen()')).map((key) => ({ label: NAME, meta: key.split('|')[0], width: key.split('|')[1] ?? '' }));
await until(`document.querySelectorAll('.pk-vault__name').length >= 3`);
s = await snap();
const upIdx = s.names.indexOf(NAME);
const upPcts = upSeen.map(pctOf).filter((n) => n >= 0);
const upStages = [...new Set(upSeen.map(stageOf))];
check('B1 大文件已加密入库', upIdx >= 0, String(s.names));
check('B2 上传走过读取/加密/提交三段', ['读取中', '加密中', '提交中'].every((stage) => upStages.includes(stage)), upStages.join(' → '));
check(
  'B3 进度有中间百分位且单调不降',
  upPcts.some((n) => n > 0 && n < 100) && upPcts.every((n, i) => i === 0 || n >= upPcts[i - 1]),
  String([...new Set(upPcts)]),
);
check('B4 内层条宽度跟着百分位走', upSeen.every((row) => row.width === `${pctOf(row)}%`), JSON.stringify(upSeen.slice(-2)));
const upDetail = await evalJs(`(window.__v.pump().find((t) => t.label === ${JSON.stringify(NAME)}) || {}).detail || ''`);
check('B5 队列行写明容器构成 = 明文 + 29 字节开销', upDetail.includes('= 明文') && upDetail.includes(`+ 29 字节开销`), upDetail);
check(
  'B6 条目并列显示密文与明文体积',
  /^密文 [\d.]+ [KMGT]?B · 明文 [\d.]+ [KMGT]?B · \d{4}-\d{2}-\d{2}/.test(s.subs[upIdx] || ''),
  String(s.subs[upIdx]),
);
await shot('beker-02-uploaded.png');

// ---------------- C. 下载加密文件（.BEKER 容器） ----------------
await evalJs('window.__v.capture()');
await evalJs(`window.__v.watch(${JSON.stringify(BAKER)})`);
const clickCipher = await evalJs(`window.__v.clickItem('下载加密文件', ${upIdx})`);
await until('window.__dl.length >= 1');
const dl = JSON.parse(await evalJs('JSON.stringify(window.__dl)'));
const dlSeen = JSON.parse(await evalJs('window.__v.seen()')).map((key) => ({ label: BAKER, meta: key.split('|')[0], width: key.split('|')[1] ?? '' }));
check('C1 按钮是启用态且点到', clickCipher.startsWith('CLICKED'), clickCipher);
check('C2 落盘名为 原名.BEKER', dl[0] && dl[0].name === BAKER, JSON.stringify(dl[0]));
check('C3 落盘体积 = 明文 + 29 容器开销', dl[0] && dl[0].size === SIZE + 29, `${dl[0] && dl[0].size} vs ${SIZE + 29}`);
check('C4 密文下载不按原 MIME 落类型', dl[0] && dl[0].type === 'application/octet-stream', String(dl[0] && dl[0].type));
const fetchPcts = dlSeen.map(pctOf).filter((n) => n >= 0);
check('C5 取回进度走过多个中间百分位', fetchPcts.some((n) => n > 0 && n < 100) && new Set(fetchPcts).size >= 3, String([...new Set(fetchPcts)]));
check('C6 队列行显示「取回中」阶段', dlSeen.some((row) => row.meta.includes('取回中')), [...new Set(dlSeen.map(stageOf))].join(' → '));
check('C7 取回进度单调不降', fetchPcts.every((n, i) => i === 0 || n >= fetchPcts[i - 1]), String(fetchPcts.slice(0, 6)));
const reopened = await evalJs(`window.__v.reopen(0, ${JSON.stringify(DEMO_PASS)})`, true);
check('C8 容器版本字节为 1', reopened.version === 1, String(reopened.version));
check(
  'C9 .BEKER 能用同一内核解回原明文',
  reopened.plainLength === SIZE && reopened.at4096 === 80 && reopened.overhead === 29,
  JSON.stringify(reopened),
);
check('C10 后缀与开销常量同源', reopened.ext === 'BEKER' && reopened.cost === 29, `${reopened.ext}/${reopened.cost}`);
await shot('beker-03-cipher-downloaded.png');

// ---------------- D. 清除已结束 → 解密下载仍按原名落盘 ----------------
await evalJs(`window.__v.click('清除已结束')`);
await until(`window.__v.pump().length === 0`);
const clearedRows = Number(await evalJs('window.__v.pump().length'));
const cleared = clearedRows === 0;
await evalJs('window.__v.capture()');
await evalJs(`window.__v.watch(${JSON.stringify(NAME)})`);
const clickPlain = await evalJs(`window.__v.clickItem('解密下载', ${upIdx})`);
await until('window.__dl.length >= 1');
const dl2 = JSON.parse(await evalJs('JSON.stringify(window.__dl)'));
const plainSeen = JSON.parse(await evalJs('window.__v.seen()')).map((key) => ({ meta: key.split('|')[0] }));
const plainStages = [...new Set(plainSeen.map(stageOf))];
check('D1 清除已结束只留进行中', cleared, `rows=${clearedRows}`);
check('D2 解密下载按原名落盘、不被 .BEKER 取代', clickPlain.startsWith('CLICKED') && dl2[0] && dl2[0].name === NAME, `${clickPlain} / ${JSON.stringify(dl2[0])}`);
check('D3 解密后落盘体积回到明文大小', dl2[0] && dl2[0].size === SIZE, String(dl2[0] && dl2[0].size));
check('D4 解密任务走过取回与解密两段', plainStages.includes('取回中') && plainStages.includes('解密中'), plainStages.join(' → '));

// ---------------- E. 锁定态与只读视图 ----------------
await evalJs(`window.__v.click('锁定')`);
await until(`window.__v.snap().title.includes('解锁加密空间')`);
s = await snap();
check('E1 锁定后条目区与队列一起收走', s.names.length === 0 && s.tags.length === 0 && s.ops.length === 0, `names=${s.names.length} ops=${s.ops.length}`);

await goto(`${APP}/drive/encrypted?owner=3`);
await until(`window.__v.snap().title.includes('只读容量视图')`);
s = await snap();
check('E2 他人空间不渲染第三个按钮', s.opText.length > 0 && s.opText.every((row) => row.split('+').length === 2), String(s.opText));
check('E3 他人条目取不到密文、但可删', s.ops.length === s.names.length * 2 && s.ops.every((d, i) => (i % 2 === 0 ? d === 1 : d === 0)), String(s.ops));
check('E4 他人条目不标 .BEKER', s.tags.length === 0 && s.names.every((n) => n.includes('仅本人可解')), String(s.names));
await shot('beker-04-readonly.png');
await evalJs('window.__v.stopWatch()');

cleanup();
const failed = results.filter((r) => !r.ok);
await writeFile(
  OUT + 'beker-verify.log',
  results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  → ' + r.detail : ''}`).join('\n') + '\n',
);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
