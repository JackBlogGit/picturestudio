/**
 * D35 验收：临时限时账号的登录密码支持「随机生成」（PRD 6.2 / D35）。
 * 分两段——
 *  A. 内核（直接在 Node 里跑 utils/random-password.ts）：长度、字母表、三类字符齐备、剔除易混字符、洗牌过；
 *  B. 页面（headless Edge + CDP，全程不刷新，换页走 router.push，mock 数据活在页面内存）：
 *     字段序号契约未破 → 点「随机生成」两框同值 → 手工改一格立刻「两次输入不一致」→
 *     创立成功 → 「复制帐号信息」里带着那一串随机口令 →
 *     端到端凭据：同一账号拿 demo1234 登不进去、拿随机口令登得进去。
 * 用法：node output/verify-random-password.mjs       （BASE= 可覆盖，默认 5173）
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const PROFILE = OUT + 'edge-profile-randpw/';
const PORT = Number(process.env.CDP_PORT ?? 9249);
const APP = process.env.BASE ?? 'http://127.0.0.1:5173';
const NAME = '验收·随机口令';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass });
  console.log((pass ? '  OK  ' : '  FAIL ') + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail)));
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const AMBIGUOUS = /[0O1Il]/g;

/* ------------------------------------------------------------------ A. 内核 */
console.log(`=== A. 随机口令内核（Node 直接 import utils/random-password.ts）===\n`);
const mod = await import('../client/src/utils/random-password.ts');
const LEN = mod.TEMP_PASSWORD_LENGTH;
check('导出长度常量 = 12', LEN === 12, LEN);

const samples = [];
for (let i = 0; i < 2000; i += 1) samples.push(mod.generateTempPassword());
const badLen = samples.filter((s) => s.length !== LEN).length;
const badChar = [...new Set(samples.join('').split(''))].filter((c) => !ALPHABET.includes(c));
const hasAmbiguous = samples.filter((s) => AMBIGUOUS.test(s)).length;
const missingClass = samples.filter(
  (s) => !/[A-Z]/.test(s) || !/[a-z]/.test(s) || !/[0-9]/.test(s),
).length;
const leadingUpper = samples.filter((s) => /[A-Z]/.test(s[0])).length;
const leadingDigit = samples.filter((s) => /[0-9]/.test(s[0])).length;
check('2000 条长度全为 12', badLen === 0, badLen);
check('只出现约定字母表里的字符', badChar.length === 0, badChar);
check('剔除易混字符 0 O 1 I l（与帐户ID 同一把尺子）', hasAmbiguous === 0, hasAmbiguous);
check('每条都至少含一枚大写、一枚小写、一枚数字', missingClass === 0, missingClass);
check(
  '锁定的三类字符被打散到各位置（首位不是恒为大写）',
  leadingUpper > 500 && leadingUpper < 1500 && leadingDigit > 0,
  { leadingUpper, leadingDigit },
);
check('两条连抽相同几乎不可能（2000 条去重后 ≥1990）', new Set(samples).size >= 1990, new Set(samples).size);
const bespoke = mod.generateTempPassword(6);
check('可指定长度（6 位仍三类齐备）', bespoke.length === 6 && /[A-Z]/.test(bespoke) && /[a-z]/.test(bespoke) && /[0-9]/.test(bespoke), bespoke);

/* ----------------------------------------------------------------- B. 页面 */
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
await call('Runtime.enable');
await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

async function evalJs(expression) {
  const res = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
  }
  return res.result.value;
}

async function probe(expression) {
  const raw = await evalJs(expression);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function goto(token, path) {
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('piks.accessToken', ${JSON.stringify(token)});`,
  });
  await call('Page.navigate', { url: APP + path });
  await sleep(2200);
}

async function nav(path) {
  await evalJs(`(async () => {
    const router = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$router;
    if (router) await router.push(${JSON.stringify(path)});
  })()`);
  await sleep(1200);
}

/** v-model 吃 input 事件 */
async function type(fieldIndex, value) {
  return evalJs(`(() => {
    const field = document.querySelectorAll('.pk-reg__field')[${fieldIndex}];
    const input = field?.querySelector('input') ?? field?.querySelector('textarea');
    if (!input) return 'missing';
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
}

async function shot(file) {
  const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(OUT + file, Buffer.from(data, 'base64'));
  console.log('  wrote', file);
}

/** 注册页三格读数：密码（序号 2）/ 确认（序号 3）/ 按钮 / 闸门 / 不一致提示 */
const READ = `(JSON.stringify({
  labels: [...document.querySelectorAll('.pk-reg__field > label')].map((l) => l.innerText.trim()),
  pwInRow: !!document.querySelectorAll('.pk-reg__field')[2]?.querySelector('.pk-reg__row'),
  pwType: document.querySelectorAll('.pk-reg__field')[2]?.querySelector('input')?.type ?? null,
  hasEye: !!document.querySelectorAll('.pk-reg__field')[2]?.querySelector('.el-input__suffix'),
  rollBtn: [...(document.querySelectorAll('.pk-reg__field')[2]?.querySelectorAll('button') ?? [])]
    .map((b) => b.innerText.trim()).filter((t) => t && !t.includes('显示')),
  pw: document.querySelectorAll('.pk-reg__field')[2]?.querySelector('input')?.value ?? '',
  confirm: document.querySelectorAll('.pk-reg__field')[3]?.querySelector('input')?.value ?? '',
  errText: document.querySelectorAll('.pk-reg__field')[3]?.querySelector('.pk-reg__err')?.innerText ?? '',
  createDisabled: !!document.querySelector('.pk-reg__actions button.el-button--primary')?.disabled,
  code: document.querySelectorAll('.pk-reg__field')[0]?.querySelector('input')?.value ?? '',
  daysHint: document.querySelector('.pk-reg__row--days .pk-muted')?.innerText ?? '',
  toasts: [...document.querySelectorAll('.el-message')].map((t) => t.innerText.trim()).join(' | '),
}))`;

function rollPassword() {
  return evalJs(`(() => {
    const field = document.querySelectorAll('.pk-reg__field')[2];
    const btn = [...(field?.querySelectorAll('button') ?? [])].find((b) => b.innerText.includes('随机生成'));
    if (!btn) return 'no-button';
    btn.click();
    return 'clicked';
  })()`);
}

console.log(`\n=== B. 注册页 /guest/new @ ${APP} ===\n`);

await goto('mock.user.3', '/guest/new');

// 1) 位置与既有契约
const r0 = await probe(READ);
check('字段序号未破：0=帐户ID、1=名称、2=登录密码、3=再次确认', r0.labels[0]?.startsWith('帐户ID') && r0.labels[1] === '名称（必填）' && r0.labels[2] === '登录密码（必填）' && r0.labels[3] === '再次确认（必填）', r0.labels);
check('「随机生成」按钮挂在登录密码那一格', r0.rollBtn.includes('随机生成'), r0.rollBtn);
check('登录密码与按钮同处 .pk-reg__row（沿用帐户ID 那一行的骨架）', r0.pwInRow === true);
check('随机口令不摊在页面上：输入框仍是 type=password', r0.pwType === 'password', r0.pwType);
check('仍然带 show-password 的眼睛（创建者要看清自己复制走了什么）', r0.hasEye === true);
check('两格初始为空', r0.pw === '' && r0.confirm === '');

// 2) 点一次随机生成
check('点击有响应', (await rollPassword()) === 'clicked');
await sleep(400);
const r1 = await probe(READ);
check('随机后两框同值（确认框一起填满）', r1.pw !== '' && r1.pw === r1.confirm, { pw: r1.pw, confirm: r1.confirm });
check(`随机串长度 = ${LEN}`, r1.pw.length === LEN, r1.pw.length);
check('随机串只含约定字母表字符、且无 0O1Il', new RegExp(`^[${ALPHABET}]{${LEN}}$`).test(r1.pw), r1.pw);
check('随机串含大写+小写+数字', /[A-Z]/.test(r1.pw) && /[a-z]/.test(r1.pw) && /[0-9]/.test(r1.pw));
check('成功提示写明怎么交给对方', r1.toasts.includes('复制帐号信息'), r1.toasts);
check('随机后「创立」仍被名称闸门挡住（名称还没填）', r1.createDisabled === true);

// 3) 再点一次要换一串
await rollPassword();
await sleep(400);
const r2 = await probe(READ);
check('连点两次不是同一个串', r2.pw !== r1.pw, { first: r1.pw, second: r2.pw });
check('换串后两框仍同值', r2.pw === r2.confirm);

// 4) 手工只改第一格 → 不一致立刻现身（随机串没把防手滑的口径改掉）
await type(2, 'typedOther123');
await sleep(300);
const r3 = await probe(READ);
check('手改密码而确认未改 → 提示「两次输入不一致」', r3.errText.includes('两次输入不一致') && r3.confirm === r2.pw, { err: r3.errText });
check('不一致时「创立」禁用', r3.createDisabled === true);
await rollPassword();
await sleep(400);
const r4 = await probe(READ);
check('再点「随机生成」把不一致修掉', r4.errText === '' && r4.pw === r4.confirm && r4.pw.length === LEN, { pw: r4.pw, err: r4.errText });
await shot('d35-01-register-random.png');

// 5) 填名称 → 创立
await type(1, NAME);
await sleep(300);
const ready = await probe(READ);
check('名称填好且口令由随机给出 → 「创立」可用', ready.createDisabled === false);
const randomPw = ready.pw;
const accountCode = ready.code;
await evalJs(`document.querySelector('.pk-reg__actions button.el-button--primary').click()`);
await sleep(1600);
const done = await probe(`(JSON.stringify({
  strong: document.querySelector('.pk-reg__done strong')?.innerText ?? '',
  toasts: [...document.querySelectorAll('.el-message')].map((t) => t.innerText.trim()).join(' | '),
}))`);
check('用随机口令创立成功', done.strong === `${NAME} · ${accountCode}`, { strong: done.strong, code: accountCode });
check('回执里没有把口令打出来', !done.toasts.includes(randomPw), done.toasts.slice(0, 120));
await shot('d35-02-created.png');

// 6) 复制帐号信息带的是那一串随机口令（劫持剪贴板取文本）
await evalJs(`(() => {
  window.__clip = null;
  Object.defineProperty(navigator.clipboard, 'writeText', {
    value: (t) => { window.__clip = t; return Promise.resolve(); },
    configurable: true,
  });
  document.querySelectorAll('.pk-reg__actions button')[0].click();
  return true;
})()`);
await sleep(600);
const clip = await evalJs(`window.__clip ?? ''`);
check('复制文本含「登录密码：<随机串>」', clip.includes(`登录密码：${randomPw}`), clip.split('\n').slice(0, 4));
check('复制文本同时含帐户ID，一次拷走', clip.includes(accountCode));

// 7) 端到端凭据：先证明默认演示口令登不进去，再证明随机口令登得进去
await nav('/login');
await evalJs(`(() => {
  [...document.querySelectorAll('.el-tabs__item')].find((t) => t.innerText.includes('游客'))?.click();
  return true;
})()`);
await sleep(500);

async function tryLogin(password) {
  await evalJs(`(() => {
    const inputs = [...document.querySelectorAll('.el-tab-pane')].flatMap((p) => [...p.querySelectorAll('input')])
      .filter((i) => i.type !== 'checkbox' && i.offsetParent !== null);
    const code = inputs.find((i) => i.placeholder === 'PK-2026-0913');
    code.value = ${JSON.stringify(accountCode)};
    code.dispatchEvent(new Event('input', { bubbles: true }));
    const pw = inputs.find((i) => i.type === 'password');
    pw.value = ${JSON.stringify(password)};
    pw.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.el-tab-pane button')].find((b) => b.innerText.includes('进入') && b.offsetParent !== null)?.click();
    return true;
  })()`);
  await sleep(1500);
  return probe(`(JSON.stringify({
    path: location.pathname,
    toasts: [...document.querySelectorAll('.el-message')].map((t) => t.innerText.trim()).join(' | '),
  }))`);
}

const wrong = await tryLogin('demo1234');
check('拿默认演示口令 demo1234 登不进去（随机串真的覆盖了它）', wrong.path === '/login' && /密码|口令|错误|不正确/.test(wrong.toasts), wrong);
const right = await tryLogin(randomPw);
check('拿随机口令登得进去，落到 /home', right.path === '/home', right);
await nav('/me');
const me = await probe(`(JSON.stringify({ title: document.querySelector('.pk-me__id h2, .pk-page-title')?.innerText ?? '' }))`);
check('登录后 /me 显示的是这个账号', me.title.includes(NAME), me.title);
await shot('d35-03-me-as-random-temp.png');

// 8) 回归：L1 同一把尺子（按钮在、D9 的 7 天上限提示未被挤坏）
await goto('mock.user.4', '/guest/new');
const l1 = await probe(READ);
check('L1 注册页同样有「随机生成」', l1.rollBtn.includes('随机生成'), l1.rollBtn);
check('L1 的 D9 时长上限提示未被打乱', l1.daysHint.includes('最多 7 天'), l1.daysHint);
await rollPassword();
await sleep(400);
const l1r = await probe(READ);
check('L1 点一次也得到 12 位、两框同值', l1r.pw.length === LEN && l1r.pw === l1r.confirm, l1r.pw);

const failed = results.filter((r) => !r.pass);
console.log(`\n==== 合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length} ====`);
for (const f of failed) console.log('  未过：' + f.name);
console.log(failed.length ? 'RESULT=FAIL' : 'RESULT=CLEAN');
cleanup();
process.exit(failed.length ? 1 : 0);
