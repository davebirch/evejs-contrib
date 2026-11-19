'use strict';
// Proposes private terms for `leak-terms init`: identity, LAN-style names and character names
// found in a logs folder. Name formats are the server's own log lines: the session tag
// (user=<account>(<id>) char=<name>(<id>)), "Created character", CreateCharacterWithDoll and
// "[CharState] Applied <name>(<id>)".
const fs = require('node:fs');
const path = require('node:path');
const { findHosts } = require('./hosts.js');
const { readZip } = require('./zip.js');

const LOG_EXT = new Set(['.log', '.json', '.jsonl', '.txt']);
const MAX_FILE = 20 * 1024 * 1024;
// Formats the server writes (read from its source; names here are made up).
const NAME_RES = [
  { re: /\[Session \S+ user=(.+?)\(\d+\) char=(.+?)\(\d+\)\]/g, groups: [['account', 1], ['character', 2]] },
  { re: /\[CharService\] Created character "([^"]+)" with ID/g, groups: [['character', 1]] },
  { re: /CreateCharacterWithDoll: name="([^"]+)"/g, groups: [['character', 1]] },
  { re: /\[CharState\] Applied (.+?)\(\d+\) ship=/g, groups: [['character', 1]] },
];
const PLACEHOLDER = new Set(['undefined', 'null', 'none', 'unknown']);

// Log texts of a folder, or of a report .zip read in memory (nested zips too; nothing is unpacked).
function* zipTexts(source, depth = 0) {
  for (const { name, data } of readZip(source)) {
    if (name.toLowerCase().endsWith('.zip')) {
      if (depth < 5) yield* zipTexts(data, depth + 1);
    } else if (LOG_EXT.has(path.extname(name).toLowerCase()) && data.length <= MAX_FILE) {
      yield data.toString('utf8').replace(/^\uFEFF/, '');
    }
  }
}

function* logTexts(dir) {
  if (fs.statSync(dir).isFile()) {
    yield* zipTexts(dir);
    return;
  }
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* logTexts(p);
    else if (ent.isFile() && LOG_EXT.has(path.extname(ent.name).toLowerCase())) {
      if (fs.statSync(p).size <= MAX_FILE) yield fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    }
  }
}

function scanLogs(dir) {
  const names = new Set();
  const accounts = new Set();
  const hosts = new Set();
  for (const text of logTexts(dir)) {
    for (const { re, groups } of NAME_RES) for (const m of text.matchAll(re)) {
      for (const [kind, g] of groups) {
        const n = m[g].trim();
        if (n.length < 3 || /^\d+$/.test(n) || PLACEHOLDER.has(n.toLowerCase())) continue;
        (kind === 'character' ? names : accounts).add(n);
      }
    }
    for (const line of text.split('\n')) for (const h of findHosts(line)) hosts.add(h);
  }
  return { names: [...names].sort(), accounts: [...accounts].sort(), hosts: [...hosts].sort() };
}

// Returns [{term, source, kind: 'term'|'character'}], deduplicated case-insensitively.
function candidates({ identity = [], logsDir = null } = {}) {
  const out = [];
  const seen = new Set();
  const add = (term, source, kind) => {
    const k = term.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ term, source, kind });
  };
  for (const t of identity) add(t, 'your identity (git, login or host name)', 'term');
  if (logsDir) {
    const { names, accounts, hosts } = scanLogs(logsDir);
    for (const h of hosts) add(h, 'LAN-style name in logs', 'term');
    for (const a of accounts) add(a, 'account name in logs', 'term');
    for (const n of names) add(n, 'character name in logs', 'character');
  }
  return out;
}

module.exports = { candidates, scanLogs };
