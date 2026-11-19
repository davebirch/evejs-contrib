'use strict';
// Minimal zip writer/reader: DEFLATE (raw) or stored, CRC-32 in JS, no ZIP64.
const fs = require('node:fs');
const zlib = require('node:zlib');

const MAX = 0xffffffff; // 4 GiB - 1: the classic zip limit
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // 1980-01-01

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function checkName(name) {
  const bad =
    typeof name !== 'string' ||
    name === '' ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    name.split('/').includes('..');
  if (bad) throw new Error(`zip: unsafe entry name: ${JSON.stringify(name)}`);
}

function writeZip(entries, outPath) {
  const seen = new Set();
  for (const { name, data } of entries) {
    checkName(name);
    if (seen.has(name)) throw new Error(`zip: duplicate entry name: ${name}`);
    seen.add(name);
    if (name.endsWith('/') && data && data.length) throw new Error(`zip: directory entry with data: ${name}`);
  }
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    checkName(name);
    const isDir = name.endsWith('/');
    const raw = isDir ? Buffer.alloc(0) : data;
    const crc = crc32(raw);
    const deflated = isDir || raw.length === 0 ? raw : zlib.deflateRawSync(raw);
    const method = isDir || raw.length === 0 ? 0 : 8;
    const nameBuf = Buffer.from(name, 'utf8');
    if (raw.length > MAX || deflated.length > MAX) throw new Error(`zip: entry too large: ${name}`);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(deflated.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x031e, 4); // made by Unix, 3.0
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(deflated.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE((((isDir ? 0o40755 : 0o100644) << 16) | (isDir ? 0x10 : 0)) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);

    locals.push(lh, nameBuf, deflated);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + deflated.length;
    if (offset > MAX) throw new Error('zip: archive exceeds 4 GiB (no ZIP64)');
  }
  if (entries.length > 0xffff) throw new Error('zip: too many entries (no ZIP64)');
  const cd = Buffer.concat(central);
  if (offset + cd.length > MAX) throw new Error('zip: archive exceeds 4 GiB (no ZIP64)');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  fs.writeFileSync(outPath, Buffer.concat([...locals, cd, eocd]));
}

// source: a file path or a Buffer (for zips nested in zips).
function readZip(source) {
  const path = Buffer.isBuffer(source) ? '<buffer>' : source;
  const buf = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  }
  if (e < 0) throw new Error(`zip: no end-of-central-directory record: ${path}`);
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    checkName(name);
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`zip: bad local header: ${name}`);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const body = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = zlib.inflateRawSync(body);
    else throw new Error(`zip: unsupported method ${method}: ${name}`);
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`zip: CRC mismatch: ${name}`);
    out.push({ name, data });
  }
  return out;
}

module.exports = { writeZip, readZip, crc32 };
