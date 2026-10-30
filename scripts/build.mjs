/**
 * ncm-daily 构建脚本（参照 songloft-music-feed 的构建规范）
 * 产物：Release/ncm-daily-v{version}.jsplugin.zip（根目录平铺：plugin.json / main.js / static/*）
 * hash 规则：
 *   entryHash = sha256(main.js)
 *   zipHash   = sha256( 所有文件（排除 plugin.json）按路径排序后逐条拼接 "相对路径\n文件sha256\n" )
 */
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync, cpSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'Release', '_build');

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function walk(dir, base, out) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(base, full).split(sep).join('/');
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(rel);
  }
  return out;
}

/* ---------- 准备 _build ---------- */
rmSync(BUILD, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });
copyFileSync(join(ROOT, 'src', 'main.js'), join(BUILD, 'main.js'));
cpSync(join(ROOT, 'static'), join(BUILD, 'static'), { recursive: true });
copyFileSync(join(ROOT, 'plugin.json'), join(BUILD, 'plugin.json'));

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/* ---------- 计算 hash ---------- */
const entryHash = sha256File(join(BUILD, 'main.js'));

const allFiles = walk(BUILD, BUILD, []).sort();
let concat = '';
for (const rel of allFiles) {
  if (rel === 'plugin.json') continue;
  concat += rel + '\n' + sha256File(join(BUILD, rel)) + '\n';
}
const zipHash = createHash('sha256').update(concat).digest('hex');

/* ---------- 回写 plugin.json ---------- */
const manifest = JSON.parse(readFileSync(join(BUILD, 'plugin.json'), 'utf8'));
manifest.version = pkg.version;
manifest.entryHash = entryHash;
manifest.zipHash = zipHash;
const manifestStr = JSON.stringify(manifest, null, 2) + '\n';
writeFileSync(join(BUILD, 'plugin.json'), manifestStr);
writeFileSync(join(ROOT, 'plugin.json'), manifestStr);

/* ---------- 生成 zip（无第三方依赖） ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

function makeZip(files, outPath) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = dosTime(new Date());

  for (const rel of files) {
    const raw = readFileSync(join(BUILD, rel));
    const compressed = deflateRawSync(raw, { level: 9 });
    const useDeflate = compressed.length < raw.length;
    const data = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const name = Buffer.from(rel, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(now.time, 10);
    local.writeUInt16LE(now.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    chunks.push(local, data);

    const cd = Buffer.alloc(46 + name.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(now.time, 12);
    cd.writeUInt16LE(now.date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    name.copy(cd, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  writeFileSync(outPath, Buffer.concat(chunks.concat([centralBuf, eocd])));
}

const zipName = 'ncm-daily-v' + pkg.version + '.jsplugin.zip';
makeZip(allFiles, join(ROOT, 'Release', zipName));

console.log('entryHash:', entryHash);
console.log('zipHash:  ', zipHash);
console.log('构建完成: Release/' + zipName);
console.log('包内文件:');
for (const rel of allFiles) console.log('  ' + rel);
