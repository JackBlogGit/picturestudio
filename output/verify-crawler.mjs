/**
 * D28「爬虫（站外来源登记）接入前端」的端到端验证。纯 mock，数据活在页面内存里，
 * 所以全程不刷新：身份走顶栏「演示身份」，换页走 router.push，接口直连用 window.__api。
 *
 * 覆盖：L4 进得来 / 检索与丢弃计数 / 结果一键登记 / 409 重复回显 / 手敲三条闸门（内网、非法协议、
 * 跟踪参数规范化）/ 改状态盖章 / 删除 → 接口层的筛选与审计 → L3 与临时账号、游客三档越权 →
 * 菜单与宫格按等级出现。
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { makeReauth } from './lib-reauth.mjs';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const PROFILE = OUT + 'edge-profile-crawler/';
const PORT = 9241;
const APP = 'http://127.0.0.1:5173';
const KEYWORD = '雷电将军';
const TWITTER = 'https://twitter.com/i/web/status/1800123456789012345';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass });
  console.log((pass ? '  OK  ' : '  FAIL ') + name + (detail === undefined ? '' : ' — ' + detail));
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
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
  return res.result.value;
}

/** D34：这一页的登记／改状态／删除现在都会先要一次登录口令 */
const reauth = makeReauth({ evalJs, sleep });

async function probe(expression) {
  const raw = await evalJs(expression);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function goto(token, path) {
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('piks.accessToken', ${JSON.stringify(token)});`,
  });
  await call('Page.navigate', { url: APP + path });
  await sleep(2400);
}

async function click(selector, text, { root } = {}) {
  const done = await evalJs(`(() => {
    let scope = ${root ? `document.querySelector(${JSON.stringify(root)})` : 'document'};
    if (!scope) return 'missing root:' + ${JSON.stringify(root ?? '')};
    let els = [...scope.querySelectorAll(${JSON.stringify(selector)})];
    if (${JSON.stringify(text ?? '')}) els = els.filter((e) => e.innerText.trim().includes(${JSON.stringify(text ?? '')}));
    if (!els.length) return 'missing:' + ${JSON.stringify(selector)};
    els[0].click();
    return 'clicked';
  })()`);
  await sleep(text === '演示身份' ? 700 : 900);
  return done;
}

async function nav(path) {
  const how = await evalJs(`(async () => {
    const router = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$router;
    if (router) {
      await router.push(${JSON.stringify(path)});
      return 'router:' + router.currentRoute.value.fullPath;
    }
    history.pushState({}, '', ${JSON.stringify(path)});
    window.dispatchEvent(new PopStateEvent('popstate'));
    return 'pushState:' + location.pathname;
  })()`);
  await sleep(1300);
  return how;
}

async function identity(label) {
  await click('.pk-header__user button', '演示身份');
  await click('.el-dropdown-menu__item', label);
  await sleep(900);
  return (await probe(WHO)).who;
}

async function shot(file) {
  const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(OUT + file, Buffer.from(data, 'base64'));
  console.log('  wrote', file);
}

/** 往 el-input 里写值并触发 v-model：class 挂在包裹层上，真正的字段在里面 */
async function fill(selector, value, { root } = {}) {
  const got = await evalJs(`(() => {
    const scope = ${root ? `document.querySelector(${JSON.stringify(root)})` : 'document'};
    if (!scope) return 'missing root:' + ${JSON.stringify(root ?? '')};
    const field = scope.querySelector(${JSON.stringify(`${selector} input, ${selector} textarea`)}) ?? scope.querySelector(${JSON.stringify(selector)});
    if (!field) return 'missing:' + ${JSON.stringify(selector)};
    field.value = ${JSON.stringify(value)};
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return field.tagName + '=' + field.value;
  })()`);
  await sleep(260);
  return got;
}

/** 页面上有好几个 el-select：只开指定容器里的那一个，再点当前可见的同名项 */
async function pickOption(text, root) {
  const opened = await evalJs(`(() => {
    const scope = document.querySelector(${JSON.stringify(root)});
    if (!scope) return 'missing root';
    const trigger = scope.querySelector('.el-select__wrapper') ?? scope.querySelector('.el-select');
    if (!trigger) return 'missing select';
    trigger.click();
    return 'opened';
  })()`);
  await sleep(700);
  const picked = await evalJs(`(() => {
    const item = [...document.querySelectorAll('.el-select-dropdown__item')].find((el) => {
      const popper = el.closest('.el-popper');
      const shown = popper ? getComputedStyle(popper).display !== 'none' : true;
      return shown && el.innerText.trim() === ${JSON.stringify(text)};
    });
    if (!item) return 'missing item:' + ${JSON.stringify(text)};
    item.click();
    return 'picked';
  })()`);
  await sleep(700);
  return `${opened}/${picked}`;
}

const WHO = `(() => JSON.stringify({
  who: document.querySelector('.pk-identity')?.innerText.trim().replace(/\\s+/g, ' ') ?? null,
  path: location.pathname + location.search,
  toasts: (window.__toasts ?? []).length,
}))()`;

const PAGE = `(() => JSON.stringify({
  title: document.querySelector('.pk-page-title')?.innerText.trim() ?? null,
  menus: [...document.querySelectorAll('.pk-admin__menu a')].map((a) => a.innerText.trim()),
  stats: [...document.querySelectorAll('.pk-stat__value')].map((s) => s.innerText.trim()),
  hitRows: [...document.querySelectorAll('.pk-crawler__hits .el-table__row')].map((r) => ({
    title: r.querySelector('.el-link__inner')?.innerText.trim().slice(0, 30) ?? '',
    platform: r.querySelector('.pk-chip')?.innerText.trim() ?? '',
    action: r.lastElementChild?.innerText.replace(/\\s+/g, ' ').trim() ?? '',
  })),
  linkRows: [...document.querySelectorAll('.pk-crawler__links .el-table__row')].map((r) => {
    const cells = [...r.querySelectorAll('td')].map((td) => td.innerText.replace(/\\s+/g, ' ').trim());
    return { id: cells[0], source: cells[4], status: cells[5], keyword: cells[3], note: cells[6] };
  }),
  alert: document.querySelector('.pk-crawler__alert')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
  searchNote: document.querySelector('.pk-crawler__kw')?.closest('.pk-admin__inline')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
  probed: document.querySelector('.pk-crawler__probed')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
}))()`;

const GRID = `(() => JSON.stringify({
  cells: [...document.querySelectorAll('.pk-work__cell, .pk-cell, .pk-grid button, .pk-grid a')].map((c) => c.innerText.replace(/\\s+/g, ' ').trim()),
}))()`;

let lastToastMark = 0;
async function toastsSince(mark) {
  const all = JSON.parse(await evalJs('JSON.stringify(window.__toasts ?? [])'));
  lastToastMark = all.length;
  return all.slice(mark);
}

async function apiProbe(body) {
  return probe(`(async () => {
    const api = window.__api;
    if (!api) return JSON.stringify({ err: 'no __api' });
    const out = {};
    ${body}
    return JSON.stringify(out);
  })()`);
}

// ============ 0) L4 进页面，登记表种子可见 ============
await goto('mock.user.1', '/admin/crawler');
await evalJs(`(() => {
  window.__toasts = [];
  const seen = new WeakSet();
  const pick = () => {
    for (const el of document.querySelectorAll('.el-message')) {
      if (seen.has(el)) continue;
      seen.add(el);
      window.__toasts.push(el.innerText.trim().replace(/\\s+/g, ' '));
    }
  };
  new MutationObserver(pick).observe(document.body, { childList: true, subtree: true });
  pick();
})()`);
await evalJs(`(async () => { const m = await import('/src/api/client.ts'); window.__api = m.api; })()`);

const boot = await probe(PAGE);
console.log('[身份]', boot.who, ' 标题', boot.title, ' 菜单', boot.menus.join('/'));
check('L4 直接进得来 /admin/crawler', boot.title === '站外来源登记', boot.title);
check('后台菜单出现「站外来源」', boot.menus.includes('站外来源'), boot.menus.join('|'));
check('登记表种子 5 行', boot.linkRows.length === 5, JSON.stringify(boot.linkRows.map((r) => r.id)));
check('状态列回显中文标签', boot.linkRows.some((r) => r.status === '已取得授权') && boot.linkRows.some((r) => r.status === '待确认'), JSON.stringify(boot.linkRows.map((r) => r.status)));
await shot('crawler-01-l4-page.png');

// ============ 1) 检索：命中 + 闸门丢弃 + 已登记标注 ============
console.log('[填检索词]', await fill('.pk-crawler__kw', KEYWORD));
await click('.pk-admin__inline button', '检索');
const afterSearch = await probe(PAGE);
const registeredCount = afterSearch.hitRows.filter((r) => r.action.includes('已登记')).length;
console.log('[检索回执]', afterSearch.searchNote);
check('检索结果 8 条（池子里 10 条去掉 2 条非法）', afterSearch.hitRows.length === 8, 'rows=' + afterSearch.hitRows.length);
check('fetched=10 / dropped=2 如实回显', /采集 10 条，闸门丢弃 2 条，命中 8 条/.test(afterSearch.searchNote ?? ''), afterSearch.searchNote);
check('丢弃说明的告警条出现', (afterSearch.alert ?? '').includes('服务器不会访问'), afterSearch.alert);
check('八条命中里有 5 条已在登记表里', registeredCount === 5, 'registered=' + registeredCount);
check('未登记的命中项给「登记」按钮', afterSearch.hitRows.some((r) => r.action === '登记'), afterSearch.hitRows.map((r) => r.action).join('|'));
await shot('crawler-02-search-hits.png');

// ============ 2) 一键登记检索结果 ============
const mark2 = (await probe(WHO)).toasts;
const reg = await evalJs(`(() => {
  const row = [...document.querySelectorAll('.pk-crawler__hits .el-table__row')].find((r) => r.innerText.includes('twitter'));
  const btn = [...(row?.querySelectorAll('button') ?? [])].find((b) => b.innerText.trim() === '登记');
  if (!btn) return 'missing';
  btn.click();
  return 'clicked';
})()`);
await sleep(500);
const gate2 = await reauth.pass();
await sleep(1200);
const toast2 = await toastsSince(mark2);
const afterReg = await probe(PAGE);
console.log('[一键登记]', reg, '口令', gate2, '回执', toast2.join(' | '));
check('登记回执出现', toast2.some((t) => t.includes('已登记，状态从「待确认」开始')), toast2.join(' | '));
check('登记表多出一行', afterReg.linkRows.length === 6, 'rows=' + afterReg.linkRows.length);
check('新行状态为待确认、来源为检索', afterReg.linkRows[0]?.status === '待确认' && afterReg.linkRows[0]?.source === '检索', JSON.stringify(afterReg.linkRows[0]));
check('结果行原地变成「已登记 #id」', (await probe(PAGE)).hitRows.some((r) => r.action.includes('已登记') && r.title.toLowerCase().includes('photo')), 'n/a');

// ============ 3) 重复登记：409 带回已存在的 id 与状态 ============
await fill('.pk-crawler__url', TWITTER, { root: '.pk-admin__card:nth-of-type(2)' });
const mark3 = lastToastMark;
await click('.pk-crawler__form button', '登记');
const gate3 = await reauth.pass();
check('手动登记也要先过口令弹窗（按「确认提交」才放行）', gate3 === '确认提交', gate3);
const toast3 = await toastsSince(mark3);
console.log('[重复登记回执]', toast3.join(' | '));
check('重复登记被 409 挡下并回显 #id', toast3.some((t) => t.includes('该链接已登记：#')), toast3.join(' | '));

// ============ 4) 三条 URL 闸门在 UI 上的表现 ============
const gate = [];
for (const [url, expect] of [
  ['http://127.0.0.1:8080/admin', '内网或保留网段'],
  ['ftp://files.example.com/a.zip', '只支持 http / https'],
  ['http://example.com:8080/gallery', '只允许默认的 80 / 443 端口'],
]) {
  await fill('.pk-crawler__url', url, { root: '.pk-admin__card:nth-of-type(2)' });
  const mark = lastToastMark;
  await click('.pk-admin__inline button', '读取标题');
  const t = await toastsSince(mark);
  gate.push({ url, toast: t.join(' | ') });
  check(`闸门拦住 ${url}`, t.some((x) => x.includes(expect)), t.join(' | '));
}
console.log('[闸门]', JSON.stringify(gate));

// 规范化：跟踪参数与 fragment 摘掉后不该产生第二条登记
await fill('.pk-crawler__url', 'https://weibo.com/ttarticle/p/show?id=2309405012345678901234&utm_term=x&scene=9#repost', {
  root: '.pk-admin__card:nth-of-type(2)',
});
await click('.pk-admin__inline button', '读取标题');
const normalized = await probe(PAGE);
console.log('[规范化回显]', normalized.probed);
check('读取标题后地址被规范化（去掉跟踪参数与锚点）', (normalized.probed ?? '').includes('https://weibo.com/ttarticle/p/show?id=2309405012345678901234 ·'), normalized.probed);
check('规范化后认出「这条已在登记表里」', (normalized.probed ?? '').includes('这条已在登记表里'), normalized.probed);
await shot('crawler-03-probe-normalized.png');

// ============ 5) 改状态：盖章审计人 + 备注 ============
const openSt = await evalJs(`(() => {
  const row = [...document.querySelectorAll('.pk-crawler__links .el-table__row')].find((r) => r.innerText.includes('twitter'));
  const btn = [...(row?.querySelectorAll('button') ?? [])].find((b) => b.innerText.includes('改状态'));
  if (!btn) return 'missing';
  btn.click();
  return 'clicked';
})()`);
await sleep(700);
console.log('[打开改状态]', openSt, await pickOption('已取得授权', '.el-dialog'));
await fill('textarea', '已私信原作者，同意补出处', { root: '.el-dialog' });
const mark5 = lastToastMark;
await click('.el-dialog__footer button', '保存');
await reauth.pass();
const toast5 = await toastsSince(mark5);
const afterStatus = await probe(PAGE);
const changed = afterStatus.linkRows.find((r) => r.source === '检索');
console.log('[保存状态]', toast5.join(' | '));
check('改状态回执出现', toast5.some((t) => t.includes('状态已更新')), toast5.join(' | '));
check('表上该行状态变成「已取得授权」', changed?.status === '已取得授权', JSON.stringify(changed));
await shot('crawler-04-status-saved.png');

// ============ 6) 接口层：筛选、分页、审计落表 ============
const kernel = await apiProbe(`
  const p0 = await api.get('/admin/crawler/links', { query: { status: 0 } });
  out.pending = p0.list.map((r) => r.status);
  const p1 = await api.get('/admin/crawler/links', { query: { platform: 'weibo' } });
  out.weibo = p1.list.map((r) => r.domain);
  const p2 = await api.get('/admin/crawler/links', { query: { q: 'pixiv' } });
  out.q = p2.list.map((r) => r.domain);
  const p3 = await api.get('/admin/crawler/links', { query: { page: 1, pageSize: 2 } });
  out.paging = { total: p3.total, size: p3.pageSize, count: p3.list.length };
  try { await api.post('/admin/crawler/links', { url: 'http://100.64.1.1/x' }, { reauth: 'demo1234' }); out.cg = 'not blocked'; } catch (e) { out.cg = e.status + ' ' + e.code; }
  try { await api.post('/admin/crawler/links', { url: 'https://ok.example.com/a' }); out.norelay = 'passed'; } catch (e) { out.norelay = e.status + ' ' + e.code; }
  try { await api.post('/admin/crawler/links', { url: 'https://ok.example.com/a' }, { reauth: 'wrong-pass' }); out.badpass = 'passed'; } catch (e) { out.badpass = e.status + ' ' + e.code; }
  try { await api.post('/admin/crawler/search', { keyword: 'a' }); out.kw = 'passed'; } catch (e) { out.kw = e.status + ' ' + e.code + ' ' + e.message; }
  try { await api.post('/admin/crawler/search', { keyword: ${JSON.stringify(KEYWORD)}, limit: 99 }); out.lim = 'passed'; } catch (e) { out.lim = e.status + ' ' + e.code; }
  const logs = await api.get('/admin/logs', { query: { action: 'crawler_searched', page: 1, pageSize: 5 } });
  out.logHit = { total: logs.total, first: logs.list[0] ? [logs.list[0].targetType, logs.list[0].detail] : null };
  const all = await api.get('/admin/logs', { query: { page: 1, pageSize: 100 } });
  out.actions = [...new Set(all.list.map((l) => l.action).filter((a) => a.startsWith('crawler')))];
`);
console.log('[内核]', JSON.stringify(kernel));
check('status=0 只剩待确认', kernel.pending.every((s) => s === 0) && kernel.pending.length >= 1, JSON.stringify(kernel.pending));
check('platform=weibo 只剩微博域', kernel.weibo.length >= 1 && kernel.weibo.every((d) => d === 'weibo.com'), JSON.stringify(kernel.weibo));
check('q 模糊命中域名', kernel.q.includes('pixiv.net'), JSON.stringify(kernel.q));
check('分页回 {page,pageSize,total}', kernel.paging.total >= 6 && kernel.paging.size === 2 && kernel.paging.count === 2, JSON.stringify(kernel.paging));
check('CGNAT 段 100.64.x.x 在创建时也被拦', String(kernel.cg).startsWith('400 INTERNAL_URL_FORBIDDEN'), kernel.cg);
check('内核层：不带口令的登记退回 401 REAUTH_REQUIRED', String(kernel.norelay).startsWith('401 REAUTH_REQUIRED'), kernel.norelay);
check('内核层：口令不对的登记退回 401 REAUTH_FAILED', String(kernel.badpass).startsWith('401 REAUTH_FAILED'), kernel.badpass);
check('检索词过短退回 KEYWORD_TOO_SHORT', String(kernel.kw).startsWith('400 KEYWORD_TOO_SHORT'), kernel.kw);
check('limit 越界退回 400', String(kernel.lim).startsWith('400'), kernel.lim);
check('审计里落了 crawler_searched 且 targetType=crawler', kernel.logHit.total >= 1 && kernel.logHit.first?.[0] === 'crawler', JSON.stringify(kernel.logHit));
check('五个动作全部落表', ['crawler_searched', 'crawler_probed', 'crawler_link_created', 'crawler_link_status'].every((a) => kernel.actions.includes(a)), JSON.stringify(kernel.actions));

// ============ 7) 删除：回到 5 行 ============
const del = await evalJs(`(() => {
  const row = [...document.querySelectorAll('.pk-crawler__links .el-table__row')].find((r) => r.innerText.includes('twitter'));
  const btn = [...(row?.querySelectorAll('button') ?? [])].find((b) => b.innerText.includes('删除'));
  if (!btn) return 'missing';
  btn.click();
  return 'clicked';
})()`);
await sleep(700);
await click('.el-message-box__btns button', '确定删除');
await sleep(400);
await reauth.pass();
await sleep(1100);
const afterDelete = await probe(PAGE);
console.log('[删除]', del);
check('确认后登记行数回到 5', afterDelete.linkRows.length === 5, 'rows=' + afterDelete.linkRows.length);

// ============ 8) 越权三档：L3 / 临时账号 / 游客 ============
console.log('[切身份]', await identity('L3 管理员'));
console.log('[L3 去仪表盘]', await nav('/admin'));
const l3Menu = await probe(PAGE);
check('L3 的后台菜单没有「站外来源」', !l3Menu.menus.includes('站外来源'), l3Menu.menus.join('|'));
const l3 = await apiProbe(`
  try { out.links = 'passed'; await api.get('/admin/crawler/links'); } catch (e) { out.links = e.status + ' ' + e.code + ' ' + e.message; }
  try { out.search = 'passed'; await api.post('/admin/crawler/search', { keyword: ${JSON.stringify(KEYWORD)} }); } catch (e) { out.search = e.status + ' ' + e.code; }
  try { out.create = 'passed'; await api.post('/admin/crawler/links', { url: 'https://weibo.com/x' }); } catch (e) { out.create = e.status + ' ' + e.code; }
  try { out.order = 'passed'; await api.post('/admin/crawler/links', { url: 'https://weibo.com/x' }, { reauth: 'demo1234' }); } catch (e) { out.order = e.status + ' ' + e.code; }
`);
console.log('[L3]', JSON.stringify(l3));
check('L3 读登记表被 403 LEVEL_FORBIDDEN 拦下', String(l3.links).startsWith('403 LEVEL_FORBIDDEN'), l3.links);
check('L3 不能检索', String(l3.search).startsWith('403 LEVEL_FORBIDDEN'), l3.search);
check('L3 不能登记', String(l3.create).startsWith('403 LEVEL_FORBIDDEN'), l3.create);
check('L3 带着对的口令也先吃 403（等级判定在口令之前，D34）', String(l3.order).startsWith('403 LEVEL_FORBIDDEN'), l3.order);
console.log('[L3 深链]', await nav('/admin/crawler'), '→', (await probe(WHO)).path);
check('L3 手敲深链被弹回工作台', (await probe(WHO)).path.startsWith('/home'), (await probe(WHO)).path);

console.log('[切身份]', await identity('柚子'));
const temp = await apiProbe(`
  try { out.links = 'passed'; await api.get('/admin/crawler/links'); } catch (e) { out.links = e.status + ' ' + e.code + ' ' + e.message; }
`);
console.log('[临时账号]', JSON.stringify(temp));
check('临时账号 403 ADMIN_REQUIRED', String(temp.links).startsWith('403 ADMIN_REQUIRED'), temp.links);
const tempHome = await nav('/home');
const tempGrid = await probe(GRID);
console.log('[临时账号宫格]', tempHome, JSON.stringify(tempGrid.cells));
check('临时账号宫格里没有「爬虫」', !tempGrid.cells.some((c) => c.includes('爬虫')), tempGrid.cells.join('|'));

// ============ 9) 回 L4：宫格那一格真的进得去 ============
console.log('[切身份]', await identity('L4 超管'));
console.log('[nav]', await nav('/home'));
const grid = await probe(GRID);
console.log('[L4 宫格]', JSON.stringify(grid.cells));
check('L4 宫格出现「爬虫」', grid.cells.some((c) => c.includes('爬虫')), grid.cells.join('|'));
const cellClicked = await evalJs(`(() => {
  const cell = [...document.querySelectorAll('.pk-work__cell, .pk-cell, .pk-grid button, .pk-grid a')].find((c) => c.innerText.includes('爬虫'));
  if (!cell) return 'missing';
  cell.click();
  return 'clicked';
})()`);
await sleep(1300);
const landed = await probe(WHO);
console.log('[点格子]', cellClicked, '→', landed.path);
check('宫格点击直达 /admin/crawler（不再弹「尚未实现」）', landed.path === '/admin/crawler', landed.path);
const guest = await apiProbe(`
  const t = window.localStorage.getItem('piks.accessToken');
  out.token = t;
`);
console.log('[令牌]', JSON.stringify(guest));
await shot('crawler-05-final.png');

const failed = results.filter((r) => !r.pass);
console.log('\n==== 合计 ' + results.length + ' 项，通过 ' + (results.length - failed.length) + '，失败 ' + failed.length + ' ====');
for (const f of failed) console.log('  FAILED:', f.name);

ws.close();
cleanup();
await sleep(400);
process.exit(failed.length ? 1 : 0);
