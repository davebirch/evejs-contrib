#!/usr/bin/env node
'use strict';
// Build the shareable zip: evejs-contrib/{.claude-plugin, skills, LICENSE, README.md} (Claude Code layout)
// plus byte-identical copies of every skill under evejs-contrib/.agents/skills/ (Codex layout).
// Refuses (exit 2) on a symlink in the sources, a leak-scan hit or a skill missing from a layout.
// usage: node scripts/build-zip.js [--out <dir>] [--terms <file>]... [--no-user-terms] [--root <repo>]
const fs = require('node:fs');
const path = require('node:path');
const { writeZip } = require('../skills/upstream-report/scripts/lib/zip.js');
const { scanTexts, identityTerms, slugFromRepository } = require('../skills/upstream-report/scripts/leak-scan.js');
const { loadUserTerms } = require('../skills/upstream-report/scripts/lib/terms.js');

const TOP = 'evejs-contrib';
const SKIP = new Set(['.DS_Store', 'Thumbs.db']);

class Refusal extends Error {}

// Files under rel (relative to root), as { rel, data }; a symlink or odd file anywhere refuses.
function walk(root, rel, out = []) {
  const full = path.join(root, rel);
  const st = fs.lstatSync(full);
  if (st.isSymbolicLink()) throw new Refusal(`symlink not allowed: ${rel}`);
  if (st.isDirectory()) {
    for (const f of fs.readdirSync(full).sort()) if (!SKIP.has(f)) walk(root, path.posix.join(rel.split(path.sep).join('/'), f), out);
  } else if (st.isFile()) {
    out.push({ rel: rel.split(path.sep).join('/'), data: fs.readFileSync(full) });
  } else throw new Refusal(`not a regular file: ${rel}`);
  return out;
}

function collect(root) {
  const need = (p) => { if (!fs.existsSync(path.join(root, p))) throw new Refusal(`missing: ${p}`); };
  ['.claude-plugin', 'skills', 'LICENSE', 'README.md'].forEach(need);
  const skillDirs = fs.readdirSync(path.join(root, 'skills'), { withFileTypes: true })
    .filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name).sort();
  if (!skillDirs.length) throw new Refusal('no skills found under skills/');
  const files = [];
  for (const p of ['.claude-plugin', 'skills', 'LICENSE', 'README.md']) walk(root, p, files);
  const entries = files.map((f) => ({ name: `${TOP}/${f.rel}`, data: f.data }));
  for (const f of files) {
    if (f.rel.startsWith('skills/')) entries.push({ name: `${TOP}/.agents/${f.rel}`, data: f.data });
  }
  for (const s of skillDirs) {
    for (const layout of ['skills', '.agents/skills']) {
      if (!entries.some((e) => e.name === `${TOP}/${layout}/${s}/SKILL.md`)) throw new Refusal(`skill ${s} has no SKILL.md in ${layout}/`);
    }
  }
  return entries;
}

const isBinary = (buf) => buf.subarray(0, 8192).includes(0);

function leakHits(entries, { termsFiles = [], noUserTerms = false, root }) {
  let user;
  try { user = loadUserTerms({ files: termsFiles, noUserTerms }); } catch (e) { throw new Refusal(/^cannot read/.test(e.message) ? e.message : `cannot use terms file ${e.message}`); }
  let repository = '';
  try { repository = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).repository; } catch (e) { /* no package.json */ }
  const slug = slugFromRepository(repository);
  const texts = entries.filter((e) => !isBinary(e.data)).map((e) => ({ name: e.name, text: e.data.toString('utf8').replace(/^\uFEFF/, '') }));
  return scanTexts(texts, { terms: user.terms, names: user.names, identity: [...identityTerms(), ...user.identity], selfRefs: slug ? [slug] : [] });
}

function build({ root, out, termsFiles = [], noUserTerms = false }) {
  const entries = collect(root);
  const hits = leakHits(entries, { termsFiles, noUserTerms, root });
  if (hits.length) throw new Refusal(hits.map((h) => `${h.name}:${h.line}: ${h.term}`).join('\n'));
  const version = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Refusal(`plugin.json version is not MAJOR.MINOR.PATCH: ${version}`);
  fs.mkdirSync(out, { recursive: true });
  const zipPath = path.join(out, `evejs-contrib-${version}.zip`);
  writeZip(entries, zipPath);
  return zipPath;
}

function main(argv) {
  let out = null;
  let root = path.resolve(__dirname, '..');
  const termsFiles = [];
  let noUserTerms = false;
  const usage = (msg) => {
    console.error(msg);
    console.error('usage: node scripts/build-zip.js [--out <dir>] [--terms <file>]... [--no-user-terms] [--root <repo>]');
    process.exit(64);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-user-terms') {
      noUserTerms = true;
      continue;
    }
    if (!['--out', '--terms', '--root'].includes(a)) usage(`unknown argument: ${a}`);
    if (i + 1 >= argv.length) usage(`${a} needs a value`);
    const v = argv[++i];
    if (a === '--out') out = path.resolve(v);
    else if (a === '--terms') termsFiles.push(v);
    else root = path.resolve(v);
  }
  try {
    console.log(build({ root, out: out || path.join(root, 'dist'), termsFiles, noUserTerms }));
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    for (const line of e.message.split('\n')) console.log(`refusing: ${line}`);
    process.exit(2);
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { build, Refusal };
