#!/usr/bin/env node
'use strict';
// Redacts home paths, IP addresses, character names, account logins, hosts and named JSON fields in
// upstream's error-report output. Exit 0 ok, 2 refused, 64 usage. Never prints the name/host mapping.
const fs = require('node:fs');
const path = require('node:path');
const { HOME_PATH_SRC, ACCOUNT_LOGIN_SRC, HANDSHAKE_LOGIN_SRC, CHARACTER_SHAPES, isRealName, literalSource } = require('./lib/patterns.js');
const { findIps } = require('./lib/ip.js');
const { decodeText, encodeText } = require('./lib/text.js');
const { loadUserTerms } = require('./lib/terms.js');

const DEFAULT_FIELDS = ['startedBy', 'environmentVariables'];

// Our own placeholders are never rewritten by a later stage (a name like "home" must not hit <home>).
const PLACEHOLDER = /(<(?:home|character-\d+|account-\d+|host-\d+|ip-\d+|redacted)>)/;
const outsidePlaceholders = (text, fn) => text.split(PLACEHOLDER).map((seg, i) => (i % 2 ? seg : fn(seg))).join('');

function newState() {
  return { names: new Map(), hosts: new Map(), accounts: new Map(), ips: new Map() };
}

// One alternation, longest first, so "Sam Lee" wins over "Sam". N is assigned on first appearance.
// latin1: the text came from a non-UTF-8 file, so non-ASCII terms also match as their UTF-8 bytes
// read as latin1; both spellings share one number.
function termReplacer(terms, map, prefix, counter, latin1 = false) {
  const base = [...new Set(terms.map((t) => t.trim()).filter(Boolean))];
  const canon = new Map();
  const list = [...base];
  if (latin1) {
    for (const t of base) {
      const alt = Buffer.from(t, 'utf8').toString('latin1');
      if (alt !== t) { list.push(alt); canon.set(alt.toLowerCase(), t.toLowerCase()); }
    }
  }
  list.sort((a, b) => b.length - a.length);
  if (!list.length) return (text) => text;
  const re = new RegExp(list.map(literalSource).join('|'), 'gi');
  return (text) =>
    outsidePlaceholders(text, (seg) =>
      seg.replace(re, (m) => {
        const key = canon.get(m.toLowerCase()) || m.toLowerCase();
        if (!map.has(key)) map.set(key, map.size + 1);
        counter.n++;
        return `<${prefix}-${map.get(key)}>`;
      }));
}

function redactFields(value, fields, counter) {
  if (Array.isArray(value)) return value.map((v) => redactFields(v, fields, counter));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (fields.includes(k) && v !== '<redacted>') {
        out[k] = '<redacted>';
        counter.n++;
      } else out[k] = redactFields(v, fields, counter);
    }
    return out;
  }
  return value;
}

// Parses JSON and redacts fields. A file that parses as one JSON value is handled whole; otherwise
// each line is parsed on its own when it starts with "{" (upstream's server-health.log is JSON
// lines), by content, not file name. A line that isn't whole JSON (a truncated log's cut first
// line) gets "<field>":<value> replaced by pattern. Re-serialises only when a field changed, so
// untouched files keep their bytes and line endings.
function applyFields(text, fields, counter) {
  if (!fields.length) return text;
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? text.slice(1) : text;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const t = body.trim();
  const redact = (src, indent) => {
    let parsed;
    try { parsed = JSON.parse(src); } catch (e) { return null; }
    const c = { n: 0 };
    const out = redactFields(parsed, fields, c);
    if (!c.n) return src;
    counter.n += c.n;
    return JSON.stringify(out, null, indent);
  };
  let stage = null;
  if (t.startsWith('{') || t.startsWith('[')) {
    const whole = redact(body, t.includes('\n') ? 2 : undefined);
    if (whole !== null) {
      stage = whole === body ? body : whole.replace(/\n/g, eol) + (/\n$/.test(body) ? eol : '');
    }
  }
  if (stage === null) {
    stage = body.split('\n').map((line) => {
      const cr = line.endsWith('\r') ? '\r' : '';
      const l = cr ? line.slice(0, -1) : line;
      if (l.trim().startsWith('{')) {
        const out = redact(l, undefined);
        if (out !== null) return out + cr;
      }
      return line;
    }).join('\n');
  }
  // Pattern pass for what parsing can't reach: a cut line, or a field inside an escaped JSON string.
  const result = looseLines(stage, fields, counter);
  return result === body ? text : bom + result;
}

const FRAGMENT_KEY = /\\?"[\w$-]+\\?"\s*:/g;
const AFTER_CUT = /Truncated:/;

// In an escaped JSON string (esc) every quote is preceded by a run of n backslashes. Even n: the
// enclosing string's own closing quote. Odd n: a quote of the inner JSON, which is the inner
// layer's real quote when (n-1)/2 is even and an escaped quote inside an inner string when odd.
function quoteKind(l, j) {
  let n = 0;
  while (n < j && l[j - 1 - n] === '\\') n++;
  if (n % 2 === 0) return 'enclosing';
  return ((n - 1) / 2) % 2 === 0 ? 'inner' : 'escaped';
}

// Balanced object/array (or string) value starting at i; to end of line if unbalanced or cut. Inside
// an escaped JSON string (esc) a cut value stops at that string's own closing quote.
function valueEnd(l, i, esc) {
  const c = l[i];
  if (c === '{' || c === '[') {
    let depth = 0, inStr = false;
    for (let j = i; j < l.length; j++) {
      const d = l[j];
      if (!esc && d === '\\') { j++; continue; }
      let quote = d === '"';
      if (esc && quote) {
        const k = quoteKind(l, j);
        if (k === 'enclosing') return j; // the enclosing string's own closing quote
        quote = k === 'inner';
      }
      if (quote) inStr = !inStr;
      else if (d === '"') continue;
      else if (!inStr && (d === '{' || d === '[')) depth++;
      else if (!inStr && (d === '}' || d === ']') && --depth === 0) return j + 1;
    }
    return l.length;
  }
  if (c === '"' || (c === '\\' && l[i + 1] === '"')) {
    for (let j = i + (c === '"' ? 1 : 2); j < l.length; j++) {
      if (esc) {
        if (l[j] !== '"') continue;
        const k = quoteKind(l, j);
        if (k === 'enclosing') return j; // enclosing string closes: value was cut
        if (k === 'inner') return j + 1; // the value's own closing \"
      } else if (l[j] === '"') return j + 1;
      else if (l[j] === '\\') j++;
    }
    return l.length;
  }
  const m = /^[^,}\]\s\\"]+/.exec(l.slice(i));
  return m ? i + m[0].length : i;
}

function looseLines(text, fields, counter) {
  const keys = fields.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const key = new RegExp('(\\\\?")(?:' + keys + ')\\1\\s*:\\s*', 'g');
  const lines = text.split('\n');
  let afterCut = false;
  return lines.map((line) => {
    const wasCut = afterCut;
    afterCut = AFTER_CUT.test(line);
    // Prose that merely mentions a field name is left alone: the line must look like JSON.
    const jsonLike = wasCut || /\{\\?"/.test(line) || (line.match(FRAGMENT_KEY) || []).length >= 2;
    if (!jsonLike) return line;
    let out = '', pos = 0, m;
    key.lastIndex = 0;
    while ((m = key.exec(line))) {
      const vStart = m.index + m[0].length;
      const esc = m[1] === '\\"';
      const vEnd = valueEnd(line, vStart, esc);
      const q = esc ? '\\"' : '"';
      const value = line.slice(vStart, vEnd);
      if (vEnd === vStart || value === q + '<redacted>' + q) { key.lastIndex = Math.max(vEnd, vStart); continue; }
      out += line.slice(pos, vStart) + q + '<redacted>' + q;
      pos = vEnd;
      key.lastIndex = vEnd;
      counter.n++;
    }
    return out + line.slice(pos);
  }).join('\n');
}

// Names found in the log shapes the server writes (session tag, "Created character", ...), whether or
// not the user's terms file lists them.
function discoverNames(text) {
  const found = new Set();
  for (const src of CHARACTER_SHAPES) {
    for (const m of text.matchAll(new RegExp(src, 'g'))) if (isRealName(m.groups.name)) found.add(m.groups.name.trim());
  }
  return [...found];
}

// IPv4 and IPv6 addresses to <ip-N>, numbered per bundle; loopback, unspecified and documentation
// addresses stay (see lib/ip.js).
function redactIps(text, state, counter) {
  return outsidePlaceholders(text, (seg) => {
    const parts = [];
    let pos = 0;
    for (const ip of findIps(seg)) {
      const key = ip.text.toLowerCase();
      if (!state.ips.has(key)) state.ips.set(key, state.ips.size + 1);
      parts.push(seg.slice(pos, ip.index), `<ip-${state.ips.get(key)}>`);
      pos = ip.index + ip.text.length;
      counter.n++;
    }
    return parts.join('') + seg.slice(pos);
  });
}

function redactText(text, { names = [], hosts = [], fields = [], state = newState(), latin1 = false } = {}) {
  const f = { n: 0 }, p = { n: 0 }, n = { n: 0 }, h = { n: 0 }, ip = { n: 0 };
  let out = applyFields(text, [...new Set([...DEFAULT_FIELDS, ...fields])], f);
  out = out.replace(new RegExp(HOME_PATH_SRC, 'g'), (m, sep) => { p.n++; return sep ? '<home>/' : '<home>'; });
  const accountN = (login) => {
    const key = login.toLowerCase();
    if (!state.accounts.has(key)) state.accounts.set(key, state.accounts.size + 1);
    n.n++;
    return `<account-${state.accounts.get(key)}>`;
  };
  out = redactIps(out, state, ip);
  out = out.replace(new RegExp(ACCOUNT_LOGIN_SRC, 'g'), (m, login, id) => `user=${accountN(login)}${id === undefined ? '' : `(${id})`}`);
  out = out.replace(new RegExp(HANDSHAKE_LOGIN_SRC, 'g'), (m, head, login) => `${head}"${accountN(login)}"`);
  for (const src of CHARACTER_SHAPES) {
    out = out.replace(new RegExp(src, 'g'), (...args) => {
      const { pre, name, post } = args[args.length - 1];
      if (!isRealName(name)) return args[0];
      const key = name.trim().toLowerCase();
      if (!state.names.has(key)) state.names.set(key, state.names.size + 1);
      n.n++;
      return `${pre}<character-${state.names.get(key)}>${post}`;
    });
  }
  out = termReplacer(names, state.names, 'character', n, latin1)(out);
  out = termReplacer(hosts, state.hosts, 'host', h, latin1)(out);
  return { text: out, counts: { names: n.n, hosts: h.n, paths: p.n, fields: f.n, ips: ip.n } };
}

const addCounts = (a, b) => { for (const k of Object.keys(a)) a[k] += b[k]; };

// Every file that can't be mirrored safely, listed in one go (symlinks, sockets, devices ...).
function findRefusals(root) {
  const bad = [];
  const walk = (p, label) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) bad.push(`symlink not allowed: ${label}`);
    else if (st.isDirectory()) for (const f of fs.readdirSync(p).sort()) walk(path.join(p, f), `${label}/${f}`);
    else if (!st.isFile()) bad.push(`not a regular file: ${label}`);
  };
  walk(root, path.basename(root));
  return bad;
}

const rel = (label) => label.split('/').slice(1).join('/');

// Redacts a whole tree into outPath. Text is decided by content (lib/text.js): UTF-8, UTF-8 with a BOM and
// UTF-16 with a BOM are redacted; a file that can't be decoded (binary) makes the whole run refuse,
// naming every such file, unless it is in allowBinary (a relative path or a bare file name); those are
// copied byte for byte and listed in `skipped`. Names found in the server's log shapes are redacted
// too, whether or not they are in `names` (`discovered` counts them). File and folder names get the
// same names and hosts replaced.
function redactTree(inPath, outPath, opts = {}) {
  const { allowBinary = [], ...rest } = opts;
  const total = { names: 0, hosts: 0, paths: 0, fields: 0, ips: 0 };
  const skipped = [];
  const notUtf8 = [];
  const refused = [];
  const state = newState();
  const files = [];
  const collect = (src, dst, label) => {
    const st = fs.lstatSync(src);
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(src).sort()) collect(path.join(src, f), path.join(dst, f), `${label}/${f}`);
    } else files.push({ src, label });
  };
  collect(inPath, '', path.basename(inPath));
  const allowed = new Set(allowBinary.map((a) => a.replace(/\\/g, '/').toLowerCase()));
  const isAllowed = (r) => allowed.has(r.toLowerCase()) || allowed.has(path.posix.basename(r).toLowerCase());
  const loaded = files.map(({ src, label }) => {
    const buf = fs.readFileSync(src);
    const d = decodeText(buf);
    const r = rel(label);
    if (!d) {
      if (!isAllowed(r)) refused.push(`binary file can't be redacted: ${r} (if it is meant to ship as is, pass --allow-binary ${path.posix.basename(r)})`);
    }
    return { src, label, r, buf, d };
  });
  if (refused.length) {
    const e = new Error(refused.join('\n'));
    e.refusals = refused;
    throw e;
  }
  const given = [...new Set(rest.names || [])];
  const known = new Set(given.map((x) => x.toLowerCase()));
  const discovered = [];
  for (const f of loaded) {
    if (!f.d) continue;
    for (const n of discoverNames(f.d.text)) if (!known.has(n.toLowerCase())) { known.add(n.toLowerCase()); discovered.push(n); }
  }
  const names = [...given, ...discovered];
  const segmentCounter = { n: 0 };
  const redactSeg = (seg) => {
    let out = termReplacer(names, state.names, 'character', segmentCounter)(seg);
    out = termReplacer(rest.hosts || [], state.hosts, 'host', segmentCounter)(out);
    return out.replace(/[<>]/g, '');
  };
  const dstOf = (outRoot, label) => path.join(outRoot, ...label.split('/').slice(1).map(redactSeg));
  // Write beside the target and move into place only when everything worked.
  const stage = `${outPath}.partial-${process.pid}`;
  const single = fs.lstatSync(inPath).isFile();
  try {
    if (!single) fs.mkdirSync(stage, { recursive: true });
    for (const f of loaded) {
      const dst = single ? stage : dstOf(stage, f.label);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      if (!f.d) {
        fs.writeFileSync(dst, f.buf);
        skipped.push(f.r);
        continue;
      }
      if (f.d.lossy) notUtf8.push(f.r);
      const r = redactText(f.d.text, { ...rest, names, state, latin1: f.d.lossy });
      fs.writeFileSync(dst, f.d.enc === 'utf8' && !f.d.bom ? Buffer.from(r.text, 'utf8') : encodeText(r.text, f.d.enc));
      addCounts(total, r.counts);
    }
    // keep empty directories too
    const walkDirs = (src, dst) => {
      for (const f of fs.readdirSync(src).sort()) {
        const sp = path.join(src, f);
        if (fs.lstatSync(sp).isDirectory()) {
          const dp = path.join(dst, redactSeg(f));
          fs.mkdirSync(dp, { recursive: true });
          walkDirs(sp, dp);
        }
      }
    };
    if (!single) walkDirs(inPath, stage);
    if (!fs.existsSync(outPath)) fs.renameSync(stage, outPath);
    else {
      fs.cpSync(stage, outPath, { recursive: true });
      fs.rmSync(stage, { recursive: true, force: true });
    }
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw e;
  }
  return { counts: total, skipped, notUtf8, discovered: discovered.length };
}

function usage(msg) {
  if (msg) console.error(msg);
  console.error('usage: node redact.js <in> <out> [--terms <file>]... [--no-user-terms] [--names <file>] [--hosts <file>] [--field <jsonKey>]... [--allow-binary <name>]...');
  process.exit(64);
}

const readList = (file, what) => {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch (e) {
    return usage(`cannot read ${what} file: ${file}`);
  }
};

// realpath of the deepest existing ancestor, plus the part that doesn't exist yet.
function realResolve(p) {
  const rest = [];
  let cur = p;
  while (!fs.existsSync(cur)) {
    rest.unshift(path.basename(cur));
    cur = path.dirname(cur);
  }
  return path.join(fs.realpathSync(cur), ...rest);
}

function main(argv) {
  const pos = [];
  const fields = [];
  let names = [], hosts = [], noUserTerms = false;
  const allowBinary = [];
  const termsFiles = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--names', '--hosts', '--field', '--terms', '--allow-binary'].includes(a)) {
      if (i + 1 >= argv.length) usage(`${a} needs a value`);
      const v = argv[++i];
      if (a === '--names') names = readList(v, 'names');
      else if (a === '--hosts') hosts = readList(v, 'hosts');
      else if (a === '--terms') termsFiles.push(v);
      else if (a === '--allow-binary') allowBinary.push(v);
      else fields.push(v);
    } else if (a === '--no-user-terms') noUserTerms = true;
    else if (a.startsWith('--')) usage(`unknown option: ${a}`);
    else pos.push(a);
  }
  if (pos.length !== 2) usage();
  const [inPath, outPath] = pos.map((p) => path.resolve(p));
  if (!fs.existsSync(inPath)) usage(`no such path: ${pos[0]}`);
  const realIn = fs.realpathSync(inPath);
  const realOut = realResolve(outPath);
  if (realIn === realOut) usage('in and out must differ: redact never writes over its input');
  if (realOut.startsWith(realIn + path.sep) || realIn.startsWith(realOut + path.sep)) {
    usage('in and out must not contain each other');
  }
  // The user terms' character names are redacted too (default file when it exists, plus every --terms file).
  try { names = [...names, ...loadUserTerms({ files: termsFiles, noUserTerms }).names]; } catch (e) { usage(e.message); }
  const refusals = findRefusals(inPath);
  if (refusals.length) {
    for (const x of refusals) console.error(`refusing: ${x}`);
    process.exit(2);
  }
  let r;
  try {
    r = redactTree(inPath, outPath, { names, hosts, fields, allowBinary });
  } catch (e) {
    for (const l of (e.refusals || [e.message])) console.error(`refusing: ${l}`);
    process.exit(2);
  }
  for (const x of r.notUtf8) console.error(`warning: not valid UTF-8: redacted as latin1, other bytes unchanged: ${x}`);
  for (const s of r.skipped) console.error(`not redacted: review by hand: ${s}`);
  const c = r.counts;
  console.error(`redacted: names ${c.names}, hosts ${c.hosts}, paths ${c.paths}, fields ${c.fields}, ips ${c.ips}`);
  if (r.discovered) console.error(`${r.discovered} character name(s) found in the logs were not in your terms and were redacted too: add them with leak-terms.js`);
  process.exit(0);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { redactText, redactTree, discoverNames };
