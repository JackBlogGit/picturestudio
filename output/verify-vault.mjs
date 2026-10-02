// 加密空间（/drive/encrypted，PRD 5.7 / D26）逐身份端到端验收。
// 用 headless Edge + CDP 真点：初始化向导 → 加密上传 → 锁定 → 错口令 → 解锁 →
// 改口令（整空间重封）→ 旧口令失效 → 解密下载 → 黑名单 → 销毁空间 →
// 超管解锁预置密文 → ?owner= 看他人空间只读 → 成员空间总览 → 临时账号/游客/L2 越权闸门。
// 注意：整个 mock 的库存在模块内存里，整页刷新会连演示数据一起重置（全站既有行为），
// 所以「丢密钥后重新解锁」用页面自己的「锁定」按钮来测，不靠刷新。
// 跑之前确认 client 的 vite 在 5173 上活着（VITE_USE_MOCK=true）。
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const PROFILE = OUT + 'edge-profile-vault/';
const PORT = 9236;
const APP = 'http://127.0.0.1:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const consoleErrors = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
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
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
  }
  return res.result.value;
}

const HELPERS = `(() => {
  window.__v = {
    set(el, value) {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    inputs(scope) {
      return [...document.querySelectorAll(scope + ' input')];
    },
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
    mark() {
      window.__t0 = document.querySelectorAll('.el-message').length;
      return window.__t0;
    },
    toast() {
      // 只认这次动作之后新增的提示，否则上一条还没散场的 toast 会把断言糊过去
      return [...document.querySelectorAll('.el-message')].slice(window.__t0 ?? 0).map((n) => n.innerText.trim()).join(' | ');
    },
    snap() {
      const t = (sel) => (document.querySelector(sel) || {}).innerText || '';
      return {
        path: location.pathname + location.search,
        chip: (document.querySelector('.pk-vault__who .pk-chip') || {}).innerText || '',
        title: t('.pk-vault__title'),
        lede: t('.pk-vault__lede'),
        drop: t('.pk-vault__drop'),
        stats: t('.pk-vault__stats').replace(/\\s+/g, ' '),
        quota: t('.pk-vault__quota').replace(/\\s+/g, ' '),
        names: [...document.querySelectorAll('.pk-vault__name')].map((n) => n.innerText.trim()),
        ops: [...document.querySelectorAll('.pk-vault__actions button')].map((b) => (b.disabled ? 1 : 0)),
        forms: document.querySelectorAll('.pk-vault__form').length,
        boxErr: (document.querySelector('.el-message-box__errormsg') || {}).innerText || '',
        tips: [...document.querySelectorAll('.pk-vault__tip')].map((n) => n.innerText.trim()).join(' | '),
        subs: [...document.querySelectorAll('.pk-vault__sub')].map((n) => n.innerText.trim()),
        opDisabled: [...document.querySelectorAll('.pk-vault__ops button')].map((b) => (b.disabled ? 1 : 0)),
        tabs: [...document.querySelectorAll('.pk-vault-tab')].map((n) => n.innerText.trim()),
        spaceRows: document.querySelectorAll('.pk-vault__jobs .el-table__row').length,
        toast: window.__v.toast(),
      };
    },
  };
  window.__dl = [];
  const orig = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) {
      window.__dl.push({ name: this.download, urlBytes: this.href.length });
      return undefined;
    }
    return orig.call(this);
  };
})()`;

async function snap() {
  return JSON.parse(await evalJs('JSON.stringify(window.__v.snap())'));
}

async function goto(url, settle = 1200) {
  await call('Page.navigate', { url });
  await sleep(settle);
  await evalJs(HELPERS);
}

/** 等条件成立；只在失败时登记一条 FAIL，成功由调用方 check 记细节 */
async function until(expr, timeout = 15000) {
  const started = Date.now();
  for (;;) {
    const ok = await evalJs(`(() => { try { return Boolean(${expr}); } catch { return false; } })()`);
    if (ok) return true;
    if (Date.now() - started > timeout) return false;
    await sleep(200);
  }
}

async function shot(file) {
  const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(OUT + file, Buffer.from(data, 'base64'));
  console.log('     wrote ' + file);
}

async function setToken(token) {
  if (token) await evalJs(`localStorage.setItem('piks.accessToken', ${JSON.stringify(token)})`);
  else await evalJs('localStorage.removeItem("piks.accessToken")');
}

async function unlockWith(pass) {
  await evalJs(`window.__v.set(window.__v.inputs('.pk-vault__form')[0], ${JSON.stringify(pass)})`);
  await evalJs(`window.__v.click('解锁')`);
  return until(`window.__v.toast().includes('已解锁') || window.__v.toast().includes('口令不对')`);
}

const PASS1 = 'cp29-摊位B12-key';
const PASS2 = 'cp29-摊位B12-key-2';
const BODY = 'A'.repeat(40);

// ---------------- A. L1 小满（uid 4，空间未初始化） ----------------
await goto(`${APP}/login`);
await setToken('mock.user.4');
await goto(`${APP}/drive/encrypted`);

let s = await snap();
check('A1 L1 直达 /drive/encrypted 不被弹回', s.path === '/drive/encrypted', s.path);
check('A2 未初始化时显示向导', s.title.includes('初始化加密空间'), s.title);
check('A3 向导写明本地加密与不可恢复', s.lede.includes('AES-256-GCM') && s.lede.includes('忘记口令后无法找回'), s.lede.slice(0, 46));
await shot('vault-a1-wizard.png');

await evalJs(`window.__v.set(window.__v.inputs('.pk-vault__form')[0], 'abc')`);
await evalJs(`window.__v.click('生成密钥并初始化')`);
await until(`window.__v.toast().includes('至少 8 位')`);
s = await snap();
check('A4 短口令被拒', s.toast.includes('口令至少 8 位'), s.toast);

await evalJs(`(() => {
  const i = window.__v.inputs('.pk-vault__form');
  window.__v.set(i[0], ${JSON.stringify(PASS1)});
  window.__v.set(i[1], ${JSON.stringify(PASS1)});
  window.__v.set(i[2], '展会名+摊位号');
  const box = document.querySelector('.pk-vault__form .el-checkbox input');
  if (box && !box.checked) box.click();
  return true;
})()`);
await evalJs(`window.__v.click('生成密钥并初始化')`);
await until(`!!document.querySelector('.pk-vault__drop')`);
s = await snap();
check('A5 初始化后进入解锁态', s.chip.includes('已解锁') && s.title.includes('我的密文'), `${s.chip} / ${s.title}`);
check('A6 新空间条目为空', s.names.length === 0, `${s.names.length} 条`);
check('A7 解锁态下动作按钮全部可用', s.ops.length === 4 && s.ops.every((d) => d === 0), String(s.ops));

await evalJs(`(() => {
  window.__v.mark();
  const dt = new DataTransfer();
  dt.items.add(new File([${JSON.stringify(BODY)}], '摊位合同-原件.txt', { type: 'text/plain' }));
  const input = document.querySelector('.pk-vault__input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await until(`document.querySelectorAll('.pk-vault__name').length >= 1`);
s = await snap();
check('A8 上传后文件名本地解密可读', s.names[0] === '摊位合同-原件.txt', String(s.names));
check('A9 密文容器 = 明文 + 29 字节', s.subs[0].includes('密文 69 B') && s.subs[0].includes('明文 40 B'), s.subs[0]);
check('A10 密文体积计入配额', s.quota.includes('密文体积计入配额'), s.quota.slice(0, 60));
await shot('vault-a2-uploaded.png');

// 锁定 = 丢弃内存里的密钥：这是「密钥不落任何持久化存储」的可观测面
await evalJs(`window.__v.click('锁定')`);
await until(`window.__v.snap().title.includes('解锁加密空间')`);
s = await snap();
check('A11 锁定后回到解锁卡片', s.title.includes('解锁加密空间') && s.chip.includes('已锁定'), `${s.title} / ${s.chip}`);
check('A12 锁定后文件名不再可见', s.names.length === 0, String(s.names));
check('A13 提示语在锁定态就显示', s.lede.includes('展会名+摊位号'), s.lede.slice(0, 56));

check('A14 错口令被校验子拦下', (await unlockWith('错的口令-12345678')) && (await snap()).toast.includes('口令不对'), (await snap()).toast);
s = await snap();
check('A15 错口令后仍是锁定态', s.title.includes('解锁加密空间'), s.title);
await shot('vault-a3-wrong-pass.png');

check('A16 正确口令解锁', (await unlockWith(PASS1)) && (await snap()).toast.includes('已解锁'), (await snap()).toast);
s = await snap();
check('A17 解锁后条目重新解出名字', s.names[0] === '摊位合同-原件.txt', String(s.names));

await evalJs(`window.__v.click('修改口令')`);
await until(`!!document.querySelector('.el-dialog')`);
await evalJs(`(() => { const i = window.__v.inputs('.el-dialog'); window.__v.set(i[0], ${JSON.stringify(PASS2)}); window.__v.set(i[1], ${JSON.stringify(PASS2)}); return true; })()`);
await evalJs(`window.__v.click('开始重封并提交', '.el-dialog')`);
await until(`window.__v.toast().includes('口令已更换')`);
s = await snap();
check('A18 改口令整份重封回执', s.toast.includes('1 条密文已重新封装'), s.toast);
check('A19 重封后文件名仍解得开', s.names[0] === '摊位合同-原件.txt', String(s.names));
await shot('vault-a4-rekeyed.png');

await evalJs(`window.__v.click('锁定')`);
await until(`window.__v.snap().title.includes('解锁加密空间')`);
check('A20 旧口令在新参数下失效', (await unlockWith(PASS1)) && (await snap()).toast.includes('口令不对'), (await snap()).toast);
check('A21 新口令可解重封后的密文', (await unlockWith(PASS2)) && (await snap()).names[0] === '摊位合同-原件.txt', String((await snap()).names));

await evalJs(`window.__dl = []`);
await evalJs(`window.__v.click('解密下载', '.pk-vault__item')`);
await until(`window.__dl.length >= 1`);
const dl = JSON.parse(await evalJs('JSON.stringify(window.__dl)'));
check('A22 解密下载落盘名正确', dl[0]?.name === '摊位合同-原件.txt', JSON.stringify(dl));

await evalJs(`(() => {
  window.__v.mark();
  const dt = new DataTransfer();
  dt.items.add(new File(['MZ\\u0000\\u0000'], 'setup.exe', { type: 'application/octet-stream' }));
  const input = document.querySelector('.pk-vault__input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await until(`window.__v.toast().includes('禁止')`);
s = await snap();
check('A23 加密空间同样过 5.2 黑名单', s.toast.includes('禁止 .exe'), s.toast);
check('A24 被拒的条目没有入库', s.names.length === 1, `${s.names.length} 条`);

await evalJs(`window.__v.click('销毁全部密文')`);
await until(`!!document.querySelector('.el-message-box')`);
await evalJs(`window.__v.click('确认销毁', '.el-message-box')`);
const needType = await until(`window.__v.snap().boxErr.includes('请输入 销毁')`);
s = await snap();
check('A25 销毁要打字确认', needType && s.boxErr.includes('请输入 销毁'), s.boxErr);
await evalJs(`window.__v.set(document.querySelector('.el-message-box__input input'), '销毁')`);
await evalJs(`window.__v.click('确认销毁', '.el-message-box')`);
await until(`window.__v.snap().title.includes('初始化加密空间')`);
s = await snap();
check('A26 销毁后回到未初始化', s.title.includes('初始化加密空间'), s.title);
check('A27 销毁同时清掉内存里的密钥', s.chip.includes('已锁定'), s.chip);
await shot('vault-a5-destroyed.png');

// ---------------- B. L4 夜刃（uid 1）：自己的空间 + 他人只读 ----------------
await setToken('mock.user.1');
await goto(`${APP}/drive/encrypted`);
s = await snap();
check('B1 超管看到两个标签', s.tabs.length === 2 && s.tabs[1].includes('成员空间总览'), s.tabs.join(','));
check('B2 演示层预置口令提示只在 mock 出现', s.tips.includes('演示库预置口令'), s.tips.slice(0, 50));
check('B3 解锁前拿不到任何条目', s.names.length === 0, String(s.names));

await unlockWith('demo-vault');
await until(`document.querySelectorAll('.pk-vault__name').length >= 2`);
s = await snap();
check('B4 预置密文可被演示口令解开', s.names.some((n) => n.includes('摊位合同-CP29')), String(s.names));
check('B5 预置密文条数与状态一致', s.stats.includes('条目 2'), s.stats);
await shot('vault-b1-l4-own.png');

await goto(`${APP}/drive/encrypted?owner=3`);
await until(`window.__v.snap().title.includes('只读容量视图')`);
s = await snap();
check('B6 ?owner= 进入他人空间只读视图', s.title.includes('只读容量视图'), s.title);
check('B7 他人条目的文件名不下发', s.names.length === 2 && s.names.every((n) => n.includes('仅本人可解')), String(s.names));
check('B8 他人条目取不到密文、但可删', s.opDisabled.length === s.names.length * 2 && s.opDisabled.every((d, i) => (i % 2 === 0 ? d === 1 : d === 0)), String(s.opDisabled));
check('B9 只读视图写明不下发原因', s.lede.includes('不下发'), s.lede.slice(0, 40));
check('B10 只读视图不给口令框与上传区', s.forms === 0 && s.drop === '', `forms=${s.forms} drop=${JSON.stringify(s.drop)}`);
await shot('vault-b2-l4-other-readonly.png');

await goto(`${APP}/drive/encrypted`);
await evalJs(`window.__v.click('成员空间总览')`);
await until(`window.__v.snap().spaceRows >= 4`);
s = await snap();
check('B11 成员空间总览成表', s.spaceRows === 4, String(s.spaceRows));
await shot('vault-b3-l4-spaces.png');

// ---------------- C. 闸门与越权 ----------------
await setToken('mock.temp.301');
await goto(`${APP}/drive/encrypted`);
s = await snap();
check('C1 临时账号被弹回工作台', s.path === '/home', s.path);
check('C2 弹回有提示', s.toast.includes('仅对正式成员开放'), s.toast);

await setToken(null);
await goto(`${APP}/drive/encrypted`);
s = await snap();
check('C3 游客被送去登录', s.path.startsWith('/login'), s.path);

await setToken('mock.user.3');
await goto(`${APP}/drive/encrypted?owner=1`);
s = await snap();
check('C4 非超管的 owner 参数被忽略', !s.title.includes('只读容量视图'), s.title);
check('C5 没有漏出别人的条目', s.names.length === 0 && s.title.includes('解锁加密空间'), `${s.names.length} 条 / ${s.title}`);

await goto(`${APP}/home`);
const cell = await evalJs(`(() => {
  const cells = [...document.querySelectorAll('.pk-work__cell')];
  const target = cells.find((c) => (c.querySelector('.pk-work__name') || {}).innerText === '加密文件');
  if (!target) return 'MISSING';
  target.click();
  return 'CLICKED';
})()`);
await sleep(900);
s = await snap();
check('C6 宫格「加密文件」直接导航到真页面', cell === 'CLICKED' && s.path === '/drive/encrypted', `${cell} / ${s.path}`);
check('C7 宫格进去不再是「尚未实现」提示', !s.toast.includes('尚未实现'), s.toast);

// ---------------- 收尾 ----------------
console.log('');
const failed = results.filter((r) => !r.ok);
console.log(`合计 ${results.length} 项，失败 ${failed.length} 项`);
if (consoleErrors.length) {
  console.log('未捕获的前端异常：');
  for (const e of consoleErrors.slice(0, 6)) console.log('  ' + String(e).split('\n')[0]);
}
await writeFile(OUT + 'vault-verify.log', results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}\t${r.name}\t${r.detail ?? ''}`).join('\n'));

ws.close();
cleanup();
await sleep(400);
process.exit(failed.length ? 1 : 0);
