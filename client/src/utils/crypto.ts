/**
 * 加密空间的客户端内核（PRD 5.7 / D26）。
 *
 * 口令在浏览器里经 PBKDF2-SHA256 派生出 AES-256-GCM 密钥，文件名与字节都在本地加密后才出网，
 * 服务端只见密文、盐与 IV。因此「忘记口令」没有任何后门可走：超管与后端都解不开，
 * 唯一的出路是销毁本空间全部密文重建。
 *
 * 容器格式：`[版本 1B][IV 12B][密文 + GCM 标签 16B]`。盐与迭代次数随空间存一份，不进每个容器。
 * 同一条密钥派生三个用途（文件名 / 字节 / 口令校验子），靠 GCM 的 AAD 做域分离，
 * 免得把「文件名的密文」当成内容密文来解。
 */

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/** OWASP 对 PBKDF2-HMAC-SHA256 的推荐轮次；实测浏览器单次派生约 0.2s，解锁不至于卡顿 */
export const KDF_ITERATIONS = 210_000;

const AAD_NAME = 'pikevault.name';
const AAD_BLOB = 'pikevault.blob';
const AAD_CHECK = 'pikevault.check';
const CHECK_TEXT = 'pikevault/check';

export type VaultKey = CryptoKey;

export interface VaultParams {
  salt: string;
  iterations: number;
}

function subtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error('当前环境不支持 WebCrypto（需要 HTTPS 或 localhost 才能使用加密空间）');
  }
  return globalThis.crypto.subtle;
}

/** 密文容器在 JSON 契约里以 base64 往返（真接口按 raw octet-stream 传，不占这一道） */
export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function b64ToBytes(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** 口令里的大小写与输入法全/半角都算不同口令，这里只做一次 NFKC 归一，别的都不动 */
function normalize(pass: string): string {
  return pass.normalize('NFKC');
}

export function newVaultParams(): VaultParams {
  const salt = new Uint8Array(SALT_BYTES);
  globalThis.crypto.getRandomValues(salt);
  return { salt: bytesToB64(salt), iterations: KDF_ITERATIONS };
}

export async function deriveVaultKey(pass: string, params: VaultParams): Promise<VaultKey> {
  const secret = normalize(pass);
  if (!secret) throw new Error('口令不能为空');
  const salt = b64ToBytes(params.salt);
  const base = await subtle().importKey('raw', new TextEncoder().encode(secret) as BufferSource, 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: params.iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: KEY_BYTES * 8 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function iv(): Uint8Array {
  const bytes = new Uint8Array(IV_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * TS 6 的 DOM 库把 WebCrypto 入参收到 `ArrayBufferView<ArrayBuffer>` 这一档，
 * 而 `TextEncoder.encode` 与 `Uint8Array.subarray` 的返回类型是 `ArrayBufferLike` 后端
 * （理论上可能是 SharedArrayBuffer）。这里的字节全部由本模块自己新建，不存在共享缓冲，
 * 所以只在这一道边界上做类型收敛，不改数据。
 */
function view(bytes: Uint8Array): BufferSource {
  return bytes as BufferSource;
}

async function seal(key: VaultKey, plain: Uint8Array, aad: string): Promise<Uint8Array> {
  const nonce = iv();
  const body = await subtle().encrypt(
    { name: 'AES-GCM', iv: view(nonce), additionalData: view(new TextEncoder().encode(aad)), tagLength: TAG_BYTES * 8 },
    key,
    view(plain),
  );
  const out = new Uint8Array(1 + IV_BYTES + body.byteLength);
  out[0] = VERSION;
  out.set(nonce, 1);
  out.set(new Uint8Array(body), 1 + IV_BYTES);
  return out;
}

async function open(key: VaultKey, container: Uint8Array, aad: string): Promise<Uint8Array> {
  if (container.length < 1 + IV_BYTES + TAG_BYTES) throw new Error('密文容器不完整');
  if (container[0] !== VERSION) throw new Error(`不支持的容器版本 ${container[0]}`);
  const plain = await subtle().decrypt(
    {
      name: 'AES-GCM',
      iv: view(container.subarray(1, 1 + IV_BYTES)),
      additionalData: view(new TextEncoder().encode(aad)),
      tagLength: TAG_BYTES * 8,
    },
    key,
    view(container.subarray(1 + IV_BYTES)),
  );
  return new Uint8Array(plain);
}

/** 文件名字节级加密：服务端与超管拿到的都是一串 base64 密文 */
export async function encryptName(key: VaultKey, name: string): Promise<string> {
  return bytesToB64(await seal(key, new TextEncoder().encode(name), AAD_NAME));
}

export async function decryptName(key: VaultKey, nameCipher: string): Promise<string> {
  return new TextDecoder().decode(await open(key, b64ToBytes(nameCipher), AAD_NAME));
}

export async function encryptBytes(key: VaultKey, bytes: Uint8Array): Promise<Uint8Array> {
  return seal(key, bytes, AAD_BLOB);
}

export async function decryptBytes(key: VaultKey, container: Uint8Array): Promise<Uint8Array> {
  return open(key, container, AAD_BLOB);
}

/** 口令校验子：加密一个已知串，解锁时能解开就算口令对，服务端无从反推口令 */
export async function makeVerifier(key: VaultKey): Promise<string> {
  return bytesToB64(await seal(key, new TextEncoder().encode(CHECK_TEXT), AAD_CHECK));
}

export async function checkVerifier(key: VaultKey, verifier: string): Promise<boolean> {
  try {
    return new TextDecoder().decode(await open(key, b64ToBytes(verifier), AAD_CHECK)) === CHECK_TEXT;
  } catch {
    return false;
  }
}

/** 派生 + 校验子成对生成，初始化与改口令都走它 */
export async function mintSpaceSecret(pass: string, params: VaultParams): Promise<{ key: VaultKey; verifier: string }> {
  const key = await deriveVaultKey(pass, params);
  return { key, verifier: await makeVerifier(key) };
}
