<script setup lang="ts">
/**
 * 加密空间（/drive/encrypted，PRD 5.7 / D26）。
 *
 * 口令只在浏览器里派生密钥：文件名与字节都在本地加密后才出网，服务端与超管拿到的都是密文容器。
 * 于是「解锁」没有任何服务端接口可调——校验子是本地的已知串，能解开就算口令对。
 * 密钥只存在这个组件的内存里：锁定、切页、刷新都要重新输口令，这是「忘记口令不可恢复」的另一半。
 *
 * 超管按 D19/D1 能进他人的空间，但那里只有一列容量数字和删除按钮：
 * 文件名密文与密文字节都不下发，免得档位给的删除权被顺手扩成离线爆破口令的素材。
 *
 * 关联：入口是首页宫格「加密文件」格（`config/workbench.ts` 的 `encrypted`）→ 路由 `/drive/encrypted`，
 * 准入只写在 router 的 `meta.auth + meta.member` 上（游客 401 / 临时账号 403），本页不再自己判身份等级；
 * 谁能看哪一列由接口层决定（`api/mock/vault.ts` 的 `targetOf` / `viewOf`），页面只渲染收到的字段。
 * 身份与配额来自 `stores/session`，传输全部走 `api/vault.ts`，密码学全部走 `utils/crypto.ts`。
 *
 * 两条下载通道（D29）：**下载加密文件**保存未解密的密文容器，文件名是原名后加 `.BEKER`
 * （`摊位合同.pdf` → `摊位合同.pdf.BEKER`），换设备、异地备份走这一条，凭口令还能「解密下载」还原；
 * **解密下载**在本地解开后按原名落盘，明文从不经服务端。两条都在传输队列里报真实进度。
 *
 * 本地加解密（D30）：「加密」「解密」这对按钮**不碰空间也不碰接口**——选本地文件 → 用内存里那把密钥封/解 →
 * 结果直接交给浏览器落盘，条目数、密文体积与配额一位不动。产物与「下载加密文件」逐字节同形，可以互相搬运；
 * 用的仍是本空间那一个口令，所以锁定之后这对按钮没有密钥可用，也不在这里另设第二个口令框。
 *
 * 注意：① 密钥与解出的文件名只存组件内存，`onBeforeUnmount` 一律清掉，**不要**为了「刷新后省事」
 * 把它们写进任何浏览器存储；② mock 的库存在模块内存里，整页刷新连演示数据一起重置（全站既有行为），
 * 所以「锁定后重新解锁」用页面自己的锁定按钮测，不要拿刷新当用例；③ 他人空间是**只读容量视图**，
 * 不渲染上传表单、解锁卡与拖放区——藏表单不算闸门，真正的拒绝在接口层；④ 样式自持一份 `pk-vault__*`，
 * 刻意不复用也不外泄 `.pk-tab` / `.pk-queue` / `.pk-task`（那些是网盘页的既有骨架）；
 * ⑤ 传输队列的标题与说明**不叫** `.pk-vault__title` / `.pk-vault__lede`——那两个类在页内被当成
 * 「当前处于哪一张卡」的读数用（向导 / 解锁 / 我的密文 / 只读容量视图），队列一插进去就会把它们顶掉。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  vaultDeleteFile,
  vaultDestroySpace,
  vaultFiles,
  vaultGetCipher,
  vaultPutFile,
  vaultRekey,
  vaultSetup,
  vaultSpaces,
  vaultStatus,
  type VaultRekeyItem,
} from '@/api/vault';
import { errorText } from '@/api/client';
import type { VaultFileView, VaultSpaceRow, VaultStatus } from '@/types/api';
import { UserLevel } from '@/types/api';
import { formatBytes, formatDate, percent } from '@/utils/format';
import {
  bytesToB64,
  checkVerifier,
  CIPHER_EXT,
  cipherFileName,
  CONTAINER_OVERHEAD,
  CONTAINER_VERSION,
  decipherFileName,
  decryptBytes,
  decryptName,
  deriveVaultKey,
  encryptBytes,
  encryptName,
  mintSpaceSecret,
  newVaultParams,
  type VaultKey,
} from '@/utils/crypto';
import { useSessionStore } from '@/stores/session';

/** 口令最短长度：加密空间的口令没有重置途径，比登录密码（6 位）要求高一档 */
const MIN_PASS = 8;
const NO_RECOVERY = '忘记口令后无法找回：服务端只存密文、盐与校验子，没有任何人能替你解开盘子。';

const session = useSessionStore();
const router = useRouter();
const route = useRoute();

const status = ref<VaultStatus | null>(null);
const rows = ref<VaultFileView[]>([]);
const spaces = ref<VaultSpaceRow[]>([]);
/** 条目 id → 本地解出的文件名；口令一丢这列就没了，所以不落任何持久化存储 */
const names = ref<Record<number, string>>({});
const key = ref<VaultKey | null>(null);

const loading = ref(false);
const busy = ref(false);
const progress = ref('');
const owner = ref<number | null>(null);
const panel = ref<'space' | 'spaces'>('space');
const dragOver = ref(false);

const fileInput = ref<HTMLInputElement | null>(null);
const localEncryptInput = ref<HTMLInputElement | null>(null);
const localDecryptInput = ref<HTMLInputElement | null>(null);
const unlockPass = ref('');

const setup = reactive({ pass: '', confirm: '', hint: '', agree: false, busy: false });
const rekey = reactive({ open: false, next: '', confirm: '', hint: '', busy: false });

/**
 * 传输队列：加密上传、两种下载与本地加解密共用一份，每行一个阶段化进度条
 * （D29「可以看下载进度」、D30「加密／解密按钮」）。
 * 阶段区间是**权重**而不是估算——`读取中` 那一段按真实到手字节走，`加密中` 只有一次
 * WebCrypto 调用、跑完才跳到位，所以条子会停在区间起点等它返回，不会假装在推进。
 */
type TransferKind = 'encrypt' | 'cipher' | 'plain' | 'local-encrypt' | 'local-decrypt';
type TransferState = '排队' | '读取中' | '加密中' | '提交中' | '取回中' | '解密中' | '已完成' | '失败';

interface TransferTask {
  key: number;
  kind: TransferKind;
  /** 展示名：加密任务是原文件名，下载与本地任务是**落盘文件名**（密文那条带 .BEKER） */
  label: string;
  state: TransferState;
  progress: number;
  detail: string;
}

const STAGE_BANDS: Record<TransferKind, Partial<Record<TransferState, [number, number]>>> = {
  encrypt: { 读取中: [0, 55], 加密中: [55, 85], 提交中: [85, 99] },
  cipher: { 取回中: [0, 99] },
  plain: { 取回中: [0, 60], 解密中: [60, 99] },
  'local-encrypt': { 读取中: [0, 60], 加密中: [60, 99] },
  'local-decrypt': { 读取中: [0, 60], 解密中: [60, 99] },
};

const tasks = ref<TransferTask[]>([]);
let taskSeq = 0;

const activeTasks = computed(() => tasks.value.filter((item) => item.state !== '已完成' && item.state !== '失败'));
const doneTasks = computed(() => tasks.value.filter((item) => item.state === '已完成' || item.state === '失败'));
/** 有任务在跑就不许销毁／删除：中途掉一条密文会让「整空间重封」的条数校验对不上 */
const transferring = computed(() => activeTasks.value.length > 0);

function newTask(kind: TransferKind, label: string): TransferTask {
  tasks.value = [...tasks.value, { key: (taskSeq += 1), kind, label, state: '排队', progress: 0, detail: '' }];
  return tasks.value[tasks.value.length - 1];
}

function setStage(task: TransferTask, state: TransferState, frac = 0): void {
  task.state = state;
  const band = STAGE_BANDS[task.kind][state];
  if (!band) return;
  const clamped = Math.min(1, Math.max(0, frac));
  const next = Math.round(band[0] + (band[1] - band[0]) * clamped);
  if (next > task.progress) task.progress = next;
}

function finishTask(task: TransferTask, detail: string): void {
  task.state = '已完成';
  task.progress = 100;
  task.detail = detail;
}

function failTask(task: TransferTask, detail: string): void {
  task.state = '失败';
  task.detail = detail;
}

function clearDone(): void {
  tasks.value = activeTasks.value;
}

/** 让出一帧：进度条要的是浏览器有机会画，不是等真的空闲 */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 分块读本地文件：整块 arrayBuffer() 没有中间态，大文件只能看到 0% 直接跳 100% */
async function readBytes(file: File, onLoaded: (loaded: number) => void): Promise<Uint8Array> {
  const reader = file.stream().getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    parts.push(value);
    loaded += value.length;
    onLoaded(loaded);
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 落盘：object URL 延迟释放，同步 revoke 会赶上下载任务、个别内核版本直接把它取消掉 */
function saveToDisk(bytes: Uint8Array, fileName: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const myUid = computed(() => (session.profile?.kind === 'user' ? session.profile.uid : 0));
const isSuper = computed(() => session.level >= UserLevel.SuperAdmin);
/** 只有跨到自己的 uid 之外才算「看别人的空间」，L1–L3 根本拿不到这个选项 */
const ownerParam = computed(() => (owner.value && owner.value !== myUid.value ? owner.value : undefined));
const viewingOther = computed(() => ownerParam.value !== undefined);
const unlocked = computed(() => !!key.value && !viewingOther.value);
const nameSupported = computed(() => !!globalThis.crypto?.subtle);

const entries = computed(() => status.value?.fileCount ?? 0);
const quotaPercent = computed(() => percent(status.value?.used ?? 0, status.value?.quota ?? 0));
const ownedSpaces = computed(() => spaces.value.filter((item) => item.uid !== myUid.value));

function displayName(row: VaultFileView): string {
  if (!row.nameCipher) return '密文文件名（仅本人可解）';
  return names.value[row.id] ?? '（未解锁）';
}

/** 解得出的原名才有落盘名：他人空间不下发文件名密文，锁定态也没有密钥可解 */
function resolvedName(row: VaultFileView): string | null {
  return row.nameCipher ? names.value[row.id] ?? null : null;
}

/** `原名.pdf` → `原名.pdf.BEKER`，即「下载加密文件」那一条存下来的文件名 */
function cipherNameOf(row: VaultFileView): string | null {
  const plain = resolvedName(row);
  return plain ? cipherFileName(plain) : null;
}

/** 锁定态解不出文件名，图标只能退到 MIME 短标签；解锁后一律用真扩展名 */
const MIME_BADGE: Record<string, string> = {
  'text/plain': 'TXT',
  'application/pdf': 'PDF',
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'application/zip': 'ZIP',
};

function badgeOf(row: VaultFileView): string {
  const name = displayName(row);
  const dot = row.nameCipher ? name.lastIndexOf('.') : -1;
  if (dot > 0) return name.slice(dot + 1).toUpperCase().slice(0, 4);
  return MIME_BADGE[row.mimeType] ?? 'BIN';
}

function clearSecret(): void {
  key.value = null;
  names.value = {};
}

async function decryptNames(): Promise<void> {
  const current = key.value;
  if (!current) return;
  const map: Record<number, string> = {};
  for (const row of rows.value) {
    if (!row.nameCipher) continue;
    try {
      map[row.id] = await decryptName(current, row.nameCipher);
    } catch {
      map[row.id] = '（文件名密文解不开：容器或密钥已变更）';
    }
  }
  names.value = map;
}

async function load(): Promise<void> {
  if (!isSuper.value) {
    status.value = await vaultStatus();
    rows.value = await vaultFiles();
  } else {
    const [nextStatus, nextRows, nextSpaces] = await Promise.all([
      vaultStatus(ownerParam.value),
      vaultFiles(ownerParam.value),
      vaultSpaces(),
    ]);
    status.value = nextStatus;
    rows.value = nextRows;
    spaces.value = nextSpaces;
  }
  if (viewingOther.value) names.value = {};
  else if (key.value) await decryptNames();
  else names.value = {};
}

async function reload(): Promise<void> {
  loading.value = true;
  try {
    await load();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
}

/** owner 进查询串（照 D18 网盘标签页的做法）：刷新不丢视角，超管也能把某个空间的链接发出去 */
function ownerFromQuery(): number | null {
  if (!isSuper.value) return null;
  const raw = Array.isArray(route.query.owner) ? route.query.owner[0] : route.query.owner;
  const uid = Number(raw);
  return Number.isFinite(uid) && uid > 0 && uid !== myUid.value ? uid : null;
}

async function applyOwner(uid: number | null): Promise<void> {
  owner.value = uid;
  const query: Record<string, string> = {};
  for (const [name, value] of Object.entries(route.query)) {
    const single = Array.isArray(value) ? value[0] : value;
    if (name !== 'owner' && single !== null && single !== undefined) query[name] = single;
  }
  if (uid) query.owner = String(uid);
  void router.replace({ query });
  await reload();
}

function pickOwner(): void {
  const uid = owner.value && owner.value !== myUid.value ? owner.value : null;
  void applyOwner(uid);
}

function viewSpace(uid: number): void {
  panel.value = 'space';
  void applyOwner(uid);
}

function backToOwnSpace(): void {
  void applyOwner(null);
}

/** 初始化：口令 → PBKDF2 → 校验子，三样东西里只有盐与校验子出库，口令本身从不出页面 */
async function submitSetup(): Promise<void> {
  if (!nameSupported.value) {
    ElMessage.error('当前环境不支持 WebCrypto，加密空间需要 HTTPS 或 localhost');
    return;
  }
  if (setup.pass.length < MIN_PASS) {
    ElMessage.warning(`口令至少 ${MIN_PASS} 位`);
    return;
  }
  if (setup.pass !== setup.confirm) {
    ElMessage.warning('两次输入的口令不一致');
    return;
  }
  if (!setup.agree) {
    ElMessage.warning('请先确认「忘记口令无法找回」');
    return;
  }
  setup.busy = true;
  try {
    const params = newVaultParams();
    const minted = await mintSpaceSecret(setup.pass, params);
    status.value = await vaultSetup({
      salt: params.salt,
      iterations: params.iterations,
      verifier: minted.verifier,
      hint: setup.hint.trim() || undefined,
    });
    key.value = minted.key;
    setup.pass = '';
    setup.confirm = '';
    setup.hint = '';
    setup.agree = false;
    await load();
    ElMessage.success('空间已初始化，当前处于解锁状态');
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    setup.busy = false;
  }
}

async function unlock(): Promise<void> {
  const current = status.value;
  if (!current?.salt) {
    ElMessage.warning('空间还没设口令');
    return;
  }
  if (!unlockPass.value) {
    ElMessage.warning('请输入口令');
    return;
  }
  busy.value = true;
  try {
    const derived = await deriveVaultKey(unlockPass.value, { salt: current.salt, iterations: current.iterations });
    if (!current.verifier || !(await checkVerifier(derived, current.verifier))) {
      ElMessage.error('口令不对：校验子解不开，空间里没有任何东西被改动');
      return;
    }
    key.value = derived;
    unlockPass.value = '';
    await decryptNames();
    ElMessage.success('已解锁');
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
  }
}

function lock(): void {
  clearSecret();
  ElMessage.info('已锁定，密钥只在这一次会话里存在');
}

function openFilePicker(): void {
  fileInput.value?.click();
}

function onFilePick(event: Event): void {
  const input = event.target as HTMLInputElement;
  const picked = Array.from(input.files ?? []);
  input.value = '';
  if (picked.length) void uploadFiles(picked);
}

function onDrop(event: DragEvent): void {
  dragOver.value = false;
  const picked = Array.from(event.dataTransfer?.files ?? []);
  if (picked.length) void uploadFiles(picked);
}

/** 上传 = 本地加密后提交：先名字再字节，两条都用同一条密钥、不同的 AAD */
async function uploadFiles(picked: File[]): Promise<void> {
  const current = key.value;
  if (!current || viewingOther.value) {
    ElMessage.warning('请先解锁自己的空间');
    return;
  }
  let ok = 0;
  let rejected = 0;
  for (const file of picked) {
    const task = newTask('encrypt', file.name);
    try {
      const bytes = await readBytes(file, (loaded) => setStage(task, '读取中', loaded / Math.max(1, file.size)));
      setStage(task, '加密中');
      await yieldToUi();
      const cipher = await encryptBytes(current, bytes);
      setStage(task, '提交中');
      const dot = file.name.lastIndexOf('.');
      await vaultPutFile(
        {
          nameCipher: await encryptName(current, file.name),
          plainSize: file.size,
          mimeType: file.type || 'application/octet-stream',
          ext: dot > 0 ? file.name.slice(dot + 1).toLowerCase() : '',
        },
        cipher,
      );
      finishTask(task, `已入库 · 容器 ${formatBytes(cipher.length)} = 明文 ${formatBytes(file.size)} + ${CONTAINER_OVERHEAD} 字节开销`);
      ok += 1;
    } catch (err) {
      const reason = errorText(err);
      failTask(task, reason);
      ElMessage.error(reason);
      rejected += 1;
    }
  }
  await load();
  if (!ok) return;
  ElMessage.success(rejected ? `${ok} 个已加密提交，${rejected} 个被拒，原因见传输进度` : `${ok} 个文件已加密提交，下载时的后缀为 .${CIPHER_EXT}`);
}

/**
 * 下载 = 取回密文 → 按需本地解密 → 落盘。
 * `cipher` 保存的是**未解密**的容器，文件名为 `原名.BEKER`（异地备份、换设备用这一条）；
 * `plain` 在本地解开后按原名落盘，明文从不经服务端。两条的进度都出自同一份队列。
 */
async function download(row: VaultFileView, mode: 'cipher' | 'plain'): Promise<void> {
  const current = key.value;
  const plainName = resolvedName(row);
  if (!current || !plainName || !row.links.cipher) {
    ElMessage.warning('请先解锁自己的空间');
    return;
  }
  const bakerName = cipherFileName(plainName);
  const task = newTask(mode, mode === 'cipher' ? bakerName : plainName);
  try {
    const cipher = await vaultGetCipher(row, (loaded, total) =>
      setStage(task, '取回中', loaded / (total || row.size || 1)),
    );
    let bytes = cipher;
    let fileName = bakerName;
    let mimeType = 'application/octet-stream';
    if (mode === 'plain') {
      setStage(task, '解密中');
      await yieldToUi();
      bytes = await decryptBytes(current, cipher);
      if (bytes.length !== row.plainSize) {
        ElMessage.warning(`解出 ${bytes.length} 字节，与登记的明文体积 ${row.plainSize} 不符`);
      }
      fileName = plainName;
      mimeType = row.mimeType || 'application/octet-stream';
    }
    saveToDisk(bytes, fileName, mimeType);
    finishTask(
      task,
      mode === 'cipher'
        ? `密文容器已落盘（未解密）· ${formatBytes(bytes.length)}`
        : `明文已还原 · ${formatBytes(bytes.length)}`,
    );
  } catch (err) {
    failTask(task, errorText(err));
    ElMessage.error(errorText(err));
  }
}

/**
 * 本地加解密（D30）：「加密」与「解密」这对按钮只在浏览器里做事——选本地文件 → 用内存里
 * 那把本空间的密钥封/解 → 直接把结果交给浏览器落盘。**不上传、不入库、不占配额、不动条目数**，
 * 也不经任何接口，所以 5.2 黑名单、配额这些服务端闸门在这儿一道都不会触发。
 * 产出的容器与「下载加密文件」逐字节同形，两边可以互相搬运。
 */
function pickLocal(mode: 'encrypt' | 'decrypt'): void {
  if (mode === 'encrypt') localEncryptInput.value?.click();
  else localDecryptInput.value?.click();
}

function onLocalPick(event: Event, mode: 'encrypt' | 'decrypt'): void {
  const input = event.target as HTMLInputElement;
  const picked = Array.from(input.files ?? []);
  input.value = '';
  if (!picked.length) return;
  void (mode === 'encrypt' ? encryptLocal(picked) : decryptLocal(picked));
}

/** 密钥就是空间那把：锁定之后没有密钥可取，这里直接拒，不另设第二个口令框 */
function requireLocalKey(): VaultKey | null {
  const current = key.value;
  if (!current || viewingOther.value) {
    ElMessage.warning('请先解锁自己的空间：这对按钮用的就是本空间口令派生出的那把密钥');
    return null;
  }
  return current;
}

async function encryptLocal(picked: File[]): Promise<void> {
  const current = requireLocalKey();
  if (!current) return;
  let ok = 0;
  for (const file of picked) {
    const bakerName = cipherFileName(file.name);
    const task = newTask('local-encrypt', bakerName);
    try {
      const bytes = await readBytes(file, (loaded) => setStage(task, '读取中', loaded / Math.max(1, file.size)));
      setStage(task, '加密中');
      await yieldToUi();
      const cipher = await encryptBytes(current, bytes);
      saveToDisk(cipher, bakerName, 'application/octet-stream');
      finishTask(
        task,
        `已本地加密落盘（未上传）· 容器 ${formatBytes(cipher.length)} = 明文 ${formatBytes(file.size)} + ${CONTAINER_OVERHEAD} 字节开销`,
      );
      ok += 1;
    } catch (err) {
      failTask(task, errorText(err));
      ElMessage.error(errorText(err));
    }
  }
  if (ok) ElMessage.success(`${ok} 个文件已加密为 .${CIPHER_EXT} 并落盘，没有上传到空间`);
}

async function decryptLocal(picked: File[]): Promise<void> {
  const current = requireLocalKey();
  if (!current) return;
  let ok = 0;
  for (const file of picked) {
    // 容器里不存文件名，落盘名只能从 .BEKER 后缀还原；没带后缀的按原名写回，能不能解开由 GCM 说了算
    const outName = decipherFileName(file.name);
    const task = newTask('local-decrypt', outName);
    try {
      const container = await readBytes(file, (loaded) => setStage(task, '读取中', loaded / Math.max(1, file.size)));
      if (container.length < CONTAINER_OVERHEAD) {
        throw new Error(
          `不是 .${CIPHER_EXT} 容器：整份只有 ${container.length} 字节，连 ${CONTAINER_OVERHEAD} 字节的容器头与标签都不够`,
        );
      }
      if (container[0] !== CONTAINER_VERSION) {
        throw new Error(`不是 .${CIPHER_EXT} 容器：版本字节是 ${container[0]}，本内核只认 ${CONTAINER_VERSION}`);
      }
      setStage(task, '解密中');
      await yieldToUi();
      let plain: Uint8Array;
      try {
        plain = await decryptBytes(current, container);
      } catch {
        // 口令不对与容器被改过在 AES-GCM 下是同一种失败：不区分，也不写出半成品
        throw new Error('解不开：口令与本空间不一致，或容器已被改动（GCM 校验未过，没有写出任何文件）');
      }
      saveToDisk(plain, outName, 'application/octet-stream');
      finishTask(
        task,
        `已本地解密落盘（未经服务端）· 明文 ${formatBytes(plain.length)} = 容器 ${formatBytes(container.length)} − ${CONTAINER_OVERHEAD} 字节开销`,
      );
      ok += 1;
    } catch (err) {
      failTask(task, errorText(err));
      ElMessage.error(errorText(err));
    }
  }
  if (ok) ElMessage.success(`${ok} 个容器已解回原名并落盘`);
}

async function removeOne(row: VaultFileView): Promise<void> {
  const label = row.nameCipher ? displayName(row) : `条目 #${row.id}`;
  try {
    await ElMessageBox.confirm(`删除后不可还原：${label}。加密条目不进垃圾箱。`, '彻底删除', {
      type: 'warning',
      confirmButtonText: '彻底删除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  busy.value = true;
  try {
    await vaultDeleteFile(row.id);
    await reload();
    ElMessage.success('已就地销毁');
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
  }
}

/**
 * 改口令：先用旧密钥逐条解开，再用新密钥逐条封好，最后**一次请求**整份提交。
 * 拆成逐条替换会在中途失败时留下「空间已是新密钥、某条还是旧密钥」的永久不可读状态。
 */
async function submitRekey(): Promise<void> {
  const oldKey = key.value;
  const current = status.value;
  if (!oldKey || !current?.salt) {
    ElMessage.warning('请先解锁自己的空间');
    return;
  }
  if (rekey.next.length < MIN_PASS) {
    ElMessage.warning(`新口令至少 ${MIN_PASS} 位`);
    return;
  }
  if (rekey.next !== rekey.confirm) {
    ElMessage.warning('两次输入的新口令不一致');
    return;
  }
  rekey.busy = true;
  busy.value = true;
  try {
    const own = rows.value.filter((row) => row.nameCipher);
    const items: VaultRekeyItem[] = [];
    const params = newVaultParams();
    const minted = await mintSpaceSecret(rekey.next, params);
    for (let i = 0; i < own.length; i += 1) {
      const row = own[i];
      const nameCipher = row.nameCipher;
      if (!nameCipher) continue;
      progress.value = `重新封装 ${i + 1}/${own.length}`;
      const name = await decryptName(oldKey, nameCipher);
      const plain = await decryptBytes(oldKey, await vaultGetCipher(row));
      const nextCipher = await encryptBytes(minted.key, plain);
      items.push({
        id: row.id,
        nameCipher: await encryptName(minted.key, name),
        cipherSize: nextCipher.length,
        cipher: bytesToB64(nextCipher),
      });
    }
    status.value = await vaultRekey({
      salt: params.salt,
      iterations: params.iterations,
      verifier: minted.verifier,
      hint: rekey.hint.trim() || undefined,
      files: items,
    });
    key.value = minted.key;
    rekey.open = false;
    rekey.next = '';
    rekey.confirm = '';
    rekey.hint = '';
    await load();
    ElMessage.success(`口令已更换，${items.length} 条密文已重新封装`);
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    rekey.busy = false;
    busy.value = false;
    progress.value = '';
  }
}

/** 忘记口令时唯一的出路：整空间销毁，连口令参数一起作废 */
async function destroySpace(): Promise<void> {
  let value: string;
  try {
    const ack = await ElMessageBox.prompt(`输入「销毁」以确认：${entries.value} 条密文与口令一并作废，不可还原。`, '销毁整个空间', {
      inputPattern: /^销毁$/,
      inputErrorMessage: '请输入 销毁 两个字',
      type: 'warning',
      confirmButtonText: '确认销毁',
      cancelButtonText: '取消',
    });
    value = ack.value;
  } catch {
    return;
  }
  if (value.trim() !== '销毁') return;
  busy.value = true;
  try {
    const ack = await vaultDestroySpace();
    clearSecret();
    await applyOwner(null);
    ElMessage.success(`已销毁 ${ack.purged} 条密文，空间回到未初始化`);
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  owner.value = ownerFromQuery();
  await reload();
});

// 前进后退改的是查询串，这里只认变化，避免 applyOwner 自己 replace 后再拉一次
watch(
  () => route.query.owner,
  () => {
    const next = ownerFromQuery();
    if (next !== owner.value) {
      owner.value = next;
      void reload();
    }
  },
);
onBeforeUnmount(clearSecret);
</script>

<template>
  <section class="pk-vault">
    <header class="pk-vault__head">
      <div class="pk-vault__nav">
        <el-button size="small" @click="router.push('/drive')">返回网盘</el-button>
        <el-button size="small" :loading="loading" @click="reload">刷新</el-button>
        <el-breadcrumb separator="／" class="pk-vault__crumbs">
          <el-breadcrumb-item :to="{ path: '/drive' }">网盘</el-breadcrumb-item>
          <el-breadcrumb-item>加密空间</el-breadcrumb-item>
        </el-breadcrumb>
      </div>
      <div class="pk-vault__who">
        <span class="pk-muted">{{ session.displayName }}</span>
        <span v-if="viewingOther" class="pk-chip pk-chip--warn">他人空间：只读容量</span>
        <span v-else class="pk-chip" :class="unlocked ? 'pk-chip--ghost' : 'pk-chip--warn'">
          {{ unlocked ? '已解锁' : '已锁定' }}
        </span>
      </div>
    </header>

    <div v-if="isSuper" class="pk-vault__tabs">
      <button type="button" class="pk-vault-tab" :class="{ 'is-active': panel === 'space' }" @click="panel = 'space'">
        {{ viewingOther ? `成员 ${ownerParam} 的空间` : '我的空间' }}
      </button>
      <button type="button" class="pk-vault-tab" :class="{ 'is-active': panel === 'spaces' }" @click="panel = 'spaces'">
        成员空间总览
        <span class="pk-vault-tab__badge">{{ spaces.length }}</span>
      </button>
    </div>

    <div v-show="panel === 'space'" class="pk-vault__body">
      <div class="pk-vault__switch">
        <el-select v-if="isSuper" v-model="owner" size="small" class="pk-vault__owner" placeholder="我的空间" @change="pickOwner">
          <el-option label="我的空间" :value="0" />
          <el-option v-for="item in ownedSpaces" :key="item.uid" :label="`${item.nickname}（${item.levelName}）`" :value="item.uid" />
        </el-select>
        <span v-else class="pk-muted pk-vault__switch-hint">加密空间是自己的 private 档位，成员之间互相看不到。</span>
      </div>

      <p v-if="!nameSupported" class="pk-vault__alert">
        当前环境没有 WebCrypto，加密空间不可用：请用 HTTPS 或 localhost 打开（真加密依赖浏览器的 crypto.subtle）。
      </p>

      <div v-if="loading && !status" class="pk-card pk-vault__empty">正在读取空间状态…</div>

      <!-- 未初始化：向导 -->
      <div v-else-if="status && !status.initialized && !viewingOther" class="pk-card pk-vault__panel">
        <h3 class="pk-vault__title">初始化加密空间</h3>
        <p class="pk-vault__lede">
          口令在你这台设备上派生出 AES-256-GCM 密钥，文件名与内容都在本地加密后才上传；服务端只存密文、盐与校验子。{{ NO_RECOVERY }}
        </p>
        <div class="pk-vault__form">
          <el-input v-model="setup.pass" type="password" show-password placeholder="空间口令（至少 8 位）" />
          <el-input v-model="setup.confirm" type="password" show-password placeholder="再输一遍" />
          <el-input v-model="setup.hint" maxlength="60" placeholder="口令提示语（选填，只给你自己看，不构成恢复途径）" />
          <el-checkbox v-model="setup.agree">我已确认：{{ NO_RECOVERY }}</el-checkbox>
          <el-button type="primary" :loading="setup.busy" @click="submitSetup">生成密钥并初始化</el-button>
        </div>
        <p class="pk-muted pk-vault__tip">口令会先做一次 NFKC 归一，全角/半角写法视为同一串；大小写仍然敏感。</p>
      </div>

      <!-- 已初始化但没解锁 -->
      <div v-else-if="status && status.initialized && !unlocked && !viewingOther" class="pk-card pk-vault__panel">
        <h3 class="pk-vault__title">解锁加密空间</h3>
        <p class="pk-vault__lede">
          这个空间里有 {{ status.fileCount }} 个密文文件，合计 {{ formatBytes(status.cipherBytes) }}。
          {{ status.hint ? `提示语：${status.hint}` : '没有留提示语。' }}
        </p>
        <div class="pk-vault__form">
          <el-input
            v-model="unlockPass"
            type="password"
            show-password
            placeholder="输入空间口令"
            @keyup.enter="unlock"
          />
          <el-button type="primary" :loading="busy" @click="unlock">解锁</el-button>
        </div>
        <p v-if="status.demoTip" class="pk-muted pk-vault__tip">{{ status.demoTip }}</p>
        <p class="pk-muted pk-vault__tip">{{ NO_RECOVERY }}</p>
      </div>

      <!-- 概览 + 工作区 -->
      <template v-else-if="status">
        <div class="pk-card pk-vault__overview">
          <div class="pk-vault__stats">
            <div>
              <span class="pk-muted">条目</span>
              <strong>{{ status.fileCount }}</strong>
            </div>
            <div>
              <span class="pk-muted">密文体积</span>
              <strong>{{ formatBytes(status.cipherBytes) }}</strong>
            </div>
            <div>
              <span class="pk-muted">明文体积</span>
              <strong>{{ formatBytes(status.plainBytes) }}</strong>
            </div>
            <div>
              <span class="pk-muted">最近活动</span>
              <strong>{{ formatDate(status.lastActivity) }}</strong>
            </div>
          </div>
          <div class="pk-vault__quota">
            <el-progress :percentage="quotaPercent" :stroke-width="8" />
            <span class="pk-muted">已用 {{ formatBytes(status.used) }} / 配额 {{ formatBytes(status.quota) }}（密文体积计入配额）</span>
          </div>
        </div>

        <div v-if="viewingOther" class="pk-card pk-vault__panel">
          <div class="pk-vault__bar">
            <h3 class="pk-vault__title">只读容量视图</h3>
            <el-button size="small" @click="backToOwnSpace">回到我的空间</el-button>
          </div>
          <p class="pk-vault__lede">
            按 PRD 3.1 你可以删除他人的 private 资源，但这里只有体积和条数：文件名密文与密文字节都不下发，
            所以既看不到内容，也拿不到可用于离线爆破口令的素材。
          </p>
        </div>

        <div v-else class="pk-card pk-vault__panel">
          <div class="pk-vault__bar">
            <h3 class="pk-vault__title">我的密文</h3>
            <div class="pk-vault__actions">
              <el-button size="small" type="primary" :disabled="!unlocked" @click="openFilePicker">加密上传</el-button>
              <el-button size="small" :disabled="!unlocked" @click="rekey.open = true">修改口令</el-button>
              <el-button size="small" :disabled="!unlocked" @click="lock">锁定</el-button>
              <el-button size="small" type="danger" plain :disabled="!unlocked || transferring" @click="destroySpace">销毁全部密文</el-button>
            </div>
          </div>
          <input ref="fileInput" class="pk-vault__input" type="file" multiple @change="onFilePick" />
          <div
            class="pk-vault__drop"
            :class="{ 'is-over': dragOver }"
            @dragover.prevent="dragOver = true"
            @dragleave="dragOver = false"
            @drop.prevent="onDrop"
          >
            把文件拖到这里：浏览器先加密再提交，文件名与字节一起出网，落盘后缀统一为
            .{{ CIPHER_EXT }}{{ transferring ? ` · ${activeTasks.length} 个任务进行中` : '' }}
          </div>
          <p class="pk-muted pk-vault__tip">
            「下载加密文件」拿到的是未解密的密文容器（例：<code>原名.pdf.{{ CIPHER_EXT }}</code>），
            凭口令仍可再「解密下载」还原原名；容器恒比明文大 {{ CONTAINER_OVERHEAD }} 字节，配额按密文体积计。
          </p>
        </div>

        <!-- 本地加解密（D30）：只碰内存里的密钥，不入库、不占配额。类名同样避开 __title/__actions/__input 等读数契约 -->
        <div v-if="!viewingOther" class="pk-card pk-vault__tool">
          <div class="pk-vault__toolhead">
            <h4 class="pk-vault__tooltitle">本地加解密</h4>
            <div class="pk-vault__toolbtns">
              <el-button size="small" type="primary" plain @click="pickLocal('encrypt')">加密</el-button>
              <el-button size="small" @click="pickLocal('decrypt')">解密</el-button>
            </div>
          </div>
          <p class="pk-vault__toolnote">
            这对按钮只在你的浏览器里做事：选本地文件 → 用本空间口令派生的那把密钥加/解 → 结果直接交给浏览器落盘，
            <strong>不上传、不入库、不占配额</strong>，空间条目数一位不动。「加密」产出
            <code>原名.原扩展名.{{ CIPHER_EXT }}</code>，与「下载加密文件」拿到的是同一种容器，两边可互相搬运；
            「解密」吃的就是这种容器，落盘名去掉 <code>.{{ CIPHER_EXT }}</code> 还原原名
            （容器里不存文件名，名字只能从后缀还原）。口令仍是那一个空间口令：锁定之后或换到别人的空间都解不开。
          </p>
          <input
            ref="localEncryptInput"
            class="pk-vault__tool-input"
            type="file"
            multiple
            @change="onLocalPick($event, 'encrypt')"
          />
          <input
            ref="localDecryptInput"
            class="pk-vault__tool-input"
            type="file"
            multiple
            @change="onLocalPick($event, 'decrypt')"
          />
        </div>

        <!-- 传输队列：加密上传、两种下载与本地加解密共用一份进度（D29 / D30）。类名刻意避开 __title / __lede，见文件头注意 ⑤ -->
        <div v-if="tasks.length" class="pk-card pk-vault__queue">
          <div class="pk-vault__qhead">
            <span class="pk-vault__qtitle">传输进度</span>
            <span class="pk-muted">
              {{ activeTasks.length }} 进行中 · {{ doneTasks.length }} 已结束 · 加密文件后缀 .{{ CIPHER_EXT }}
            </span>
            <el-button size="small" :disabled="!doneTasks.length" @click="clearDone">清除已结束</el-button>
          </div>
          <ul class="pk-vault__qtasks">
            <li v-for="task in tasks" :key="task.key" class="pk-vault__qtask">
              <div class="pk-vault__qname">
                <strong>{{ task.label }}</strong>
                <span class="pk-muted" :class="{ 'pk-vault__qfail': task.state === '失败' }">
                  {{ task.state }} · {{ task.progress }}%
                </span>
              </div>
              <el-progress
                :percentage="task.progress"
                :stroke-width="6"
                :show-text="false"
                :status="task.state === '失败' ? 'exception' : task.state === '已完成' ? 'success' : undefined"
              />
              <span v-if="task.detail" class="pk-muted pk-vault__qdetail">{{ task.detail }}</span>
            </li>
          </ul>
        </div>

        <div class="pk-vault__grid">
          <article v-for="row in rows" :key="row.id" class="pk-card pk-vault__item">
            <div class="pk-vault__icon">
              <span>{{ badgeOf(row) }}</span>
            </div>
            <div class="pk-vault__text">
              <div class="pk-vault__line">
                <p class="pk-vault__name">{{ displayName(row) }}</p>
                <span
                  v-if="cipherNameOf(row)"
                  class="pk-vault__tag"
                  :title="`下载加密文件时保存为 ${cipherNameOf(row)}`"
                >
                  .{{ CIPHER_EXT }}
                </span>
              </div>
              <p class="pk-muted pk-vault__sub">
                密文 {{ formatBytes(row.size) }} · 明文 {{ formatBytes(row.plainSize) }} · {{ formatDate(row.createTime) }}
              </p>
            </div>
            <div class="pk-vault__ops">
              <el-button
                v-if="row.nameCipher"
                size="small"
                text
                :disabled="!unlocked || !row.links.cipher"
                :title="`保存未解密的密文容器，后缀 .${CIPHER_EXT}`"
                @click="download(row, 'cipher')"
              >
                下载加密文件
              </el-button>
              <el-button
                size="small"
                text
                :disabled="!unlocked || !row.links.cipher"
                :title="row.links.cipher ? '本地解密后保存' : '他人空间的密文不下发'"
                @click="download(row, 'plain')"
              >
                解密下载
              </el-button>
              <el-button
                v-if="row.canDelete"
                size="small"
                text
                type="danger"
                :disabled="busy || transferring"
                @click="removeOne(row)"
              >
                彻底删除
              </el-button>
            </div>
          </article>
          <p v-if="!rows.length" class="pk-muted pk-vault__empty">
            {{ status.initialized ? '这个空间还没有密文。' : '该成员还没设置口令，没有密文可管。' }}
          </p>
        </div>
      </template>
    </div>

    <!-- L4 成员空间总览 -->
    <div v-show="panel === 'spaces'" class="pk-card pk-vault__jobs">
      <p class="pk-vault__lede">
        到容量为止：这张表能看出谁占了多大地方、最近有没有动过，但解不开任何东西。
        点「查看」进入那位成员的只读视图，可逐条彻底删除（加密条目不进垃圾箱）。
      </p>
      <el-table :data="spaces" size="small">
        <el-table-column prop="nickname" label="成员" min-width="110" />
        <el-table-column prop="levelName" label="等级" width="70" />
        <el-table-column label="口令" width="90">
          <template #default="{ row }">
            <span class="pk-chip" :class="row.initialized ? 'pk-chip--ghost' : 'pk-chip--warn'">
              {{ row.initialized ? '已设' : '未初始化' }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="fileCount" label="条目" width="70" />
        <el-table-column label="密文体积" width="110">
          <template #default="{ row }">{{ formatBytes(row.cipherBytes) }}</template>
        </el-table-column>
        <el-table-column label="最近活动" min-width="140">
          <template #default="{ row }">{{ formatDate(row.lastActivity) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="90">
          <template #default="{ row }">
            <el-button size="small" text :disabled="row.uid === myUid" @click="viewSpace(row.uid)">查看</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="rekey.open" title="修改空间口令" width="440px">
      <p class="pk-vault__lede">
        换口令要用旧密钥把 {{ entries }} 条密文逐条解开、再用新密钥逐条封好，最后一次性提交——
        中途失败也不会留下「空间是新密钥、某条还是旧密钥」的永久不可读状态。
      </p>
      <div class="pk-vault__form">
        <el-input v-model="rekey.next" type="password" show-password placeholder="新口令（至少 8 位）" />
        <el-input v-model="rekey.confirm" type="password" show-password placeholder="再输一遍" />
        <el-input v-model="rekey.hint" maxlength="60" placeholder="新的提示语（选填）" />
      </div>
      <p class="pk-muted pk-vault__tip">{{ NO_RECOVERY }}</p>
      <template #footer>
        <el-button :disabled="rekey.busy" @click="rekey.open = false">取消</el-button>
        <el-button type="primary" :loading="rekey.busy" @click="submitRekey">
          {{ rekey.busy ? progress || '重新封装中…' : '开始重封并提交' }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.pk-vault__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}

.pk-vault__nav {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.pk-vault__crumbs {
  font-size: 13px;
  margin-left: 4px;
}

.pk-vault__who {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.pk-vault__tabs {
  display: flex;
  gap: 4px;
  margin: 14px 0 12px;
  border-bottom: 1px solid var(--pk-line);
}

.pk-vault-tab {
  border: 0;
  background: none;
  padding: 8px 14px;
  font-size: 14px;
  color: var(--pk-muted);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.pk-vault-tab.is-active {
  color: var(--pk-brand);
  border-bottom-color: var(--pk-brand);
  font-weight: 600;
}

.pk-vault-tab__badge {
  background: var(--pk-brand-soft);
  color: var(--pk-brand);
  border-radius: 9px;
  font-size: 11px;
  padding: 0 6px;
  line-height: 16px;
}

.pk-vault__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.pk-vault__switch {
  display: flex;
  align-items: center;
  gap: 10px;
}

.pk-vault__owner {
  width: 200px;
}

.pk-vault__switch-hint {
  font-size: 12px;
}

.pk-vault__alert {
  margin: 0;
  font-size: 13px;
  color: #b42318;
}

.pk-vault__panel {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pk-vault__title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
}

.pk-vault__lede {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--pk-muted);
}

.pk-vault__form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 460px;
}

.pk-vault__tip {
  font-size: 12px;
  margin: 0;
  line-height: 1.6;
}

.pk-vault__overview {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pk-vault__stats {
  display: flex;
  gap: 22px;
  flex-wrap: wrap;
  font-size: 13px;
}

.pk-vault__stats div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pk-vault__quota {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}

.pk-vault__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.pk-vault__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.pk-vault__input {
  display: none;
}

.pk-vault__drop {
  border: 1px dashed var(--pk-line);
  border-radius: 10px;
  padding: 14px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--pk-muted);
  text-align: center;
}

.pk-vault__drop.is-over {
  border-color: var(--pk-brand);
  background: var(--pk-brand-soft);
  color: var(--pk-brand);
}

.pk-vault__tool {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pk-vault__toolhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.pk-vault__tooltitle {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
}

.pk-vault__toolbtns {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.pk-vault__toolnote {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--pk-muted);
}

.pk-vault__tool-input {
  display: none;
}

.pk-vault__queue {
  padding: 12px 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pk-vault__qhead {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
}

.pk-vault__qtitle {
  font-size: 14px;
  font-weight: 700;
}

.pk-vault__qhead .el-button {
  margin-left: auto;
}

.pk-vault__qtasks {
  list-style: none;
  margin: 0;
  padding: 0;
}

.pk-vault__qtask {
  padding: 9px 0;
  border-top: 1px solid var(--pk-line);
}

.pk-vault__qname {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
  margin-bottom: 6px;
}

.pk-vault__qname strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pk-vault__qdetail {
  font-size: 12px;
  display: block;
  margin-top: 4px;
  line-height: 1.6;
}

.pk-vault__qfail {
  color: #d64545;
}

.pk-vault__line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.pk-vault__line .pk-vault__name {
  min-width: 0;
}

.pk-vault__tag {
  flex: none;
  font-size: 11px;
  letter-spacing: 0.5px;
  color: var(--pk-brand);
  background: var(--pk-brand-soft);
  border-radius: 6px;
  padding: 1px 6px;
}

.pk-vault__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 10px;
}

.pk-vault__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
}

.pk-vault__icon {
  width: 42px;
  height: 42px;
  border-radius: 10px;
  background: var(--pk-brand-soft);
  color: var(--pk-brand);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  letter-spacing: 1px;
  flex: none;
}

.pk-vault__text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.pk-vault__name {
  margin: 0;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pk-vault__sub {
  margin: 0;
  font-size: 12px;
}

.pk-vault__ops {
  margin-left: auto;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  flex: none;
}

.pk-vault__jobs {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
}

.pk-vault__empty {
  grid-column: 1 / -1;
  padding: 16px;
  font-size: 13px;
  line-height: 1.8;
}

@media (max-width: 640px) {
  .pk-vault__grid {
    grid-template-columns: 1fr;
  }

  .pk-vault__owner {
    width: 100%;
  }
}
</style>
