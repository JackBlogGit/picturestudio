#!/usr/bin/env node
// 皮克社 · 文件/文件夹双层加密器
// 内层 ChaCha20-Poly1305（口令A）→ 外层 AES-256-GCM（口令B），两把口令各自独立 scrypt 派生。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAGIC = Buffer.from("PKVAULTD", "ascii");
const VERSION = 2;
const KDF = { id: 1, N: 1 << 15, r: 8, p: 1 };
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const INNER = "chacha20-poly1305";
const OUTER = "aes-256-gcm";
const HEADER_LEN = MAGIC.length + 3 + 12 + SALT_LEN * 2 + IV_LEN * 2;
// 明文流 = 清单 + 文件内容，其末尾追加内层 tag，整条流再被外层加密；文件末尾只有外层 tag。
const FILE_TRAILER_LEN = TAG_LEN;
const EXT = ".pkv";
const CHUNK = 1 << 20;

type Entry = {
  name: string;
  type: "file" | "dir";
  size: number;
  mtimeMs: number;
};

type Header = {
  bytes: Buffer;
  saltA: Buffer;
  saltB: Buffer;
  ivA: Buffer;
  ivB: Buffer;
};

type Args = {
  cmd: string;
  rest: string[];
  out?: string;
  dest?: string;
  pass1?: string;
  pass2?: string;
  force: boolean;
};

function die(msg: string): never {
  console.error(`错误：${msg}`);
  process.exit(1);
}

function usage(): never {
  console.log(`皮克社双层加密器（${INNER} → ${OUTER}）

用法：
  node vault.ts enc <文件或文件夹>... [-o 输出${EXT}]        加密打包
  node vault.ts dec <${EXT} 文件> [-d 输出目录] [--force]     解密并还原目录树
  node vault.ts list <${EXT} 文件>                            列出包内条目
  node vault.ts verify <${EXT} 文件>                          校验口令与完整性

口令来源：-p1/-p2 > 环境变量 PKV_PASS1/PKV_PASS2 > 交互式输入（不回显）。
两层口令相互独立，缺一不可；文件或密码被篡改时两层都会校验失败。`);
  process.exit(0);
}

function parseArgs(argv: string[]): Args {
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help") usage();
  const args: Args = { cmd, rest: [], force: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(`参数 ${a} 缺少值`);
      return v as string;
    };
    if (a === "-o" || a === "--out") args.out = next();
    else if (a === "-d" || a === "--dest") args.dest = next();
    else if (a === "-p1" || a === "--pass1") args.pass1 = next();
    else if (a === "-p2" || a === "--pass2") args.pass2 = next();
    else if (a === "-f" || a === "--force") args.force = true;
    else if (a.startsWith("-")) die(`未知参数 ${a}`);
    else args.rest.push(a);
  }
  if (cmd === "enc" && args.rest.length === 0) die("enc 需要至少一个待加密路径");
  if (cmd !== "enc" && args.rest.length !== 1) die(`${cmd} 需要一个 ${EXT} 文件路径`);
  return args;
}

const pipedLines: string[] = [];
const pipedWaiters: ((line: string | null) => void)[] = [];
let pipedBuffer = "";
let pipedEnded = false;
let pipedAttached = false;

function attachPipedStdin(): void {
  if (pipedAttached) return;
  pipedAttached = true;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    pipedBuffer += chunk;
    for (;;) {
      const i = pipedBuffer.indexOf("\n");
      if (i < 0) break;
      const line = pipedBuffer.slice(0, i).replace(/\r$/, "");
      pipedBuffer = pipedBuffer.slice(i + 1);
      const waiter = pipedWaiters.shift();
      if (waiter) waiter(line);
      else pipedLines.push(line);
    }
  });
  process.stdin.on("end", () => {
    pipedEnded = true;
    for (const waiter of pipedWaiters.splice(0)) waiter(null);
  });
}

function readPipedLine(): Promise<string | null> {
  attachPipedStdin();
  const queued = pipedLines.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  if (pipedEnded) return Promise.resolve(null);
  return new Promise((resolve) => pipedWaiters.push(resolve));
}

function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      readPipedLine().then((line) => {
        if (line === null) reject(new Error("标准输入已关闭，无法读取口令"));
        else resolve(line);
      });
      return;
    }
    process.stdout.write(question);
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const stop = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    function onData(buf: Buffer) {
      for (const ch of buf.toString("utf8")) {
        const code = ch.codePointAt(0) ?? 0;
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          stop();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          stop();
          process.stdout.write("\n");
          reject(new Error("已取消"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (code >= 32 && code !== 127) value += ch;
      }
    }
    process.stdin.on("data", onData);
  });
}

async function readPass(label: string, flag: string | undefined, env: string): Promise<string> {
  const pw = flag ?? process.env[env] ?? (await askHidden(`请输入${label}口令（不回显）: `));
  if (!pw) die(`${label}口令不能为空`);
  return pw.normalize("NFKC");
}

function derive(pw: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      pw,
      salt,
      KEY_LEN,
      { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 512 << 20 },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

function buildHeader(saltA: Buffer, saltB: Buffer, ivA: Buffer, ivB: Buffer): Header {
  const bytes = Buffer.alloc(HEADER_LEN);
  let off = 0;
  MAGIC.copy(bytes, off);
  off += MAGIC.length;
  bytes[off++] = VERSION;
  bytes[off++] = KDF.id;
  bytes[off++] = 1;
  bytes.writeUInt32LE(KDF.N, off);
  bytes.writeUInt32LE(KDF.r, off + 4);
  bytes.writeUInt32LE(KDF.p, off + 8);
  off += 12;
  saltA.copy(bytes, off);
  off += SALT_LEN;
  saltB.copy(bytes, off);
  off += SALT_LEN;
  ivA.copy(bytes, off);
  off += IV_LEN;
  ivB.copy(bytes, off);
  return { bytes, saltA, saltB, ivA, ivB };
}

function parseHeader(bytes: Buffer, size: number): Header {
  if (size < HEADER_LEN + FILE_TRAILER_LEN) die("文件太小，不是有效的加密容器");
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) die("文件头不匹配，可能不是 .pkv 加密容器");
  if (bytes[MAGIC.length] !== VERSION) die(`容器版本不支持（文件 v${bytes[MAGIC.length]}，本工具 v${VERSION}）`);
  if (bytes[MAGIC.length + 1] !== KDF.id) die("密钥派生算法不支持");
  const off = MAGIC.length + 3;
  const N = bytes.readUInt32LE(off);
  const r = bytes.readUInt32LE(off + 4);
  const p = bytes.readUInt32LE(off + 8);
  if (N !== KDF.N || r !== KDF.r || p !== KDF.p) die(`scrypt 参数不一致 N=${N} r=${r} p=${p}`);
  let o = off + 12;
  const saltA = bytes.subarray(o, o + SALT_LEN);
  o += SALT_LEN;
  const saltB = bytes.subarray(o, o + SALT_LEN);
  o += SALT_LEN;
  const ivA = bytes.subarray(o, o + IV_LEN);
  o += IV_LEN;
  const ivB = bytes.subarray(o, o + IV_LEN);
  return { bytes, saltA, saltB, ivA, ivB };
}

function collect(src: string): Entry[] {
  const st = fs.statSync(src);
  const base = path.basename(path.resolve(src));
  if (st.isFile()) return [{ name: base, type: "file", size: st.size, mtimeMs: st.mtimeMs }];
  if (!st.isDirectory()) die(`${src} 既不是文件也不是目录`);

  const entries: Entry[] = [{ name: base, type: "dir", size: 0, mtimeMs: st.mtimeMs }];
  const walk = (dir: string, prefix: string) => {
    for (const name of fs.readdirSync(dir).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const s = fs.lstatSync(full);
      if (s.isSymbolicLink()) continue;
      if (s.isDirectory()) {
        entries.push({ name: rel, type: "dir", size: 0, mtimeMs: s.mtimeMs });
        walk(full, rel);
      } else if (s.isFile()) {
        entries.push({ name: rel, type: "file", size: s.size, mtimeMs: s.mtimeMs });
      }
    }
  };
  walk(src, base);
  return entries;
}

function planEntries(paths: string[]): Entry[] {
  const all: Entry[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    if (!fs.existsSync(p)) die(`路径不存在：${p}`);
    for (const e of collect(p)) {
      if (seen.has(e.name)) die(`条目名重复：${e.name}`);
      seen.add(e.name);
      all.push(e);
    }
  }
  return all.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

function resolveEntryPath(name: string, sources: string[]): string {
  if (sources.length === 1) {
    const root = path.resolve(sources[0]);
    if (!fs.statSync(root).isDirectory()) return root;
    return path.join(root, name.split("/").slice(1).join(path.sep));
  }
  const parts = name.split("/");
  const top = parts.shift()!;
  const root = sources.map((s) => path.resolve(s)).find((s) => path.basename(s) === top);
  if (!root) die(`找不到条目 ${name} 对应的源文件`);
  return path.join(root, ...parts);
}

class ByteReader {
  iterator: AsyncIterator<Buffer>;
  pending: Buffer[] = [];
  ended = false;

  constructor(gen: AsyncGenerator<Buffer>) {
    this.iterator = gen[Symbol.asyncIterator]();
  }

  async fill(): Promise<boolean> {
    while (this.pending.length === 0 && !this.ended) {
      const r = await this.iterator.next();
      if (r.done) this.ended = true;
      else if (r.value.length) this.pending.push(r.value);
    }
    return this.pending.length > 0;
  }

  async read(n: number, strict = true): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let got = 0;
    while (got < n && (await this.fill())) {
      const c = this.pending[0];
      const take = Math.min(c.length, n - got);
      if (take === c.length) this.pending.shift();
      else this.pending[0] = c.subarray(take);
      chunks.push(take === c.length ? c : c.subarray(0, take));
      got += take;
    }
    if (got === 0) return null;
    if (strict && got !== n) die("容器被截断，明文长度不足");
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, got);
  }

  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const b = await this.read(CHUNK, false);
      if (!b) return total;
      total += b.length;
      progress(total);
    }
  }

  async pipeTo(fd: number, n: number): Promise<void> {
    let written = 0;
    while (written < n) {
      const b = await this.read(Math.min(CHUNK, n - written));
      if (!b) die("容器被截断，文件内容不足");
      fs.writeSync(fd, b);
      written += b.length;
      progress(b.length);
    }
  }
}

function progress(done: number): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(`\r已处理 ${(done / 1048576).toFixed(1)} MB   `);
}

async function writeVault(out: string, header: Header, keyA: Buffer, keyB: Buffer, manifest: Buffer, entries: Entry[], sources: string[]): Promise<void> {
  const c1 = crypto.createCipheriv(INNER, keyA, header.ivA, { authTagLength: TAG_LEN });
  const c2 = crypto.createCipheriv(OUTER, keyB, header.ivB);
  c1.setAAD(header.bytes);
  c2.setAAD(header.bytes);

  const part = `${out}.part`;
  let fd = -1;
  try {
    fd = fs.openSync(part, "w");
    fs.writeSync(fd, header.bytes);
    let done = HEADER_LEN;
    const push = (plain: Buffer) => {
      const mid = c1.update(plain);
      const outer = c2.update(mid.length ? mid : Buffer.alloc(0));
      if (outer.length) {
        fs.writeSync(fd, outer);
        done += outer.length;
        progress(done);
      }
    };

    const lenBuf = Buffer.allocUnsafe(4);
    lenBuf.writeUInt32LE(manifest.length);
    push(lenBuf);
    push(manifest);
    for (const e of entries) {
      if (e.type !== "file" || e.size === 0) continue;
      const src = resolveEntryPath(e.name, sources);
      if (!fs.existsSync(src)) die(`源文件已不存在：${src}`);
      for await (const chunk of fs.createReadStream(src, { highWaterMark: CHUNK })) {
        push(chunk as Buffer);
      }
    }

    c1.final();
    const tagInner = c1.getAuthTag();
    const tail = c2.update(tagInner);
    if (tail.length) fs.writeSync(fd, tail);
    c2.final();
    fs.writeSync(fd, c2.getAuthTag());
    fs.closeSync(fd);
    fd = -1;
    fs.renameSync(part, out);
  } catch (err) {
    if (fd >= 0) fs.closeSync(fd);
    fs.rmSync(part, { force: true });
    throw err;
  }
}

async function* decryptVault(vaultPath: string, header: Header, keyA: Buffer, keyB: Buffer): AsyncGenerator<Buffer> {
  const size = fs.statSync(vaultPath).size;
  const innerPlain = size - HEADER_LEN - FILE_TRAILER_LEN;
  if (innerPlain <= TAG_LEN) die("容器被截断");
  const fd = fs.openSync(vaultPath, "r");
  const tagOuter = Buffer.alloc(TAG_LEN);
  fs.readSync(fd, tagOuter, 0, TAG_LEN, size - TAG_LEN);
  fs.closeSync(fd);

  const d1 = crypto.createDecipheriv(INNER, keyA, header.ivA, { authTagLength: TAG_LEN });
  const d2 = crypto.createDecipheriv(OUTER, keyB, header.ivB);
  d1.setAAD(header.bytes);
  d2.setAAD(header.bytes);
  d2.setAuthTag(tagOuter);

  let remaining = innerPlain - TAG_LEN;
  let tagInner = Buffer.alloc(0);
  const split = (mid: Buffer): Buffer[] => {
    const out: Buffer[] = [];
    const take = Math.min(mid.length, remaining);
    if (take > 0) {
      remaining -= take;
      const plain = d1.update(mid.subarray(0, take));
      if (plain.length) out.push(plain);
    }
    if (mid.length > take) tagInner = Buffer.concat([tagInner, mid.subarray(take)]);
    return out;
  };

  const src = fs.createReadStream(vaultPath, { start: HEADER_LEN, end: size - FILE_TRAILER_LEN - 1, highWaterMark: CHUNK });
  for await (const chunk of src) {
    for (const p of split(d2.update(chunk as Buffer))) yield p;
  }
  for (const p of split(d2.final())) yield p;

  if (remaining > 0) die("容器被截断");
  if (tagInner.length !== TAG_LEN) die("容器被截断，缺少内层校验标签");
  d1.setAuthTag(tagInner);
  const rest = d1.final();
  if (rest.length) yield rest;
}

async function openVault(vaultPath: string, pass1: string, pass2: string): Promise<{ header: Header; keyA: Buffer; keyB: Buffer }> {
  if (!fs.existsSync(vaultPath)) die(`找不到加密文件：${vaultPath}`);
  const size = fs.statSync(vaultPath).size;
  const fd = fs.openSync(vaultPath, "r");
  const headBytes = Buffer.alloc(HEADER_LEN);
  fs.readSync(fd, headBytes, 0, HEADER_LEN, 0);
  fs.closeSync(fd);
  const header = parseHeader(headBytes, size);
  const keyA = await derive(pass1, header.saltA);
  const keyB = await derive(pass2, header.saltB);
  return { header, keyA, keyB };
}

function safeJoin(dest: string, name: string): string {
  const parts = name.split("/");
  for (const p of parts) {
    if (!p || p === "." || p === ".." || /^[A-Za-z]:/.test(p)) die(`容器内含非法路径：${name}`);
  }
  const target = path.resolve(dest, ...parts);
  const root = path.resolve(dest);
  if (target !== root && !target.startsWith(root + path.sep)) die(`容器内含越界路径：${name}`);
  return target;
}

async function readManifest(reader: ByteReader): Promise<{ entries: Entry[]; meta: Record<string, unknown> }> {
  const head = await reader.read(4);
  if (!head) die("容器为空");
  const len = head.readUInt32LE(0);
  if (len <= 0 || len > 64 << 20) die("清单长度异常");
  const body = await reader.read(len);
  if (!body) die("容器被截断");
  const json = JSON.parse(body.toString("utf8"));
  if (!Array.isArray(json.entries)) die("清单缺少 entries 字段");
  return { entries: json.entries, meta: json };
}

function defaultOut(sources: string[]): string {
  if (sources.length === 1) return path.basename(sources[0], path.extname(sources[0])) + EXT;
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `vault-${stamp}${EXT}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.cmd === "enc") {
    const entries = planEntries(args.rest);
    const files = entries.filter((e) => e.type === "file");
    const plainBytes = files.reduce((s, e) => s + e.size, 0);
    const out = args.out ?? defaultOut(args.rest);
    if (fs.existsSync(out) && !args.force) die(`${out} 已存在，加 --force 覆盖`);
    for (const s of args.rest) {
      if (path.resolve(out).startsWith(path.resolve(s) + path.sep)) die("输出文件不能放在待加密目录内部");
    }

    const header = buildHeader(crypto.randomBytes(SALT_LEN), crypto.randomBytes(SALT_LEN), crypto.randomBytes(IV_LEN), crypto.randomBytes(IV_LEN));
    const pass1 = await readPass("第 1 层", args.pass1, "PKV_PASS1");
    const pass2 = await readPass("第 2 层", args.pass2, "PKV_PASS2");
    if (pass1 === pass2) die("两层口令不能相同");

    const keyA = await derive(pass1, header.saltA);
    const keyB = await derive(pass2, header.saltB);
    const manifest = Buffer.from(
      JSON.stringify({
        entries,
        createdAt: new Date().toISOString(),
        layers: [INNER, OUTER],
        kdf: `scrypt-N${KDF.N}-r${KDF.r}-p${KDF.p}`,
        plainBytes,
      }),
      "utf8"
    );

    console.log(`加密 ${files.length} 个文件 / ${plainBytes} 字节 → ${out}`);
    console.log(`双层：${INNER}(口令A) → ${OUTER}(口令B)，文件名同样被加密`);
    await writeVault(out, header, keyA, keyB, manifest, entries, args.rest);
    if (process.stdout.isTTY) process.stdout.write("\n");
    console.log(`完成：${fs.statSync(out).size} 字节`);
    console.log("提示：忘记任意一层口令都无法还原，请把两把口令分开保存。");
    return;
  }

  if (args.cmd !== "dec" && args.cmd !== "list" && args.cmd !== "verify") die(`未知命令 ${args.cmd}`);
  const vaultPath = args.rest[0];
  const pass1 = await readPass("第 1 层", args.pass1, "PKV_PASS1");
  const pass2 = await readPass("第 2 层", args.pass2, "PKV_PASS2");
  const { header, keyA, keyB } = await openVault(vaultPath, pass1, pass2);

  if (args.cmd === "list") {
    const reader = new ByteReader(decryptVault(vaultPath, header, keyA, keyB));
    const { entries, meta } = await readManifest(reader);
    await reader.drain();
    if (process.stdout.isTTY) process.stdout.write("\n");
    console.log(`创建于 ${meta.createdAt} · 层 ${JSON.stringify(meta.layers)} · 明文 ${(Number(meta.plainBytes) / 1048576).toFixed(2)} MB`);
    for (const e of entries) {
      console.log(e.type === "dir" ? `  <目录> ${e.name}` : `  ${String(e.size).padStart(10)}  ${e.name}`);
    }
    console.log(`共 ${entries.filter((e) => e.type === "file").length} 个文件，两层口令与完整性校验通过。`);
    return;
  }

  if (args.cmd === "verify") {
    const reader = new ByteReader(decryptVault(vaultPath, header, keyA, keyB));
    const bytes = await reader.drain();
    if (process.stdout.isTTY) process.stdout.write("\n");
    console.log(`校验通过：两层口令正确，${(bytes / 1048576).toFixed(2)} MB 明文完整未被篡改。`);
    return;
  }

  const dest = path.resolve(args.dest ?? path.join(path.dirname(vaultPath), path.basename(vaultPath, EXT)));
  extractTarget.path = dest;
  fs.mkdirSync(dest, { recursive: true });
  const reader = new ByteReader(decryptVault(vaultPath, header, keyA, keyB));
  const { entries } = await readManifest(reader);
  let count = 0;
  for (const e of entries) {
    const target = safeJoin(dest, e.name);
    if (e.type === "dir") {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    if (fs.existsSync(target) && !args.force) die(`${target} 已存在，加 --force 覆盖`);
    const fd = fs.openSync(target, "w");
    await reader.pipeTo(fd, e.size);
    fs.closeSync(fd);
    fs.utimesSync(target, new Date(e.mtimeMs), new Date(e.mtimeMs));
    count++;
  }
  await reader.drain();
  if (process.stdout.isTTY) process.stdout.write("\n");
  console.log(`已还原 ${count} 个文件到 ${dest}`);
}

const extractTarget: { path: string | null } = { path: null };

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("已取消")) process.exit(130);
  if (extractTarget.path) {
    console.error(`注意：解密在完整性校验前中断，${extractTarget.path} 中已写出的文件可能不完整，请先用 verify 确认。`);
  }
  die(/Unsupported state|auth|unable to authenticate|final/i.test(msg) ? `解密失败：口令错误、口令顺序颠倒，或密文已被篡改（${msg}）` : msg);
});
