#!/usr/bin/env node
'use strict';
// Builds a report bundle: init, validate, add-report, add-profiles, manifest, check, zip.
// Reads upstream's error-report zip (its output only; never runs the collector).
// Exit 0 ok, 2 refused (one "refusing: ..." line per problem), 64 usage.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readZip, writeZip } = require('./lib/zip.js');
const { loadUserTerms } = require('./lib/terms.js');
const { scanTexts, collectTexts, identityTerms, summary } = require('./leak-scan.js');
const { decodeText } = require('./lib/text.js');
const { redactTree } = require('./redact.js');

const SCHEMA = 'evejs-error-report/1';
const SCHEMA_REFUSAL = "upstream changed the report format: read the collector's --help and README, then update the skill";
const REPORT_TARGETS = ['error-report', 'evidence/before/error-report', 'evidence/after/error-report'];
const PROFILE_TARGETS = ['evidence/before', 'evidence/after'];
const TOP_DOCS = ['README.md', 'BUG-REPORT.md', 'DEVELOPER-HANDOFF.md'];
const MANIFEST = 'manifest-sha256.txt';
const JUNK = new Set(['.DS_Store', 'Thumbs.db']);
const SKELETON = path.join(__dirname, '..', 'assets', 'skeleton');
const VALUE_OPTS = new Set(['--area', '--version', '--repo', '--base', '--as', '--names', '--hosts']);

class Usage extends Error {}
class Refused extends Error {
  constructor(list) { super(list.join('\n')); this.list = list; }
}
const usage = (msg) => { throw new Usage(msg); };

function parseArgs(argv) {
  const pos = [], opt = {}, flags = new Set();
  opt.terms = []; // --terms may repeat; each file is added to the user's terms file
  opt.allow = []; // --allow <label|term> (leak-scan labels or a plain term), repeatable
  opt.allowBinary = []; // --allow-binary <name>: a file that is meant to ship unredacted and unscanned
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_OPTS.has(a)) {
      if (i + 1 >= argv.length) usage(`${a} needs a value`);
      opt[a.slice(2)] = argv[++i];
    } else if (a === '--terms') {
      if (i + 1 >= argv.length) usage(`${a} needs a value`);
      opt.terms.push(argv[++i]);
    } else if (a === '--allow' || a === '--allow-binary') {
      if (i + 1 >= argv.length) usage(`${a} needs a value`);
      opt[a === '--allow' ? 'allow' : 'allowBinary'].push(argv[++i]);
    } else if (a === '--no-identity') flags.add('no-identity');
    else if (a === '--no-user-terms') flags.add('no-user-terms');
    else if (a.startsWith('--')) usage(`unknown option: ${a}`);
    else pos.push(a);
  }
  return { pos, opt, flags };
}

const exists = (p) => fs.existsSync(p);
const isDirNotEmpty = (p) => exists(p) && fs.readdirSync(p).length > 0;
const posix = (p) => p.split(path.sep).join('/');

// Names and hosts to redact: the --names/--hosts files plus the terms file's character names.
function readList(file, what) {
  if (!exists(file)) usage(`cannot read ${what} file: ${file}`);
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}
function loadTerms(opt, flags) {
  try { return loadUserTerms({ files: opt.terms, noUserTerms: flags.has('no-user-terms') }); } catch (e) { return usage(e.message); }
}
function redactionOpts(opt, flags) {
  const t = loadTerms(opt, flags);
  return { names: [...(opt.names ? readList(opt.names, 'names') : []), ...t.names], hosts: opt.hosts ? readList(opt.hosts, 'hosts') : [], allowBinary: opt.allowBinary };
}

// After redaction: nothing the user named (names, hosts) may survive anywhere in the output, in text
// (UTF-8 or UTF-16) or in an allowed binary. Returns "<file>:<line>: <label>" problems.
// Bytes of a file named by a collectTexts label (relative to dir); entries inside zips (x.zip/inner.bin) are read out of the zip.
function bytesOf(dir, rel) {
  const segs = rel.split('/');
  for (let i = 0; i < segs.length - 1; i++) {
    if (!/\.zip$/i.test(segs[i])) continue;
    const zp = path.join(dir, ...segs.slice(0, i + 1));
    if (!fs.statSync(zp).isFile()) continue; // a directory named *.zip is a directory
    let entries = readZip(zp);
    for (let j = i + 1; j < segs.length; j++) {
      const rest = segs.slice(j).join('/');
      const hit = entries.find((e) => e.name === rest);
      if (hit) return hit.data;
      const nested = entries.find((e) => rest.startsWith(e.name + '/') && /\.zip$/i.test(e.name));
      if (!nested) break;
      entries = readZip(nested.data);
      j += nested.name.split('/').length - 1;
    }
    break;
  }
  return fs.readFileSync(path.join(dir, ...segs));
}

function survivors(dir, { names, hosts, allowBinary }) {
  const skipped = [];
  const root = path.basename(dir);
  const texts = collectTexts([dir], { onSkip: (n) => skipped.push(n) });
  const problems = scanTexts(texts, { names, hosts, generic: false }).map((h) => `${h.name.split('/').slice(1).join('/')}:${h.line}: ${h.term} survived redaction`);
  const words = [...names, ...hosts].map((w) => w.trim().toLowerCase()).filter(Boolean);
  for (const label of skipped) {
    const rel = label.split('/').slice(1).join('/');
    const buf = bytesOf(dir, rel);
    const hay = [buf.toString('latin1').toLowerCase(), buf.toString('utf16le').toLowerCase(), buf.subarray(1).toString('utf16le').toLowerCase()];
    for (const w of words) {
      const probes = [Buffer.from(w, 'utf8').toString('latin1'), w];
      if (hay.some((h) => probes.some((p) => h.includes(p)))) problems.push(`${rel}: a name or host survived in a binary file`);
    }
  }
  return [...new Set(problems)];
}

function stripBom(s) { return s.replace(/^\uFEFF/, ''); }

// ---------------------------------------------------------------- init

function copyTemplate(src, dst, vars) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src).sort()) {
    const s = path.join(src, f), d = path.join(dst, f);
    if (fs.statSync(s).isDirectory()) copyTemplate(s, d, vars);
    else {
      let text = stripBom(fs.readFileSync(s, 'utf8')).replace(/\r\n/g, '\n');
      for (const [k, v] of Object.entries(vars)) text = text.split(k).join(v);
      fs.writeFileSync(d, text);
    }
  }
}

function init({ pos, opt }) {
  if (pos.length !== 1 || !opt.area || !opt.version) usage('usage: bundle.js init <dir> --area <area> --version <version>');
  const dir = path.resolve(pos[0]);
  if (isDirNotEmpty(dir)) throw new Refused([`${pos[0]} exists and is not empty`]);
  copyTemplate(SKELETON, dir, { '<area>': opt.area, '<version>': opt.version });
  for (const d of ['patches', 'files', 'tests']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  console.log(`created ${pos[0]}: fill every TODO(bundle), add patches/ and files/, then validate`);
}

// ---------------------------------------------------------------- validate

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function validate({ pos, opt }) {
  if (pos.length !== 1 || !opt.repo || !opt.base) usage('usage: bundle.js validate <dir> --repo <git checkout> --base <rev>');
  const dir = path.resolve(pos[0]);
  const patchDir = path.join(dir, 'patches');
  const patches = exists(patchDir) ? fs.readdirSync(patchDir).filter((f) => f.endsWith('.patch')).sort() : [];
  if (!patches.length) throw new Refused(['no patches/*.patch to validate']);
  const repo = path.resolve(opt.repo);
  let head;
  try { head = git(repo, ['rev-parse', '--verify', `${opt.base}^{commit}`]).trim(); } catch (e) {
    throw new Refused([`cannot resolve base ${opt.base} in the repo`]);
  }
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-validate-'));
  const lines = [`base: ${opt.base} (${head.slice(0, 12)})`];
  for (const f of patches) lines.push(`sha256 ${sha256(path.join(patchDir, f))}  patches/${f}`);
  const failures = [];
  // Tool output may name the throwaway tree or the repo: show them as <tree> and <repo>.
  const clean = (s) => s.split(tree).join('<tree>').split(posix(tree)).join('<tree>').split(repo).join('<repo>').split(posix(repo)).join('<repo>').trim();
  const step = (cmd, fn) => {
    lines.push(`$ ${cmd}`);
    try {
      const out = fn();
      lines.push(out ? clean(out) : 'ok');
      return true;
    } catch (e) {
      const msg = clean(`${e.stderr || ''}${e.stdout || ''}` || e.message);
      lines.push(`FAILED: ${msg}`);
      failures.push(`${cmd}: ${msg.split('\n')[0]}`);
      return false;
    }
  };
  let added = false;
  try {
    git(repo, ['worktree', 'add', '--detach', tree, head]);
    added = true;
    const apply = (args, f) => git(tree, ['apply', ...args, path.join(patchDir, f)]);
    for (const f of patches.filter((p) => p.endsWith('-optional.patch'))) {
      step(`git apply --check patches/${f}   (alone, on the base)`, () => apply(['--check'], f));
    }
    for (const f of patches) {
      if (step(`git apply --check patches/${f}`, () => apply(['--check'], f))) step(`git apply patches/${f}`, () => apply([], f));
    }
    // Added, modified and renamed files only: a deleted file has nothing to check.
    const changed = [...new Set([
      ...git(tree, ['diff', '--name-only', '--diff-filter=d', 'HEAD']).split('\n'),
      ...git(tree, ['ls-files', '--others', '--exclude-standard']).split('\n'),
    ])].filter((f) => f.endsWith('.js')).sort();
    for (const f of changed) step(`node --check ${f}`, () => execFileSync(process.execPath, ['--check', f], { cwd: tree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    if (!changed.length) lines.push('(no changed .js files)');
  } catch (e) {
    failures.push(clean(String(e.stderr || e.message)));
  } finally {
    let removed = !added;
    if (added) { try { git(repo, ['worktree', 'remove', '--force', tree]); removed = true; } catch (e) { /* pruned below */ } }
    fs.rmSync(tree, { recursive: true, force: true });
    // only a worktree we could not remove ourselves is pruned (never other worktrees' metadata)
    if (!removed) { try { git(repo, ['worktree', 'prune']); } catch (e) { /* nothing to prune */ } }
  }
  lines.push(`Result: ${failures.length ? 'FAIL' : 'PASS'}`);
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'patch-validation.txt'), lines.join('\n') + '\n');
  if (failures.length) throw new Refused(failures);
  console.log('patches validated: tests/patch-validation.txt written');
}

// ---------------------------------------------------------------- add-report / add-profiles

// Redacts raw/ into a staging folder, refuses (writing nothing) on an undecodable file or when a given
// name or host survives, and only then copies the result to target.
function stageRedaction(raw, target, redaction) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-stage-'));
  try {
    let r;
    try { r = redactTree(raw, path.join(stage, 'out'), redaction); } catch (e) {
      if (e.refusals) throw new Refused(e.refusals);
      throw e;
    }
    const left = survivors(path.join(stage, 'out'), redaction);
    if (left.length) throw new Refused(left);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(stage, 'out'), target, { recursive: true });
    return r;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function reportRedaction(r) {
  console.error(`redacted: names ${r.counts.names}, hosts ${r.counts.hosts}, paths ${r.counts.paths}, fields ${r.counts.fields}, ips ${r.counts.ips}`);
  if (r.discovered) console.error(`${r.discovered} character name(s) found in the logs were not in your terms and were redacted too: add them with leak-terms.js`);
}

function addReport({ pos, opt, flags }) {
  if (pos.length !== 2) usage('usage: bundle.js add-report <dir> <collector.zip> [--as <target>] [--names <file>] [--hosts <file>] [--terms <file>]... [--no-user-terms] [--allow-binary <name>]...');
  const as = opt.as || 'error-report';
  if (!REPORT_TARGETS.includes(as)) usage(`--as must be one of: ${REPORT_TARGETS.join(', ')}`);
  const dir = path.resolve(pos[0]);
  const target = path.join(dir, ...as.split('/'));
  const redaction = redactionOpts(opt, flags);
  if (!exists(pos[1])) usage(`no such file: ${pos[1]}`);
  let entries;
  try { entries = readZip(pos[1]); } catch (e) { throw new Refused([`${pos[1]}: ${e.message}`]); }
  const mEntry = entries.find((e) => e.name === 'manifest.json');
  let manifest;
  try { manifest = JSON.parse(stripBom(mEntry.data.toString('utf8'))); } catch (e) {
    throw new Refused([`${pos[1]}: no readable manifest.json: ${SCHEMA_REFUSAL}`]);
  }
  if (manifest.schema !== SCHEMA) throw new Refused([SCHEMA_REFUSAL]);
  if (exists(target)) throw new Refused([`${as} already exists in ${pos[0]}`]);
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-report-'));
  try {
    for (const { name, data } of entries) {
      if (name.endsWith('/')) continue;
      const p = path.join(raw, ...name.split('/'));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, data);
    }
    const r = stageRedaction(raw, target, redaction);
    for (const s of r.skipped) console.error(`not redacted: review by hand: ${as}/${s}`);
    for (const s of r.notUtf8) console.error(`warning: not valid UTF-8, passed through byte for byte: ${as}/${s}`);
    reportRedaction(r);
  } finally {
    fs.rmSync(raw, { recursive: true, force: true });
  }
  console.log(`added ${as}/`);
  console.log(`versions: ${JSON.stringify(manifest.versions)}`);
  console.log(`window: ${JSON.stringify(manifest.window, null, 2)}`);
}

function addProfiles({ pos, opt, flags }) {
  if (pos.length !== 2) usage('usage: bundle.js add-profiles <dir> <profilesDir> --as evidence/before|evidence/after [--names <file>] [--hosts <file>] [--terms <file>]... [--no-user-terms] [--allow-binary <name>]...');
  if (!PROFILE_TARGETS.includes(opt.as)) usage(`--as must be one of: ${PROFILE_TARGETS.join(', ')}`);
  const dir = path.resolve(pos[0]);
  const target = path.join(dir, ...opt.as.split('/'), 'close-watch');
  const redaction = redactionOpts(opt, flags);
  if (!exists(pos[1]) || !fs.statSync(pos[1]).isDirectory()) usage(`no such folder: ${pos[1]}`);
  const files = fs.readdirSync(pos[1]).filter((f) => f.endsWith('.cpuprofile')).sort();
  if (!files.length) throw new Refused([`no .cpuprofile files in ${pos[1]}`]);
  const bad = files.filter((f) => !fs.lstatSync(path.join(pos[1], f)).isFile());
  if (bad.length) throw new Refused(bad.map((f) => `not a regular file: ${f}`));
  if (exists(target)) throw new Refused([`${opt.as}/close-watch already exists in ${pos[0]}`]);
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-profiles-'));
  try {
    for (const f of files) fs.copyFileSync(path.join(pos[1], f), path.join(raw, f));
    const r = stageRedaction(raw, target, redaction);
    for (const s of r.skipped) console.error(`not redacted: review by hand: ${opt.as}/close-watch/${s}`);
    reportRedaction(r);
  } finally {
    fs.rmSync(raw, { recursive: true, force: true });
  }
  for (const f of files) console.log(f);
}

// ---------------------------------------------------------------- manifest / check / zip

// Every regular file under dir (posix relative paths, sorted). Symlinks and odd files are returned apart.
function listFiles(dir) {
  const files = [], bad = [];
  const walk = (p, rel) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) bad.push(`symlink not allowed: ${rel}`);
    else if (st.isDirectory()) for (const f of fs.readdirSync(p).sort()) walk(path.join(p, f), rel ? `${rel}/${f}` : f);
    else if (st.isFile()) { if (!JUNK.has(path.basename(rel))) files.push(rel); }
    else bad.push(`not a regular file: ${rel}`);
  };
  for (const f of fs.readdirSync(dir).sort()) walk(path.join(dir, f), f);
  return { files: files.sort(), bad };
}

function manifestText(dir, files) {
  return files.filter((f) => f !== MANIFEST).map((f) =>
    `${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, ...f.split('/')))).digest('hex')}  ${f}\n`).join('');
}

function manifest({ pos }) {
  if (pos.length !== 1) usage('usage: bundle.js manifest <dir>');
  const dir = path.resolve(pos[0]);
  if (!exists(dir)) usage(`no such folder: ${pos[0]}`);
  const { files, bad } = listFiles(dir);
  if (bad.length) throw new Refused(bad);
  fs.writeFileSync(path.join(dir, MANIFEST), manifestText(dir, files));
  console.log(`${MANIFEST}: ${files.filter((f) => f !== MANIFEST).length} files`);
}

const sectionOf = (text, heading) => {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n');
};

function linkTargets(md) {
  const text = md.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const out = [];
  for (const m of text.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push(m[1]);
  return out;
}
const localTarget = (t) => (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(t) ? null : t.split('#')[0].split('?')[0]);

function check(dir, { terms, identity, names = [], hosts = [], allow = [], allowBinary = [] }) {
  const problems = [];
  const at = (rel) => path.join(dir, ...rel.split('/'));
  const text = (rel) => stripBom(fs.readFileSync(at(rel), 'utf8')).replace(/\r\n/g, '\n');
  const { files, bad } = listFiles(dir);
  problems.push(...bad);
  for (const d of TOP_DOCS) if (!exists(at(d))) problems.push(`missing ${d}`);
  if (!files.some((f) => /^patches\/[^/]+\.patch$/.test(f))) problems.push('patches/ has no .patch file');
  if (!files.some((f) => f.startsWith('files/'))) problems.push('files/ is empty');
  if (!exists(at('tests/patch-validation.txt'))) problems.push('tests/patch-validation.txt missing: run validate');
  else {
    const v = text('tests/patch-validation.txt');
    if (!/^Result: PASS$/m.test(v)) problems.push('tests/patch-validation.txt: not Result: PASS: fix the patches and run validate again');
    // the transcript must describe the patches as they are now
    for (const f of files.filter((x) => /^patches\/[^/]+\.patch$/.test(x))) {
      if (!v.includes(`sha256 ${sha256(at(f))}  ${f}`)) problems.push(`${f} changed since tests/patch-validation.txt was written: run validate again`);
    }
  }

  if (exists(at('README.md'))) {
    const section = sectionOf(text('README.md'), '## Health capture');
    if (section === null) problems.push('README.md has no "## Health capture" section');
    else {
      const targets = linkTargets(section).map((t) => (localTarget(t) || '').replace(/^\.\//, ''));
      const single = targets.includes('error-report/manifest.json');
      const pair = targets.includes('evidence/before/error-report/manifest.json') && targets.includes('evidence/after/error-report/manifest.json');
      const na = /^Health capture: not applicable: \S/m.test(section);
      if (!single && !pair && !na) {
        problems.push('README.md Health capture: link error-report/manifest.json (or evidence/before and evidence/after), or write "Health capture: not applicable: <reason>"');
      }
      const linked = [];
      if (single) linked.push('error-report/manifest.json');
      if (pair) linked.push('evidence/before/error-report/manifest.json', 'evidence/after/error-report/manifest.json');
      for (const rel of linked) {
        if (!exists(at(rel))) { problems.push(`README.md links ${rel}, which does not exist`); continue; }
        let schema;
        try { schema = JSON.parse(text(rel)).schema; } catch (e) { schema = undefined; }
        if (schema !== SCHEMA) problems.push(`${rel}: schema is not ${SCHEMA}`);
      }
    }
  }
  if (exists(at('DEVELOPER-HANDOFF.md'))) {
    const s = sectionOf(text('DEVELOPER-HANDOFF.md'), '## Merge checklist');
    if (s === null) problems.push('DEVELOPER-HANDOFF.md has no "## Merge checklist" section');
    else if (!/^\s*\d+[.)]\s+\S/m.test(s)) problems.push('DEVELOPER-HANDOFF.md Merge checklist has no numbered item');
  }
  if (exists(at('BUG-REPORT.md'))) {
    const n = text('BUG-REPORT.md').replace(/\n+$/, '').split('\n').length;
    if (n > 40) problems.push(`BUG-REPORT.md is ${n} lines (limit 40)`);
  }

  for (const f of files) {
    const d = decodeText(fs.readFileSync(at(f)));
    if (!d) continue; // reported by the leak scan below
    const t = d.text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    if (t.includes('TODO(bundle)')) problems.push(`${f}: leftover TODO(bundle)`);
    if (f.toLowerCase().endsWith('.md')) {
      for (const raw of linkTargets(t)) {
        const rel = localTarget(raw);
        if (!rel) continue;
        let dec = rel;
        try { dec = decodeURIComponent(rel); } catch (e) { /* use as written */ }
        if (dec && !exists(path.resolve(path.dirname(at(f)), dec))) problems.push(`${f}: broken link ${raw}`);
      }
    }
  }

  if (!bad.length) {
    if (!exists(at(MANIFEST))) problems.push(`${MANIFEST} missing: run manifest`);
    else if (fs.readFileSync(at(MANIFEST), 'utf8') !== manifestText(dir, files)) {
      problems.push(`${MANIFEST} does not match the files: run manifest`);
    }
    try {
      const skipped = [];
      const texts = collectTexts([dir], { onSkip: (n) => skipped.push(n) });
      const hits = scanTexts(texts, { terms: terms.terms, names: [...terms.names, ...names], hosts, identity: [...identity, ...terms.identity], allow });
      for (const h of hits) problems.push(`leak: ${h.name}:${h.line}: ${h.term}`);
      // A file that can't be read as text is never scanned: say so, and refuse it where the evidence lives.
      const ok = new Set(allowBinary.map((a) => a.replace(/\\/g, '/').toLowerCase()));
      for (const label of skipped) {
        const rel = label.split('/').slice(1).join('/');
        console.error(`not scanned (binary): ${rel}`);
        const evidence = /^(?:evidence|error-report)\//.test(rel);
        if (evidence && !ok.has(rel.toLowerCase()) && !ok.has(path.posix.basename(rel).toLowerCase())) {
          problems.push(`${rel}: binary file in the evidence was not scanned (pass --allow-binary ${path.posix.basename(rel)} if it is meant to ship as is)`);
        }
      }
    } catch (e) {
      problems.push(`leak scan: ${e.message}`);
    }
  }
  return problems;
}

function checkOpts(opt, flags) {
  const terms = loadTerms(opt, flags);
  if (terms.missingDefault) console.error('no leak-terms file: run leak-terms init');
  console.error(summary(terms.terms, terms.names, terms.identity));
  return {
    terms,
    identity: flags.has('no-identity') ? [] : identityTerms(),
    names: opt.names ? readList(opt.names, 'names') : [],
    hosts: opt.hosts ? readList(opt.hosts, 'hosts') : [],
    allow: opt.allow,
    allowBinary: opt.allowBinary,
  };
}

function runCheck({ pos, opt, flags }) {
  if (pos.length !== 1) usage('usage: bundle.js check <dir> [--terms <file>]... [--no-user-terms] [--no-identity] [--names <file>] [--hosts <file>] [--allow <label|term>]... [--allow-binary <name>]...');
  const dir = path.resolve(pos[0]);
  if (!exists(dir)) usage(`no such folder: ${pos[0]}`);
  const problems = check(dir, checkOpts(opt, flags));
  if (problems.length) throw new Refused(problems);
  console.log('check passed');
}

function zip({ pos, opt, flags }) {
  if (pos.length !== 2) usage('usage: bundle.js zip <dir> <out.zip> [--terms <file>]... [--no-user-terms] [--no-identity] [--names <file>] [--hosts <file>] [--allow <label|term>]... [--allow-binary <name>]...');
  const dir = path.resolve(pos[0]);
  if (!exists(dir)) usage(`no such folder: ${pos[0]}`);
  const out = path.resolve(pos[1]);
  const top = path.basename(out).replace(/\.zip$/i, '');
  if (!top) usage('out must be a file name ending .zip');
  const problems = check(dir, checkOpts(opt, flags));
  if (problems.length) throw new Refused(problems);
  const { files } = listFiles(dir);
  const entries = files.map((f) => ({ name: `${top}/${f}`, data: fs.readFileSync(path.join(dir, ...f.split('/'))) }));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  try {
    writeZip(entries, `${out}.part`);
    fs.renameSync(`${out}.part`, out);
  } catch (e) {
    fs.rmSync(`${out}.part`, { force: true });
    throw new Refused([e.message]);
  }
  console.log(`wrote ${pos[1]} (${entries.length} files under ${top}/)`);
}

// ---------------------------------------------------------------- main

const COMMANDS = { init, validate, 'add-report': addReport, 'add-profiles': addProfiles, manifest, check: runCheck, zip };

function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (!COMMANDS[cmd]) usage(`usage: node bundle.js <${Object.keys(COMMANDS).join('|')}> ...`);
    COMMANDS[cmd](parseArgs(rest));
  } catch (e) {
    if (e instanceof Usage) {
      console.error(e.message);
      process.exit(64);
    }
    if (e instanceof Refused) {
      for (const l of e.list) console.log(`refusing: ${l}`);
      process.exit(2);
    }
    throw e;
  }
}

if (require.main === module) main(process.argv.slice(2));
