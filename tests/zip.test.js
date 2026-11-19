'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { writeZip, readZip } = require('../skills/upstream-report/scripts/lib/zip.js');

const tmp = () => require('./fixtures/tmp.js').mk('zip-test-');

test('round-trips files, an empty file, a binary file and a directory', () => {
  const dir = tmp();
  const out = path.join(dir, 'out.zip');
  const entries = [
    { name: 'empty.txt', data: Buffer.alloc(0) },
    { name: 'bin.dat', data: crypto.randomBytes(200 * 1024) },
    { name: 'a/', data: Buffer.alloc(0) },
    { name: 'a/b/note.txt', data: Buffer.from('h\u00e9llo\r\nworld\n') },
  ];
  writeZip(entries, out);
  const pyBin = ['python3', 'python'].find((p) => spawnSync(p, ['-I', '--version']).status === 0);
  if (pyBin) {
    const py = spawnSync(pyBin, ['-I', '-m', 'zipfile', '-t', out], { encoding: 'utf8' });
    assert.equal(py.status, 0, py.stdout + py.stderr);
  }
  const back = readZip(out);
  assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
  back.forEach((e, i) => assert.ok(e.data.equals(entries[i].data), e.name));
});

test('readZip rejects a corrupted entry', () => {
  const dir = tmp();
  const out = path.join(dir, 'out.zip');
  writeZip([{ name: 'x.txt', data: Buffer.from('a'.repeat(1000)) }], out);
  const buf = fs.readFileSync(out);
  buf[buf.indexOf(Buffer.from('x.txt')) + 8] ^= 0xff; // damage the compressed data
  fs.writeFileSync(out, buf);
  assert.throws(() => readZip(out));
});

test('writeZip refuses unsafe names', () => {
  const out = path.join(tmp(), 'o.zip');
  for (const name of ['../x', '/abs', 'a\\b', '']) {
    assert.throws(() => writeZip([{ name, data: Buffer.alloc(0) }], out), /name/i, name);
  }
  assert.ok(!fs.existsSync(out));
});

test('writeZip refuses duplicate names and a directory entry with data', () => {
  const out = path.join(tmp(), 'o.zip');
  const f = (name) => ({ name, data: Buffer.from('x') });
  assert.throws(() => writeZip([f('a'), f('a')], out), /duplicate/);
  assert.throws(() => writeZip([f('d/')], out), /directory/);
  assert.ok(!fs.existsSync(out));
});

test('readZip applies the name check (zip-slip)', () => {
  const out = path.join(tmp(), 'o.zip');
  writeZip([{ name: 'aa/xxx', data: Buffer.from('hello') }], out);
  const buf = fs.readFileSync(out);
  // same-length rewrite of the name in both headers: 'aa/xxx' -> '../xxx'
  for (let i = 0; i < buf.length - 6; i++) if (buf.toString('latin1', i, i + 6) === 'aa/xxx') buf.write('../xxx', i, 'latin1');
  fs.writeFileSync(out, buf);
  assert.throws(() => readZip(out), /unsafe entry name/);
});
