/**
 * D31「传图时逐张选定前后期」的端到端验证（PRD 4.3 / 6.5 / 10.2 / 用例 53–54）。
 * 纯 mock，演示数据活在页面内存里，所以全程不刷新：身份走顶栏「演示身份」，换页走 router.push，
 * 传进相册的新图只在同一个页面会话里存在，取图页的分流断言必须接在同一份内存后面跑。
 * 覆盖：默认值等于目标相册的阶段（含 ?album= 深链）→ 队列里逐张独立改标 → 三条建会话请求体各自带自己的
 * stage → 完成行显示服务端回读的阶段 → stage 的 400 闸门与「不传即回落相册」→ 已上传的图改不了阶段 →
 * 青野（两阶段都完成）的 preGroups/postGroups 按图片阶段分流、历史图按相册阶段归位 →
 * 柚子（后期工单未完成）的后期段整段为空，尽管白名单里确有公开后期图。
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const PROFILE = OUT + 'edge-profile-d31/';
const PORT = 9246;
const APP = 'http://127.0.0.1:5173';
// 前期册（stage=pre，admin 档）与后期册（stage=post，public 档，临时账号 301 白名单内）
const PRE_ALBUM = '内部审稿 · 未定稿';
const POST_ALBUM = 'CP29 · 雷电将军全场返图';
const POST_ALBUM_ID = 1;
const MEMBER_ALBUM_ID = 2;
const TEMP_OF_POST_ALBUM = 'PK-2026-0913';
const FILE_BYTES = 300_000;
const F1 = 'D31-行内改标-前期.jpg';
const F2 = 'D31-沿用默认-后期.jpg';
const F3 = 'D31-新默认加入-前期.jpg';
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
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
  }
  return res.result.value;
}

/** 页面里的探针一律返回 JSON 字符串，Node 侧再 parse */
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

async function click(selector, text) {
  const done = await evalJs(`(() => {
    let els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    if (${JSON.stringify(text ?? '')}) els = els.filter((e) => e.innerText.trim().includes(${JSON.stringify(text ?? '')}));
    if (!els.length) return 'missing:' + ${JSON.stringify(selector)};
    els[0].click();
    return 'clicked';
  })()`);
  await sleep(900);
  return done;
}

/** 不刷新换页 */
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

/** 打开指定容器里的 el-select，再点当前可见、文案含 match 的项 */
async function pickOption(scope, match) {
  const opened = await evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(scope)});
    const trigger = el?.querySelector('.el-select__wrapper') ?? el;
    if (!trigger) return 'missing select';
    trigger.click();
    return 'opened';
  })()`);
  await sleep(700);
  const picked = await evalJs(`(() => {
    const item = [...document.querySelectorAll('.el-select-dropdown__item')].find((el) => {
      const popper = el.closest('.el-popper');
      const shown = popper ? getComputedStyle(popper).display !== 'none' : true;
      return shown && el.innerText.trim().includes(${JSON.stringify(match)});
    });
    if (!item) return 'missing item:' + ${JSON.stringify(match)};
    if (item.classList.contains('is-disabled')) return 'disabled item:' + ${JSON.stringify(match)};
    item.click();
    return 'picked';
  })()`);
  await sleep(700);
  return `${opened}/${picked}`;
}

/** 点某一行的阶段单选（按文件名定位行），点的是隐藏 input，v-model 照样收到 change */
async function clickRowRadio(fileName, text) {
  const got = await evalJs(`(() => {
    const row = [...document.querySelectorAll('.pk-task')].find((t) =>
      t.offsetParent !== null && t.querySelector('.pk-task__name strong')?.innerText.trim() === ${JSON.stringify(fileName)});
    if (!row) return 'missing row';
    const label = [...row.querySelectorAll('.el-radio-button')].find((l) => l.innerText.trim() === ${JSON.stringify(text)});
    const input = label?.querySelector('input');
    if (!input) return 'missing radio';
    input.click();
    return 'clicked';
  })()`);
  await sleep(300);
  return got;
}

/** 往隐藏的文件框里塞 N 个 File，走组件的 change 处理器入队 */
async function addFiles(names) {
  const n = await evalJs(`(() => {
    const dt = new DataTransfer();
    for (const name of ${JSON.stringify(names)}) {
      const bytes = new Uint8Array(${FILE_BYTES});
      bytes[0] = 0xff;
      bytes[1] = 0xd8;
      bytes[2] = 0xff;
      dt.items.add(new File([bytes], name, { type: 'image/jpeg' }));
    }
    const input = document.querySelector('.pk-drop .pk-file__input');
    if (!input) return -1;
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return ${JSON.stringify(names)}.length;
  })()`);
  await sleep(600);
  return n;
}

const WHO = `(() => JSON.stringify({
  who: document.querySelector('.pk-identity')?.innerText.trim().replace(/\\s+/g, ' ') ?? null,
  path: location.pathname + location.search,
  toasts: (window.__toasts ?? []).length,
}))()`;

/** 目的地两步：两个 select 的读数 + 「照片阶段」批次默认值 + 说明文案 */
const DEST = `(() => {
  const read = (el) => (el?.querySelector('.el-select__wrapper')?.innerText ?? el?.innerText ?? '').trim().replace(/\\s+/g, ' ');
  const group = document.querySelector('.pk-step__row .el-radio-group');
  const checked = group ? [...group.querySelectorAll('.el-radio-button')].find((l) => l.querySelector('input')?.checked) : null;
  return JSON.stringify({
    temp: read(document.querySelector('.pk-upload__temp')),
    album: read(document.querySelector('.pk-upload__album')),
    batch: checked?.innerText.trim() ?? null,
    note: document.querySelector('.pk-upload__stage-note')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
  });
})()`;

/** 当前可见的队列行 */
const QUEUE = `(() => JSON.stringify([...document.querySelectorAll('.pk-task')]
  .filter((t) => t.offsetParent !== null)
  .map((t) => {
    const checked = [...t.querySelectorAll('.el-radio-button')].find((l) => l.querySelector('input')?.checked);
    return {
      name: t.querySelector('.pk-task__name strong')?.innerText.trim() ?? '',
      state: t.querySelector('.pk-task__name > span:last-child')?.innerText.trim().replace(/\\s+/g, ' ') ?? '',
      detail: t.querySelector('.pk-task__detail')?.innerText.trim() ?? '',
      rowStage: checked?.innerText.trim() ?? t.querySelector('span.pk-chip.pk-task__stage')?.innerText.trim() ?? null,
      hasRadio: !!t.querySelector('.el-radio-group'),
      chip: t.querySelector('span.pk-chip.pk-task__stage')?.innerText.trim() ?? null,
    };
  })))()`;

/** 取图页两段：段名 + 组数 + 图数 + 说明条 + 是否有批量存图工具条 */
const TAKE = `(() => JSON.stringify([...document.querySelectorAll('.pk-take__stage')].map((s) => ({
  title: s.querySelector(':scope > .pk-admin__head .pk-section__title')?.innerText.trim().replace(/\\s+/g, ' ') ?? null,
  groups: [...s.querySelectorAll('.pk-take__group .pk-admin__head .pk-section__title')].map((g) => g.innerText.trim()),
  tiles: s.querySelectorAll('.pk-image-grid > *').length,
  alert: s.querySelector('.pk-take__alert')?.innerText.trim().replace(/\\s+/g, ' ') ?? null,
  toolbar: !!s.querySelector('.pk-admin__toolbar'),
  checkboxes: s.querySelectorAll('input[type=checkbox]').length,
  emptyNote: s.querySelector(':scope > .pk-muted')?.innerText.trim().replace(/\\s+/g, ' ') ?? null,
}))))()`;

async function apiProbe(body) {
  return probe(`(async () => {
    const api = window.__api;
    if (!api) return JSON.stringify({ err: 'no __api' });
    const out = {};
    ${body}
    return JSON.stringify(out);
  })()`);
}

/** 走完 mock 的分片流程再合并，返回落库后的图片视图 */
async function uploadThroughApi(createBody) {
  return apiProbe(`
    try {
      const s = await api.post('/uploads', ${JSON.stringify(createBody)});
      out.created = true;
      out.stage = s.stage;
      out.uploadId = s.uploadId;
      for (let i = 0; i < s.totalChunks; i += 1) await api.put('/uploads/' + s.uploadId + '/chunk/' + i);
      const back = await api.get('/uploads/' + s.uploadId);
      out.echoStage = back.stage;
      const img = await api.post('/uploads/' + s.uploadId + '/complete', {});
      out.image = { id: img.id, albumId: img.albumId, visibility: img.visibility, stage: img.stage };
    } catch (e) {
      out.err = { status: e.status, code: e.code, message: e.message };
    }
  `);
}

// ============ 0) L4 深链进传图面板，目的地是一本前期册 ============
await goto('mock.user.1', `/albums?tab=upload&album=3`);
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
// 记下每一条 POST 的请求体：组件调的是 api.post，改这个对象上的属性就能在调用点截到 body。
// 必须 import 页面真正加载过的那条 URL（可能带 ?t= 查询串）——裸路径会拿到 Vite 的另一个模块实例，
// 那个实例的 api 对象不是页面在用的，但依赖链上的 mock/db 是同一份，所以只读探针看起来一切正常。
await evalJs(`(async () => {
  const entries = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/src/api/client.ts'));
  window.__clientUrl = entries[entries.length - 1] ?? '/src/api/client.ts';
  const m = await import(/* @vite-ignore */ window.__clientUrl);
  const real = m.api.post;
  window.__posts = [];
  window.__hookHits = 0;
  m.api.post = (path, body, opts) => {
    window.__hookHits += 1;
    window.__posts.push({ path, body: JSON.parse(JSON.stringify(body ?? null)) });
    return real(path, body, opts);
  };
  window.__api = m.api;
})()`);
console.log('[拦截器挂载点]', await evalJs('JSON.stringify({url: window.__clientUrl})'));

const selfTest = await evalJs(`(async () => {
  try { await window.__api.post('/uploads', { albumId: 999999, filename: '自检.jpg', fileSize: 1, tempId: 1 }); } catch (e) { /* 预期失败 */ }
  return JSON.stringify({ hits: window.__hookHits, posts: window.__posts.length, fn: typeof window.__api.post });
})()`);
console.log('[拦截器自检]', selfTest);

const boot = await probe(DEST);
console.log('[身份/页面]', JSON.stringify(await probe(WHO)));
console.log('[目的地行]', JSON.stringify(boot));
const isUploadTab = (await probe(WHO)).path.includes('tab=upload');
check('深链 /albums?tab=upload 落在传图面板', isUploadTab, (await probe(WHO)).path);
check('前期册（' + PRE_ALBUM + '）进来默认「前期」', boot.batch === '前期', boot.batch);
check('默认值来自相册阶段的说明文案', (boot.note ?? '').includes('前期册'), boot.note);
await shot('d31-01-pre-album.png');

// ============ 1) 换相册 → 批次默认值跟着对齐 ============
console.log('[切册]', await pickOption('.pk-upload__album', POST_ALBUM));
const afterSwitch = await probe(DEST);
console.log('[切册后]', JSON.stringify(afterSwitch));
check('切到后期册（' + POST_ALBUM + '）后默认变「后期」', afterSwitch.batch === '后期', afterSwitch.batch);
check('切册后说明文案改成后期册', (afterSwitch.note ?? '').includes('后期册'), afterSwitch.note);

// 交付对象：后期册 1 在临时账号 301（柚子）的白名单里
console.log('[选临时账号]', await pickOption('.pk-upload__temp', TEMP_OF_POST_ALBUM));
check('交付对象已点上临时账号 ' + TEMP_OF_POST_ALBUM, (await probe(DEST)).temp.includes(TEMP_OF_POST_ALBUM), (await probe(DEST)).temp);

// ============ 2) 队列里逐张独立选定 ============
check('文件入队成功（2 行）', (await addFiles([F1, F2])) === 2);
const q2 = await probe(QUEUE);
check('队列里确实是两行', q2.length === 2, JSON.stringify(q2.map((t) => t.name)));
check('两行都沿用批次默认「后期」', q2.length === 2 && q2.every((t) => t.rowStage === '后期'), q2.map((t) => t.name + '=' + t.rowStage).join(' / '));
console.log('[行内改标]', await clickRowRadio(F1, '前期'));
const q3 = await probe(QUEUE);
check('行内改标只改这一行（F1 前期 / F2 仍后期）', q3[0]?.rowStage === '前期' && q3[1]?.rowStage === '后期', q3.map((t) => t.name + '=' + t.rowStage).join(' / '));
// 批次默认值改成前期：已排队的两行不动，之后加进来的 F3 取前期
await evalJs(`(() => {
  const group = document.querySelector('.pk-step__row .el-radio-group');
  const input = [...group.querySelectorAll('.el-radio-button')].find((l) => l.innerText.trim() === '前期').querySelector('input');
  input.click();
  return 1;
})()`);
await sleep(400);
check('改批次默认值不冲掉已排队的行', (await probe(QUEUE)).map((t) => t.rowStage).join(',') === '前期,后期', (await probe(QUEUE)).map((t) => t.rowStage).join(','));
check('F3 入队', (await addFiles([F3])) === 1);
const q4 = await probe(QUEUE);
check('改过默认值后新加入的行取新默认「前期」', q4[2]?.rowStage === '前期', q4.map((t) => t.name + '=' + t.rowStage).join(' / '));
await shot('d31-02-queue-stages.png');

// ============ 3) 整批上传：三条建会话请求体各自带自己的 stage ============
await evalJs('window.__posts.length = 0; window.__hookHits = 0; 1;');
const toastBefore = (await probe(WHO)).toasts;
await click('.pk-queue__head button', '开始上传');
await sleep(4200);
const allPosts = JSON.parse(await evalJs('JSON.stringify({hits: window.__hookHits ?? -1, posts: window.__posts ?? []})'));
const posts = allPosts.posts.filter((p) => p.path === '/uploads').map((p) => p.body);
check('发了 3 次建会话', posts.length === 3, 'hook 命中 ' + allPosts.hits + ' 次，全部 path=' + allPosts.posts.map((p) => p.path).join(','));
check(
  '同一批里三张图的 stage 各自独立（pre/post/pre），不是一个值盖整批',
  JSON.stringify(posts.map((p) => p.stage)) === '["pre","post","pre"]',
  posts.map((p) => p.filename + '=' + p.stage).join(' / '),
);
check('每条请求体都点名了交付的临时账号与相册', posts.length === 3 && posts.every((p) => p.tempId === 301 && p.albumId === POST_ALBUM_ID), JSON.stringify(posts.map((p) => [p.albumId, p.tempId])));
const done = await probe(QUEUE);
console.log('[完成行]', JSON.stringify(done));
check('三行都进入「已完成」', done.length === 3 && done.filter((t) => t.state.includes('已完成')).length === 3, JSON.stringify(done.map((t) => t.state)));
const uploadPaneRows = await probe(`(() => JSON.stringify([...(document.querySelectorAll('.pk-queue__list')[0]?.querySelectorAll('.pk-task') ?? [])].map((t) => ({
  name: t.querySelector('.pk-task__name strong')?.innerText.trim() ?? '',
  chip: t.querySelector('span.pk-chip.pk-task__stage')?.innerText.trim() ?? null,
  hasRadio: !!t.querySelector('.el-radio-group'),
}))))()`);
console.log('[上传页行控件态]', JSON.stringify(uploadPaneRows));
check(
  '开传后行内单选控件收掉，只剩阶段徽标（前期/后期/前期）',
  uploadPaneRows.length === 3 && uploadPaneRows.every((r) => !r.hasRadio) && uploadPaneRows.map((r) => r.chip).join(',') === '前期,后期,前期',
  JSON.stringify(uploadPaneRows),
);
const detailStages = done.map((t) => /·\s*(前期|后期)\s*$/.exec(t.detail)?.[1] ?? null);
check('明细末尾显示服务端回读的阶段', JSON.stringify(detailStages) === '["前期","后期","前期"]', done.map((t) => t.detail).join(' | '));
const newIds = done.map((t) => Number(/#(\d+)\s*·/.exec(t.detail)?.[1] ?? 0));
check('明细里的图片 id 来自服务端回执且互不相同', newIds.every((n) => n > 0) && new Set(newIds).size === 3, newIds.join(','));
const toasts = JSON.parse(await evalJs(`JSON.stringify(window.__toasts.slice(${toastBefore}))`));
console.log('[回执]', toasts.join(' | '));
check('成功提示按「前期 2 张 / 后期 1 张」分组', toasts.some((t) => t.includes('前期 2 张 / 后期 1 张')), toasts.join(' | '));
check('上传收尾重新拉列表后，手改的批次默认值仍是前期', (await probe(DEST)).batch === '前期', (await probe(DEST)).batch);
await shot('d31-03-uploaded.png');

// 落库侧证据：后期册里两张前期图 + 一张后期图，档位继承相册为 public
const stored = await apiProbe(`
  const p = await api.get('/albums/${POST_ALBUM_ID}/images', { query: { page: 1, pageSize: 50 } });
  out.rows = p.list.filter((i) => ${JSON.stringify([F1, F2, F3])}.includes(i.filename))
    .map((i) => ({ id: i.id, name: i.filename, stage: i.stage, visibility: i.visibility, temp: i.uploadTempId }));
  out.untagged = p.list.filter((i) => i.id < 200 && i.uploadTempId === null).map((i) => i.id + ':' + i.stage).slice(0, 6);
`);
console.log('[落库]', JSON.stringify(stored.rows));
const stageOf = Object.fromEntries(stored.rows.map((r) => [r.name, r.stage]));
const idOf = Object.fromEntries(stored.rows.map((r) => [r.name, r.id]));
const f1Id = idOf[F1] ?? 0;
const f2Id = idOf[F2] ?? 0;
const f3Id = idOf[F3] ?? 0;
check(
  '相册列表回读：行内改标的与按新默认加入的都落前期，沿用默认那张落后期',
    stageOf[F1] === 'pre' && stageOf[F2] === 'post' && stageOf[F3] === 'pre',
  JSON.stringify(stageOf),
);
check('新图归属到点名的临时账号、档位继承相册', stored.rows.every((r) => r.temp === 301 && r.visibility === 'public'), JSON.stringify(stored.rows.map((r) => [r.temp, r.visibility])));
check('册内未标阶段的历史图按相册阶段（post）报出', (stored.untagged ?? []).every((x) => x.endsWith(':post')), JSON.stringify(stored.untagged));

// ============ 4) 内核闸门：非法 stage 在建会话那一关就拒，不静默回落 ============
for (const [label, value] of [['mid', 'mid'], ['PRE', 'PRE'], ['数字 1', 1]]) {
  const bad = await apiProbe(`
    try { out.ok = await api.post('/uploads', { albumId: ${MEMBER_ALBUM_ID}, filename: '闸门.jpg', fileSize: ${FILE_BYTES}, tempId: 302, stage: ${JSON.stringify(value)} }); }
    catch (e) { out.err = { status: e.status, code: e.code, message: e.message }; }
  `);
  check(
    `stage=${label} 被 400 VALIDATION_FAILED 挡下，会话根本没建`,
    bad.err?.status === 400 && bad.err?.code === 'VALIDATION_FAILED' && bad.ok === undefined,
    JSON.stringify(bad.err ?? bad.ok),
  );
}

const noStage = await uploadThroughApi({ albumId: MEMBER_ALBUM_ID, filename: 'D31-未标阶段.jpg', fileSize: FILE_BYTES, tempId: 302 });
check('不带 stage 时会话照建，回执 stage=null', noStage.stage === null, JSON.stringify({ created: noStage.created, stage: noStage.stage, err: noStage.err }));
check('会话可查回阶段（断点续读不丢字段）', 'echoStage' in noStage && noStage.echoStage === null, 'echoStage=' + JSON.stringify(noStage.echoStage));
check('没标阶段的图落库时回落到所属相册阶段（册 2=post）', noStage.image?.stage === 'post', JSON.stringify(noStage.image));

const tagPre = await uploadThroughApi({ albumId: MEMBER_ALBUM_ID, filename: 'D31-后期册里的前期图.jpg', fileSize: FILE_BYTES, tempId: 302, stage: 'pre' });
check('后期册里标了前期的图，相册阶段盖不住它（stage=pre 落库）', tagPre.image?.stage === 'pre', JSON.stringify(tagPre.image));

const retag = await apiProbe(`
  try {
    const patched = await api.patch('/images/${tagPre.image.id}', { stage: 'post' });
    const page = await api.get('/albums/${MEMBER_ALBUM_ID}/images', { query: { page: 1, pageSize: 50 } });
    out.after = page.list.find((i) => i.id === ${tagPre.image.id})?.stage;
    out.echo = patched.stage;
  } catch (e) { out.err = { status: e.status, code: e.code, message: e.message }; }
`);
check('已进相册的图本轮改不了阶段：PATCH 带 stage 被忽略，阶段维持 pre', retag.after === 'pre' && retag.echo === 'pre' && retag.err === undefined, JSON.stringify(retag));
await shot('d31-04-kernel.png');

// ============ 5) 取图页两段按图片阶段分流（青野：两阶段都已完成）============
console.log('[切身份]', await identity('青野'));
const aoki = await apiProbe(`
  const t = await api.get('/take/pending');
  out.code = t.code;
  out.preStageDone = t.preStageDone;
  out.postStageDone = t.postStageDone;
  out.pre = (t.preGroups ?? []).flatMap((g) => g.images.map((i) => i.id + ':' + i.stage));
  out.post = (t.postGroups ?? []).flatMap((g) => g.images.map((i) => i.id + ':' + i.stage));
  out.preNames = (t.preGroups ?? []).map((g) => g.name);
  out.postNames = (t.postGroups ?? []).map((g) => g.name);
`);
console.log('[青野]', JSON.stringify(aoki));
check('青野两段都开（preStageDone/postStageDone 均为真）', aoki.preStageDone === true && aoki.postStageDone === true, JSON.stringify([aoki.preStageDone, aoki.postStageDone]));
check('preGroups 里每张图都是前期', aoki.pre.length > 0 && aoki.pre.every((x) => x.endsWith(':pre')), aoki.pre.join(','));
check('postGroups 里每张图都是后期', aoki.post.length > 0 && aoki.post.every((x) => x.endsWith(':post')), aoki.post.join(','));
check('两段图片 id 无交集', !aoki.pre.some((x) => aoki.post.includes(x)), JSON.stringify([aoki.pre, aoki.post]));
check('同一本相册在两段各出现一次（组名相同、图不同）', JSON.stringify(aoki.preNames) === JSON.stringify(aoki.postNames) && aoki.preNames.length === 1, JSON.stringify([aoki.preNames, aoki.postNames]));
check('显式标过前期的历史图 206 进 preGroups', aoki.pre.some((x) => x.startsWith('206:')), aoki.pre.join(','));
check('没标阶段的历史图 202 按相册阶段归到 postGroups', aoki.post.some((x) => x.startsWith('202:')), aoki.post.join(','));
check('青野的白名单不含册 1，本轮新传的三张图都不进它的分组', ![f1Id, f2Id, f3Id].some((n) => [...aoki.pre, ...aoki.post].some((x) => x.startsWith(n + ':'))), JSON.stringify([aoki.pre, aoki.post, [f1Id, f2Id, f3Id]]));

console.log('[nav]', await nav('/take'));
const uiAoki = await probe(TAKE);
console.log('[青野取图页]', JSON.stringify(uiAoki));
check('取图页两段各渲染 1 组', uiAoki.length === 2 && uiAoki.every((s) => s.groups.length === 1), JSON.stringify(uiAoki.map((s) => s.groups.length)));
check('两段组名同为「' + 'IDO 春日祭 · 芙莉莲专题' + '」', uiAoki[0]?.groups[0] === uiAoki[1]?.groups[0] && !!uiAoki[0]?.groups[0], JSON.stringify(uiAoki.map((s) => s.groups[0])));
check('两段张数与接口一致（前期 1 / 后期 1）', uiAoki[0]?.tiles === aoki.pre.length && uiAoki[1]?.tiles === aoki.post.length, JSON.stringify(uiAoki.map((s) => s.tiles)));
await shot('d31-05-take-aoki.png');

// ============ 6) 工单阶段仍是那一段的开关（柚子：后期未完成）============
console.log('[切身份]', await identity('柚子'));
const yuzu = await apiProbe(`
  const t = await api.get('/take/pending');
  out.preStageDone = t.preStageDone;
  out.postStageDone = t.postStageDone;
  out.canDownload = t.canDownload;
  out.postGroups = t.postGroups;
  out.pre = (t.preGroups ?? []).flatMap((g) => g.images.map((i) => i.id + ':' + i.stage));
  out.preNames = (t.preGroups ?? []).map((g) => g.name);
  const album = await api.get('/albums/${POST_ALBUM_ID}/images', { query: { page: 1, pageSize: 50 } });
  out.publicPost = album.list.filter((i) => i.visibility === 'public' && i.stage === 'post').map((i) => i.id);
`);
console.log('[柚子]', JSON.stringify(yuzu));
check('柚子的后期工单未完成 ⇒ postGroups 是空数组', yuzu.postStageDone === false && JSON.stringify(yuzu.postGroups) === '[]', JSON.stringify([yuzu.postStageDone, yuzu.postGroups]));
check('开关不是「白名单里没图」：册 1 确有公开后期图', yuzu.publicPost.length > 0, JSON.stringify(yuzu.publicPost));
check('前期段照常出图且全是前期', yuzu.pre.length > 0 && yuzu.pre.every((x) => x.endsWith(':pre')), yuzu.pre.join(','));
check('本轮新传的两张前期图进柚子的 preGroups（成员代传的图能被取图）', yuzu.preNames.includes(POST_ALBUM) && yuzu.pre.some((x) => x.startsWith(f1Id + ':')) && yuzu.pre.some((x) => x.startsWith(f3Id + ':')), JSON.stringify([yuzu.preNames, yuzu.pre]));
check('那张公开后期图因后期工单未完成而一张都不出现', !yuzu.pre.some((x) => x.startsWith(f2Id + ':')), 'f2Id=' + f2Id);
check('allow_download=0 时两段一起只读预览', yuzu.canDownload === false);

console.log('[nav]', await nav('/take'));
const uiYuzu = await probe(TAKE);
console.log('[柚子取图页]', JSON.stringify(uiYuzu));
check('后期段显示「后期还没修完」说明，不给空网格', (uiYuzu[1]?.alert ?? '').includes('后期还没修完') && uiYuzu[1]?.tiles === 0, JSON.stringify([uiYuzu[1]?.alert, uiYuzu[1]?.tiles]));
check('前期段有图、两段都没有勾选框与批量存图', uiYuzu[0]?.tiles > 0 && uiYuzu.every((s) => !s.toolbar && s.checkboxes === 0), JSON.stringify(uiYuzu.map((s) => [s.toolbar, s.checkboxes])));
await shot('d31-06-take-yuzu.png');

const failed = results.filter((r) => !r.pass);
console.log('\n==== 合计 ' + results.length + ' 项，通过 ' + (results.length - failed.length) + '，失败 ' + failed.length + ' ====');
for (const f of failed) console.log('  FAILED:', f.name);

ws.close();
cleanup();
await sleep(400);
process.exit(failed.length ? 1 : 0);
