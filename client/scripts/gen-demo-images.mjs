/**
 * 生成前端 mock 模式用的演示样张（12 张 webp）。
 * sharp 只在 server 侧装了，所以解析路径锚在 server 包上，任何目录都能跑：
 *   node client/scripts/gen-demo-images.mjs
 * 这些图不是产品资源，只是让瀑布流有东西可看，随时可以重生成。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(HERE, '../../server/package.json'));
const sharp = require('sharp');

const OUT_DIR = resolve(HERE, '../public/demo');

const PALETTES = [
  ['#2b1a4d', '#6b5cff', '#ff7ab6'],
  ['#0b1f3a', '#2ec27e', '#cfe8ff'],
  ['#3a0f2b', '#ff6b6b', '#ffd166'],
  ['#101820', '#4cc9f0', '#f72585'],
  ['#1b1146', '#b388ff', '#ffe082'],
  ['#041b1a', '#12d1ba', '#e0f7f4'],
  ['#2d1b00', '#ffb703', '#fb8500'],
  ['#141e46', '#577590', '#f9c74f'],
  ['#200a3c', '#f15bb5', '#9b5de5'],
  ['#001b2e', '#00a6fb', '#00f5d4'],
  ['#1f1147', '#ff9f1c', '#ffbf69'],
  ['#0d1b2a', '#778da9', '#e0e1dd'],
];

const SUBJECTS = ['雷电将军', '芙莉莲', '初音未来', '哥伦比娅', '八重神子', '魈', '娜维娅', '可莉', '钟离', '甘雨', '散兵', '珐露珊'];

/** 竖构图更接近场照比例，缩略与预览用同一张就够演示了 */
function svg(index) {
  const [deep, mid, accent] = PALETTES[index % PALETTES.length];
  const w = 900;
  const h = 1200;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${deep}"/>
      <stop offset="55%" stop-color="${mid}"/>
      <stop offset="100%" stop-color="${accent}"/>
    </linearGradient>
    <radialGradient id="glow" cx="35%" cy="28%" r="62%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <rect width="${w}" height="${h}" fill="url(#glow)"/>
  <circle cx="${200 + index * 37}" cy="${840 - index * 23}" r="${130 + (index % 5) * 26}" fill="#ffffff" opacity="0.12"/>
  <circle cx="${640 - index * 21}" cy="${330 + index * 17}" r="${90 + (index % 4) * 30}" fill="${deep}" opacity="0.35"/>
  <text x="60" y="${h - 118}" font-family="sans-serif" font-size="58" fill="#ffffff" opacity="0.92">${SUBJECTS[index % SUBJECTS.length]}</text>
  <text x="60" y="${h - 60}" font-family="monospace" font-size="30" fill="#ffffff" opacity="0.6">PIKS · DEMO ${String(index + 1).padStart(2, '0')}</text>
</svg>`;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  for (let i = 0; i < 12; i += 1) {
    const buffer = await sharp(Buffer.from(svg(i))).webp({ quality: 74 }).toBuffer();
    const file = resolve(OUT_DIR, `img-${i + 1}.webp`);
    await writeFile(file, buffer);
    console.log(`img-${i + 1}.webp ${(buffer.length / 1024).toFixed(0)}KB`);
  }
}

await main();
