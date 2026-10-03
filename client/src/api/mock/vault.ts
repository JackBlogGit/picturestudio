/**
 * 加密空间的 mock（PRD 5.7 / D26）。
 *
 * 这一层刻意不做任何加解密：口令派生、文件名加密、字节加密全在浏览器里完成（见 utils/crypto.ts），
 * mock 只存盐与校验子、存密文容器、按档位决定谁能看到哪一列。
 * 于是「关掉 mock 接真后端」时页面代码不用改，「换一台服务器」时也照样解不开别人的空间。
 *
 * 闸门：
 * - 游客 401、临时账号 403（D19：手敲 /drive/encrypted 回 403）
 * - L1–L4 各有自己的空间，成员互相看不到（D1：他人 private 一律 404，不暴露存在性）
 * - L4 能看到他人空间的条目数与容量并按 3.1 彻底删除，但**拿不到文件名密文，也拿不到密文字节**
 *   ——不给「档位带来的删除权」顺手扩成「离线爆破口令的素材」
 * - 删除即就地销毁，不进垃圾箱：垃圾箱是超管的明文清单，混进一串密文条目只会让人误读
 * - 密文体积计入 used_space（5.6 的「含 private」同样适用）
 *
 * 注意：库存在**模块内存**里，整页刷新连演示数据一起重置——这是全站 mock 的既有行为，
 * 故意**不**给这一个模块单独开持久化（会让「刷新即丢」的口径在别处失真）。演示密文由 `ensureSeeded()`
 * 异步**真的**跑一遍加密生成（不是塞字符串），所以首次请求略慢；`DEMO_PASS` 只活在 mock 里，
 * 真后端连「口令」这个概念都不存，关掉 mock 后页面上的演示口令提示也随之消失。
 */
import type { VaultFileView, VaultSpaceRow, VaultStatus } from '@/types/api';
import { UserLevel } from '@/types/api';
import { b64ToBytes, bytesToB64, deriveVaultKey, encryptBytes, encryptName, makeVerifier, newVaultParams } from '@/utils/crypto';
import type { Actor, MemberActor } from './policy';
import { API, fail, int, requireMember, str } from './shared';
import { USERS, quotaOwner } from './db';
import { settingList, settingNumber } from './tables';
import { writeLog } from './admin';

/** 演示库的预置口令：真接口根本不存口令，这一行只活在 mock 里 */
const DEMO_PASS = 'demo-vault';
const DEMO_TIP = `演示库预置口令 ${DEMO_PASS}（关掉 mock 后不存在这一说）`;

interface VaultSpace {
  uid: number;
  salt: string;
  iterations: number;
  verifier: string;
  hint: string;
  createTime: string;
  lastActivity: string;
}

interface VaultRow {
  id: number;
  uid: number;
  nameCipher: string;
  size: number;
  plainSize: number;
  mimeType: string;
  createTime: string;
}

const VAULT_SPACES = new Map<number, VaultSpace>();
const VAULT_ROWS: VaultRow[] = [];
/** 条目 id → 密文容器字节；服务端视角下这就是一团不可解的字节 */
const VAULT_BYTES = new Map<number, Uint8Array>();

let rowSeq = 0;

const rowsOf = (uid: number): VaultRow[] => VAULT_ROWS.filter((r) => r.uid === uid);

/**
 * 演示种子：把几条合同／收据**真的**用演示口令加密一遍，
 * 这样列表里的文件名与下载回来的字节都出自同一套内核，解密链路是被实测过的，不是装的。
 * 小满（L1）故意不设口令，用来走初始化向导。
 */
const SEED_PLAN: { uid: number; files: { name: string; body: string; mime: string }[] }[] = [
  {
    uid: 1,
    files: [
      { name: '摊位合同-CP29-夜刃签署.pdf', body: '摊位编号 B12，费用 1,800 元，甲方签署人：夜刃。\n', mime: 'application/pdf' },
      { name: '工作室分红比例-2026.txt', body: '场照 40% / 精修 35% / 后期 25%，按月结算。\n', mime: 'text/plain' },
    ],
  },
  {
    uid: 2,
    files: [{ name: '柚子-雷电将军-源稿分层说明.txt', body: '图层分组：底色／皮肤／毛发／装甲／特效，全部保留智能对象。\n', mime: 'text/plain' }],
  },
  {
    uid: 3,
    files: [
      { name: '柯柯-约稿定金收据.txt', body: '定金 300 元，2026-09-13 收讫，交付 20 张。\n', mime: 'text/plain' },
      { name: 'CP29-出摊排班-内部.txt', body: '周六 09:00 夜刃·阿澄，14:00 白泽·小满。\n', mime: 'text/plain' },
    ],
  },
];

let seeding: Promise<void> | null = null;

async function ensureSeeded(): Promise<void> {
  seeding ??= (async () => {
    for (const plan of SEED_PLAN) {
      const user = USERS.find((u) => u.uid === plan.uid);
      if (!user || VAULT_SPACES.has(plan.uid)) continue;
      const params = newVaultParams();
      const key = await deriveVaultKey(DEMO_PASS, params);
      const now = new Date().toISOString();
      VAULT_SPACES.set(plan.uid, {
        uid: plan.uid,
        salt: params.salt,
        iterations: params.iterations,
        verifier: await makeVerifier(key),
        hint: '四个字的展会名',
        createTime: now,
        lastActivity: now,
      });
      for (const file of plan.files) {
        const cipher = await encryptBytes(key, new TextEncoder().encode(file.body));
        rowSeq += 1;
        VAULT_BYTES.set(rowSeq, cipher);
        VAULT_ROWS.push({
          id: rowSeq,
          uid: plan.uid,
          nameCipher: await encryptName(key, file.name),
          size: cipher.length,
          plainSize: new TextEncoder().encode(file.body).length,
          mimeType: file.mime,
          createTime: now,
        });
        // 密文体积计入本人配额，与 5.6「含 private」同口径
        user.usedSpace += cipher.length;
      }
    }
  })();
  await seeding;
}

function statusOf(uid: number): VaultStatus {
  const user = USERS.find((u) => u.uid === uid);
  const space = VAULT_SPACES.get(uid);
  const rows = rowsOf(uid);
  return {
    initialized: !!space,
    salt: space?.salt ?? null,
    iterations: space?.iterations ?? 0,
    verifier: space?.verifier ?? null,
    hint: space?.hint ?? '',
    fileCount: rows.length,
    cipherBytes: rows.reduce((s, r) => s + r.size, 0),
    plainBytes: rows.reduce((s, r) => s + r.plainSize, 0),
    quota: user?.spaceQuota ?? 0,
    used: user?.usedSpace ?? 0,
    createTime: space?.createTime ?? null,
    lastActivity: space?.lastActivity ?? null,
    demoTip: space ? DEMO_TIP : null,
  };
}

function viewOf(row: VaultRow, self: boolean, level: UserLevel): VaultFileView {
  return {
    id: row.id,
    // 他人空间：只给容量与删除权，文件名密文和密文字节都不下发
    nameCipher: self ? row.nameCipher : null,
    size: row.size,
    plainSize: row.plainSize,
    mimeType: row.mimeType,
    createTime: row.createTime,
    links: { cipher: self ? `${API}/vault/files/${row.id}/cipher` : null },
    canDelete: self || level >= UserLevel.SuperAdmin,
  };
}

/** 目标空间：本人永远可以；他人只有超管可以，且只到「容量 + 删除」为止 */
function targetOf(member: MemberActor, requested?: string): { uid: number; self: boolean } {
  if (!requested) return { uid: member.uid, self: true };
  const uid = Number(requested);
  if (uid === member.uid) return { uid, self: true };
  // L1–L3 查他人的 private：按 D1 回 404，不暴露这个空间是否存在
  if (member.level < UserLevel.SuperAdmin) fail(404, 'NOT_FOUND', '该加密空间不存在或无权查看');
  return { uid, self: false };
}

export async function vaultStatus(query: Record<string, unknown> | undefined, actor: Actor): Promise<VaultStatus> {
  const member = requireMember(actor);
  await ensureSeeded();
  const { uid, self } = targetOf(member, str(query?.owner));
  if (!self) writeLog(actor, 'vault_admin_view', 'vault', uid, `查看成员 ${uid} 加密空间汇总（仅容量，无文件名与密文）`);
  return statusOf(uid);
}

export async function vaultList(query: Record<string, unknown> | undefined, actor: Actor): Promise<VaultFileView[]> {
  const member = requireMember(actor);
  await ensureSeeded();
  const { uid, self } = targetOf(member, str(query?.owner));
  return rowsOf(uid).map((row) => viewOf(row, self, member.level));
}

/** 设口令：派生与校验子都在前端做完，这里只落参数，口令本身从不出现 */
export async function vaultSetup(body: Record<string, unknown>, actor: Actor): Promise<VaultStatus> {
  const member = requireMember(actor);
  await ensureSeeded();
  if (VAULT_SPACES.has(member.uid)) fail(409, 'VAULT_EXISTS', '本空间已设过口令，要换口令请走「修改口令」');

  const salt = str(body.salt);
  const verifier = str(body.verifier);
  const iterations = int(body.iterations, 0);
  if (!salt || !verifier || iterations < 10_000) fail(400, 'VALIDATION_FAILED', 'salt / verifier / iterations 均必填');

  const now = new Date().toISOString();
  VAULT_SPACES.set(member.uid, {
    uid: member.uid,
    salt,
    iterations,
    verifier,
    hint: String(body.hint ?? '').slice(0, 60),
    createTime: now,
    lastActivity: now,
  });
  writeLog(actor, 'vault_setup', 'vault', member.uid, `iterations=${iterations}`);
  return statusOf(member.uid);
}

/**
 * 改口令：**一次请求带走全部重封好的条目**，原子换密钥。
 * 拆成「先换参数、再逐条重传」会出现空间已是新密钥而某条密文还是旧密钥的中间态，
 * 那条就永久解不出来了——所以这里先逐条校验并落库，最后一步才替换派生参数。
 */
export async function vaultRekey(body: Record<string, unknown>, actor: Actor): Promise<VaultStatus> {
  const member = requireMember(actor);
  await ensureSeeded();
  const space = VAULT_SPACES.get(member.uid);
  if (!space) fail(409, 'VAULT_NOT_INITIALIZED', '本空间还没设口令，无需修改');

  const salt = str(body.salt);
  const verifier = str(body.verifier);
  const iterations = int(body.iterations, 0);
  if (!salt || !verifier || iterations < 10_000) fail(400, 'VALIDATION_FAILED', 'salt / verifier / iterations 均必填');

  const files = Array.isArray(body.files) ? (body.files as Record<string, unknown>[]) : [];
  const own = rowsOf(member.uid);
  if (files.length !== own.length) {
    fail(409, 'REKEY_SET_MISMATCH', `本空间有 ${own.length} 条密文，必须整份重封后一并提交（收到 ${files.length} 条）`);
  }

  // 第一遍：只校验不改数据，任何一条有问题都在此拦下
  const staged = files.map((item) => {
    const id = int(item.id, 0);
    const row = own.find((r) => r.id === id);
    if (!row) fail(404, 'NOT_FOUND', `条目 ${id} 不属于本空间`);
    const nameCipher = str(item.nameCipher);
    const cipherB64 = str(item.cipher);
    const cipherSize = int(item.cipherSize, 0);
    if (!nameCipher || !cipherB64 || cipherSize < 1) fail(400, 'VALIDATION_FAILED', 'id / nameCipher / cipher / cipherSize 均必填');
    const bytes = b64ToBytes(cipherB64);
    if (bytes.length !== cipherSize) fail(400, 'CIPHER_SIZE_MISMATCH', `条目 ${id} 密文实际 ${bytes.length} 字节，与登记的 ${cipherSize} 不符`);
    return { row, id, nameCipher, bytes, cipherSize };
  });

  const owner = quotaOwner(actor);
  const delta = staged.reduce((s, item) => s + item.bytes.length, 0) - own.reduce((s, r) => s + r.size, 0);
  if (owner && delta > 0 && owner.quota > 0 && owner.used + delta > owner.quota) {
    fail(413, 'QUOTA_EXCEEDED', `重新加密后超出配额，已用 ${owner.used} / 配额 ${owner.quota}`);
  }

  // 第二遍：全部落库并换密钥，配额按总体差值调整
  for (const item of staged) {
    VAULT_BYTES.set(item.id, item.bytes);
    item.row.nameCipher = item.nameCipher;
    item.row.size = item.cipherSize;
  }
  if (owner && delta !== 0) (delta > 0 ? owner.add(delta) : owner.release(-delta));
  space.salt = salt;
  space.iterations = iterations;
  space.verifier = verifier;
  if (body.hint !== undefined) space.hint = String(body.hint).slice(0, 60);
  space.lastActivity = new Date().toISOString();
  writeLog(actor, 'vault_rekey', 'vault', member.uid, `iterations=${iterations} restamped=${staged.length}`);
  return statusOf(member.uid);
}

export async function vaultUpload(body: Record<string, unknown>, actor: Actor): Promise<VaultFileView> {
  const member = requireMember(actor);
  await ensureSeeded();
  const space = VAULT_SPACES.get(member.uid);
  if (!space) fail(409, 'VAULT_NOT_INITIALIZED', '请先设置口令再上传');

  const nameCipher = str(body.nameCipher);
  const cipherSize = int(body.cipherSize, 0);
  const plainSize = int(body.plainSize, 0);
  const cipherB64 = str(body.cipher);
  if (!nameCipher || cipherSize < 1 || plainSize < 1) fail(400, 'VALIDATION_FAILED', 'nameCipher / cipherSize / plainSize 必填且为正整数');
  if (!cipherB64) fail(400, 'CIPHER_MISSING', '密文未送达，请重试上传');
  let bytes: Uint8Array;
  try {
    bytes = b64ToBytes(cipherB64);
  } catch {
    fail(400, 'CIPHER_MALFORMED', '密文不是合法的 base64 容器');
  }
  if (bytes.length !== cipherSize) fail(400, 'CIPHER_SIZE_MISMATCH', `密文实际 ${bytes.length} 字节，与登记的 ${cipherSize} 不符`);

  // 密文不是绕过 5.2 黑名单的通道：扩展名照旧判
  const ext = `.${String(body.ext ?? '').toLowerCase()}`;
  if (ext !== '.' && settingList('upload.blocked_extensions').includes(ext)) {
    fail(415, 'EXTENSION_BLOCKED', `加密空间同样禁止 ${ext} 类型`);
  }

  const maxPlain = settingNumber('vault.max_file_size');
  if (maxPlain > 0 && plainSize > maxPlain) {
    fail(413, 'FILE_TOO_LARGE', `加密空间单文件上限 ${Math.round(maxPlain / 1048576)}MB，当前 ${plainSize} 字节`);
  }

  const owner = quotaOwner(actor);
  if (owner && owner.quota > 0 && owner.used + cipherSize > owner.quota) {
    fail(413, 'QUOTA_EXCEEDED', `空间不足，已用 ${owner.used} / 配额 ${owner.quota}，本次需要 ${cipherSize}`, {
      used: owner.used,
      quota: owner.quota,
      need: cipherSize,
    });
  }

  rowSeq += 1;
  const now = new Date().toISOString();
  const row: VaultRow = {
    id: rowSeq,
    uid: member.uid,
    nameCipher,
    size: cipherSize,
    plainSize,
    mimeType: String(body.mimeType ?? ''),
    createTime: now,
  };
  VAULT_ROWS.push(row);
  VAULT_BYTES.set(rowSeq, bytes);
  owner?.add(cipherSize);
  space.lastActivity = now;
  // 审计里只有体积，没有任何能还原内容的线索
  writeLog(actor, 'vault_upload', 'vault_file', rowSeq, `cipher=${cipherSize} plain=${plainSize}`);
  return viewOf(row, true, member.level);
}

/** 取回密文：只有归属人本人拿得到，超管对他人条目被拒（PRD 5.7 的离线爆破闸门） */
export async function vaultCipher(id: number, actor: Actor): Promise<{ cipher: string }> {
  const member = requireMember(actor);
  await ensureSeeded();
  const row = VAULT_ROWS.find((r) => r.id === id);
  if (!row || row.uid !== member.uid) fail(404, 'NOT_FOUND', '条目不存在或无权取回密文');
  const bytes = VAULT_BYTES.get(id);
  if (!bytes) fail(410, 'CIPHER_LOST', '条目在表里却没有密文容器，mock 内部状态不一致，请刷新后重试');
  return { cipher: bytesToB64(bytes) };
}

/** 删除：就地销毁，不进垃圾箱（PRD 5.7） */
export function vaultDelete(id: number, actor: Actor): { id: number; purged: true } {
  const member = requireMember(actor);
  const index = VAULT_ROWS.findIndex((r) => r.id === id);
  if (index < 0) fail(404, 'NOT_FOUND', '条目不存在');
  const row = VAULT_ROWS[index];
  if (row.uid !== member.uid && member.level < UserLevel.SuperAdmin) {
    fail(404, 'NOT_FOUND', '条目不存在或无权删除');
  }
  VAULT_ROWS.splice(index, 1);
  VAULT_BYTES.delete(id);
  releaseQuota(row, actor);
  writeLog(
    actor,
    'vault_delete',
    'vault_file',
    id,
    row.uid === member.uid
      ? `cipher=${row.size}（就地销毁，无还原）`
      : `他人空间 uid=${row.uid} cipher=${row.size}（超管就地销毁，无还原）`,
  );
  return { id, purged: true };
}

/** 配额归还：本人的走 quotaOwner，超管代删要退到条目属主头上 */
function releaseQuota(row: VaultRow, actor: Actor): void {
  if (actor.kind === 'member' && actor.uid === row.uid) {
    quotaOwner(actor)?.release(row.size);
    return;
  }
  const user = USERS.find((u) => u.uid === row.uid);
  if (user) user.usedSpace = Math.max(0, user.usedSpace - row.size);
}

/** 忘记口令的唯一出路：整空间销毁，口令与派生参数一并作废 */
export function vaultDestroy(actor: Actor): { uid: number; purged: number } {
  const member = requireMember(actor);
  const rows = rowsOf(member.uid);
  for (const row of rows) {
    VAULT_BYTES.delete(row.id);
    releaseQuota(row, actor);
  }
  for (const row of rows) VAULT_ROWS.splice(VAULT_ROWS.indexOf(row), 1);
  VAULT_SPACES.delete(member.uid);
  writeLog(actor, 'vault_destroy', 'vault', member.uid, `purged=${rows.length} 口令与派生参数一并作废`);
  return { uid: member.uid, purged: rows.length };
}

/** L4 的成员空间总览：到容量为止，解不开任何东西 */
export async function vaultSpaces(actor: Actor): Promise<VaultSpaceRow[]> {
  const member = requireMember(actor);
  if (member.level < UserLevel.SuperAdmin) fail(403, 'LEVEL_FORBIDDEN', '仅超管可查看成员的加密空间总览');
  await ensureSeeded();
  return USERS.filter((u) => !u.disabled).map((u) => {
    const rows = rowsOf(u.uid);
    const space = VAULT_SPACES.get(u.uid);
    return {
      uid: u.uid,
      nickname: u.nickname,
      position: u.position,
      levelName: `L${u.level}`,
      initialized: !!space,
      fileCount: rows.length,
      cipherBytes: rows.reduce((s, r) => s + r.size, 0),
      lastActivity: space?.lastActivity ?? null,
      canPurge: u.uid !== member.uid,
    };
  });
}
