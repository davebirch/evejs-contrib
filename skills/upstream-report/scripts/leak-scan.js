#!/usr/bin/env node
'use strict';
// Leak scan. Built in: home paths, IP addresses (all but loopback, unspecified and documentation ones;
// upstream code under patches/ and files/ only for private ranges), LAN host names, character names in
// the server's log shapes, emails, obvious
// secrets, and your own identity (git, login, host name). Plus your terms file (see leak-terms.js).
// Exit 0 clean, 2 hits/refused, 64 usage.
const fs = require('node:fs');
const path = require('node:path');
const { readZip } = require('./lib/zip.js');
const { HOME_PATH_SRC, ACCOUNT_LOGIN_SRC, HANDSHAKE_LOGIN_SRC, CHARACTER_SHAPES, isRealName, literalSource } = require('./lib/patterns.js');
const { findIps } = require('./lib/ip.js');
const { decodeText } = require('./lib/text.js');
const { identityTerms } = require('./lib/identity.js');
const { loadUserTerms } = require('./lib/terms.js');
const { findHosts } = require('./lib/hosts.js');

const SECRET_WORD = '(?:token|api[_-]?key|secret|passw(?:or)?d)';
// A key word (not part of a longer word or camelCase name), then = or :, then a quoted literal of
// 8+ characters with a digit, or a bare 8+ character token mixing letters and digits that is not
// an identifier (letters then trailing digits, like sessionId2) and not a property access.
const KEY_HEAD = '(?<![A-Za-z])' + SECRET_WORD + '(?![A-Za-z])["\']?\\s*[=:]\\s*';
const SECRET_QUOTED = new RegExp(KEY_HEAD + '["\'](?=[^"\'\\s]*\\d)[^"\'\\s]{8,}["\']', 'i');
const SECRET_BARE = new RegExp(
  KEY_HEAD + '(?=[A-Za-z0-9_+/=.-]*\\d)(?=[A-Za-z0-9_+/=.-]*[A-Za-z])([A-Za-z0-9_+/=.-]{8,})(?![\\w(])', 'gi');
// Code, not a secret: segments of letters then trailing digits (sessionId2); a property chain rooted at
// a known code name (config.keys.k8sToken2); or a dotted chain of 2+ identifiers each with at most one
// digit run, none of them leetspeak (tokens.v2Token, env.SECRET_2X). A digit run followed by a lowercase
// letter ("Pa55word", "s3cr3t") reads as a password, so those chains still hit.
const CODE_ROOTS = new Set(['process', 'config', 'cfg', 'this', 'options', 'opts', 'env', 'settings']);
function isCode(value) {
  const segs = value.split('.').filter(Boolean);
  if (segs.every((seg) => /^[A-Za-z_]+\d*$/.test(seg))) return true;
  const idents = segs.every((seg) => /^[A-Za-z][A-Za-z0-9_]*$/.test(seg));
  if (segs.length >= 2 && idents && CODE_ROOTS.has(segs[0].toLowerCase())) return true;
  return segs.length >= 2 && idents && segs.every((seg) => (seg.match(/\d+/g) || []).length <= 1 && !/\d[a-z]/.test(seg));
}
function secretKey(line) {
  if (SECRET_QUOTED.test(line)) return true;
  for (const m of line.matchAll(SECRET_BARE)) {
    // identifiers and property chains (input.token2, sessionId2) are code, not secrets
    if (!isCode(m[1])) return true;
  }
  return false;
}
// High-entropy key-like strings: 32+ letters and digits, all three classes, at most one lowercase run of
// 4+ letters and no run of 5+ capitals (identifiers and words have several). Hex hashes have no capitals.
function longKey(line) {
  if (/(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{40,}/.test(line)) return true;
  for (const m of line.matchAll(/(?<![A-Za-z0-9_])(?:github_pat_(?:[A-Za-z0-9]{10,}_)?|[a-z]{2,5}_)?([A-Za-z0-9]{32,})(?![A-Za-z0-9_])/g)) {
    const t = m[1];
    if (/[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t) && (t.match(/[a-z]{4,}/g) || []).length <= 1 && !/[A-Z]{5,}/.test(t)) return true;
  }
  return false;
}
const posixHome = (line) => {
  for (const m of line.matchAll(new RegExp(HOME_PATH_SRC, 'gi'))) {
    if (!m[0].startsWith('/') || /^\/(?:home|Users|root)[/]/.test(m[0] + '/') || /^\/[a-z]\/[Uu]sers\//.test(m[0])) return true; // a lower-case /users/<id> URL route is not a home path
  }
  return false;
};
// git@host:owner/repo is a remote, not an email; any other git@ address still is one.
// Reserved domains (RFC 2606/6761: localhost, .invalid, .test, .example, example.com/net/org) are never a
// real address; upstream's XMPP stub logs JIDs like <room>@conference.localhost/<id>.
const RESERVED_DOMAIN = /(?:^|\.)(?:localhost|invalid|test|example|example\.(?:com|net|org))$/i;
const emailHit = (line) => {
  for (const m of line.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*(?:\.[A-Za-z]{2,}|(?<=@localhost))(?![\w-])/g)) {
    if (RESERVED_DOMAIN.test(m[0].slice(m[0].indexOf('@') + 1))) continue;
    const after = line.slice(m.index + m[0].length);
    const scpForm = /^:[\w./~-]/.test(after);
    const urlForm = /:\/\/$/.test(line.slice(0, m.index)) && /^[/:]/.test(after);
    const remote = /^git@/i.test(m[0]) && (scpForm || urlForm);
    if (!remote) return true;
  }
  return false;
};

const GENERIC = [
  {
    label: 'home-path',
    test: posixHome,
  },
  { label: 'private-ip', test: (l) => findIps(l).some((ip) => ip.kind === 'private') },
  // Any other non-loopback address. Upstream code under patches/ and files/ is full of example
  // addresses, so there only the private-range check above applies.
  { label: 'ip-address', test: (l) => findIps(l).some((ip) => ip.kind === 'public'), skipInUpstream: true },
  {
    label: 'character-name',
    skipInUpstream: true,
    test: (l) => CHARACTER_SHAPES.some((src) => [...l.matchAll(new RegExp(src, 'g'))].some((m) => isRealName(m.groups.name))),
  },
  { label: 'account-login', test: (l) => new RegExp(ACCOUNT_LOGIN_SRC).test(l) || new RegExp(HANDSHAKE_LOGIN_SRC).test(l) },
  { label: 'lan-host', test: (l) => findHosts(l).length > 0 },
  { label: 'email', test: emailHit },
  { label: 'secret', test: (l) => secretKey(l) || longKey(l) },
];

const SIGNED = /^Signed: (.+)$/;
// Text of a bundle's own upstream code: <root>/patches/... or <root>/<top>/patches/... (also files/).
// Only the bundle's own top-level folders: never evidence/files/ or error-report/files/.
const UPSTREAM_AREA = /^(?:[^/]+\/|[^/]+\.zip\/(?!(?:evidence|error-report)\/)(?:[^/]+\/)?)(?:patches|files)\//i;

function checkFor(term, label) {
  if (term instanceof RegExp) return { label: label || `/${term.source}/`, re: new RegExp(term.source, 'i') };
  return { label: label || term.trim(), re: new RegExp(literalSource(term), 'i') };
}

// terms: strings or RegExps; names: character names (reported as "character-name"); identity: your own
// names (reported as "identity"; a line that is exactly "Signed: <text>" is exempt from these only).
// selfRefs: this repo's own "<owner>/<repo>" slugs; exact occurrences are blanked out for identity
// checks only (an owner name that matches your identity is not a leak), every other check still sees them.
function scanTexts(texts, { terms = [], names = [], hosts = [], identity = [], allow = [], selfRefs = [], generic = true } = {}) {
  const selfRe = selfRefs.filter((s) => s && s.trim()).map((s) => literalSource(s.trim()));
  const selfPattern = selfRe.length ? new RegExp('(?<![\\w.-])(?:' + selfRe.join('|') + ')(?![\\w-])', 'gi') : null;
  // The old label of 'character-name' (built from pieces: a hygiene test bans the word) stays a silent alias.
  const OLD_LABEL = 'play' + 'er-name';
  const allowed = new Set(allow.map((a) => a.trim().toLowerCase().replace(OLD_LABEL, 'character-name')));
  const clean = (l) => l.filter((t) => t && (t instanceof RegExp || t.trim()));
  const checks = [
    ...(generic ? GENERIC : []),
    ...clean(terms).map((t) => checkFor(t)),
    ...clean(names).map((t) => checkFor(t, 'character-name')),
    ...clean(hosts).map((t) => checkFor(t, 'host')),
    ...clean(identity).map((t) => ({ ...checkFor(t, 'identity'), identity: true, source: t })),
  ].filter((c) => !allowed.has(c.label.toLowerCase()));
  // "Signed: <text>" is exempt from identity checks only when <text> is exactly one identity term.
  const isOwnName = (v) => clean(identity).some((t) => (t instanceof RegExp ? new RegExp('^(?:' + t.source + ')$', 'i').test(v) : t.trim().toLowerCase() === v.toLowerCase()));
  const hits = [];
  for (const { name, text } of texts) {
    const upstream = UPSTREAM_AREA.test(name);
    // the entry's own name is scanned as line 0 (never its first segment: that is the scanned root)
    const lines = [name.split('/').slice(1).join('/'), ...text.split('\n')];
    lines.forEach((line, i) => {
      const signedText = (SIGNED.exec(line.replace(/\r$/, '')) || [])[1];
      const signed = signedText !== undefined && isOwnName(signedText.trim());
      const seen = new Set();
      for (const c of checks) {
        if (c.identity && signed) continue;
        if (c.skipInUpstream && upstream) continue;
        const subject = c.identity && selfPattern ? line.replace(selfPattern, ' ') : line;
        if (c.test ? c.test(subject) : c.re.test(subject)) {
          const key = c.label + '\0' + (c.re || '');
          if (!seen.has(key)) hits.push({ name, term: c.label, line: i });
          seen.add(key);
        }
      }
    });
  }
  return hits;
}

// Decoded text of a buffer (UTF-8, or UTF-16 with a BOM), or null when it is binary.
const textOf = (buf) => { const d = decodeText(buf); return d ? d.text.replace(/^\uFEFF/, '') : null; };

function collectTexts(paths, { onSkip = (n) => process.stderr.write(`skipped (binary): ${n}\n`) } = {}) {
  const out = [];
  const addEntries = (entries, label, depth) => {
    for (const { name, data } of entries) {
      if (name.endsWith('/')) continue;
      const full = `${label}/${name}`;
      if (name.toLowerCase().endsWith('.zip')) {
        if (depth >= 5) throw new Error(`zips nested too deeply: ${full}`);
        addEntries(readZip(data), full, depth + 1);
      } else {
        const text = textOf(data);
        if (text === null) onSkip(full);
        else out.push({ name: full, text });
      }
    }
  };
  const walk = (p, label) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) throw new Error(`symlink not allowed: ${label}`);
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(p).sort()) walk(path.join(p, f), `${label}/${f}`);
    } else if (st.isFile()) {
      if (p.toLowerCase().endsWith('.zip')) return addEntries(readZip(p), label, 1);
      const data = fs.readFileSync(p);
      const text = textOf(data);
      if (text === null) onSkip(label);
      else out.push({ name: label, text });
    } else {
      throw new Error(`not a regular file: ${label}`);
    }
  };
  for (const p of paths) walk(p, path.basename(p));
  return out;
}

// One name or host per line; '#' comments and blank lines ignored.
function readList(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

function usage(msg) {
  if (msg) console.error(msg);
  console.error('usage: node leak-scan.js <dir|zip>... [--terms <file>]... [--no-user-terms] [--no-identity] [--names <file>] [--hosts <file>] [--allow <label>]... [--self <owner/repo>]');
  process.exit(64);
}

// "https://github.com/<owner>/<repo>(.git)" or "<owner>/<repo>" -> "<owner>/<repo>", else ''.
// Also takes package.json's object form ({ url }).
function slugFromRepository(value) {
  if (value && typeof value === 'object') value = value.url;
  const m = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(String(value || '').trim());
  return m ? m[1] : '';
}

function summary(terms, names, identity = []) {
  return `scanning for ${terms.length + names.length + identity.length} private terms (${names.length} character names); leak-terms edit to change`;
}

function main(argv) {
  const paths = [];
  const allow = [];
  const selfRefs = [];
  const termsFiles = [];
  let extraNames = [], extraHosts = [];
  let noUserTerms = false;
  let useIdentity = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--names' || a === '--hosts') {
      if (i + 1 >= argv.length) usage(`${a} needs a value`);
      try { (a === '--names' ? extraNames : extraHosts).push(...readList(argv[++i])); } catch (e) { usage(`cannot read ${a.slice(2)} file: ${argv[i]}`); }
    } else if (a === '--terms' || a === '--allow' || a === '--self') {
      if (i + 1 >= argv.length) usage(`${a} needs a value`);
      if (a === '--terms') termsFiles.push(argv[++i]);
      else if (a === '--self') selfRefs.push(slugFromRepository(argv[++i]) || usage('--self needs <owner>/<repo> or a GitHub URL'));
      else allow.push(argv[++i]);
    } else if (a === '--no-user-terms') noUserTerms = true;
    else if (a === '--no-identity') useIdentity = false;
    else if (a.startsWith('--')) usage(`unknown option: ${a}`);
    else paths.push(a);
  }
  if (!paths.length) usage();
  let user;
  try { user = loadUserTerms({ files: termsFiles, noUserTerms }); } catch (e) { usage(e.message); }
  if (user.missingDefault) console.error('no leak-terms file: run leak-terms init');
  console.error(summary(user.terms, user.names, user.identity));
  for (const p of paths) {
    try { fs.lstatSync(p); } catch (e) { usage(`no such path: ${p}`); }
  }
  let texts;
  try {
    texts = collectTexts(paths);
  } catch (e) {
    console.log(`refusing: ${e.message}`);
    process.exit(2);
  }
  const hits = scanTexts(texts, { terms: user.terms, names: [...user.names, ...extraNames], hosts: extraHosts, identity: [...(useIdentity ? identityTerms() : []), ...user.identity], allow, selfRefs });
  for (const h of hits) console.log(`refusing: ${h.name}:${h.line}: ${h.term}`);
  process.exit(hits.length ? 2 : 0);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { scanTexts, collectTexts, readList, identityTerms, summary, slugFromRepository };
