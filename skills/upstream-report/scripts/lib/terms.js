'use strict';
// User terms file. One term per line; '#' comments and blank lines ignored.
// Plain text = whole word, case-insensitive. /regex/ = JS pattern (case-insensitive).
// "[character-names]" starts the character-names section, "[identity]" the identity section (your own
// names: the exact "Signed: <text>" line is exempt from these only); "[terms]" returns to plain terms.
const fs = require('node:fs');
const { defaultTermsPath } = require('./config.js');

// The older section name still parses (silently): files written before the rename keep working.
const OLD_NAMES_HEADER = '[' + 'play' + 'er-names]';
const NAMES_HEADER = '[character-names]';
const SECTIONS = { [NAMES_HEADER]: 'names', [OLD_NAMES_HEADER]: 'names', '[identity]': 'identity', '[terms]': 'terms' };

function parseTerms(raw, label = 'terms file') {
  const out = { terms: [], names: [], identity: [] };
  let section = 'terms';
  raw.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    if (SECTIONS[t]) return void (section = SECTIONS[t]);
    const m = t.match(/^\/(.+)\/$/);
    let term = t;
    if (m) {
      try {
        term = new RegExp(m[1], 'i');
      } catch (e) {
        throw new Error(`${label}:${i + 1}: bad regex ${t}: ${e.message}`);
      }
    }
    // character names are plain text only (as before): a /regex/ line there stays a literal string
    out[section].push(section === 'names' ? t : term);
  });
  return out;
}

function readTermsFile(path) {
  return parseTerms(fs.readFileSync(path, 'utf8'), path);
}

// The user's terms: the default file (unless noUserTerms) plus every explicit file; all are read and
// merged. An explicit file must exist (throws); a missing default is reported, not an error.
function loadUserTerms({ files = [], noUserTerms = false } = {}) {
  const def = defaultTermsPath();
  const defaultExists = fs.existsSync(def);
  const used = [];
  if (!noUserTerms && defaultExists) used.push(def);
  for (const f of files) {
    if (!fs.existsSync(f)) throw new Error(`cannot read terms file: ${f}`);
    if (!used.includes(f)) used.push(f);
  }
  const merged = { terms: [], names: [], identity: [], files: used, missingDefault: !noUserTerms && !defaultExists && !files.length };
  for (const f of used) {
    const t = readTermsFile(f);
    for (const k of ['terms', 'names', 'identity']) merged[k].push(...t[k]);
  }
  return merged;
}

const HEADER = `# Leak terms: anything else you'd rather not share. One term per line.
#   plain text = whole word, case-insensitive; /regex/ = JavaScript pattern.
# Edit with: node <skill folder>/scripts/leak-terms.js edit
`;

const isHeader = (l) => /^\[[^\]]*\]$/.test(l.trim());

// Line-based edit so the user's own comments survive. add/remove: plain terms; character: character
// names (an existing old-style names section is reused); identity: your own names, written under
// [identity]; a plain term that is already in the file moves there.
function editTermsText(text, { add = [], remove = [], character = [], identity = [] } = {}) {
  let lines = (text || HEADER).replace(/^\uFEFF/, '').replace(/\r?\n$/, '').split(/\r?\n/);
  const drop = new Set(remove.map((s) => s.trim().toLowerCase()));
  lines = lines.filter((l) => !drop.has(l.trim().toLowerCase()) || l.trim().startsWith('#') || isHeader(l));
  const has = (v) => lines.some((l) => l.trim().toLowerCase() === v.trim().toLowerCase());
  const addTo = (header, v) => {
    if (!v.trim()) return;
    if (header === '[identity]') {
      // move a plain term of the same text out of the plain/names sections, into [identity]
      let sec = '';
      lines = lines.filter((l) => {
        if (isHeader(l)) { sec = l.trim(); return true; }
        return !(sec !== '[identity]' && !l.trim().startsWith('#') && l.trim().toLowerCase() === v.trim().toLowerCase());
      });
    }
    if (has(v)) return;
    if (!header) {
      const h = lines.findIndex(isHeader);
      if (h < 0) lines.push(v.trim());
      else lines.splice(h, 0, v.trim());
      return;
    }
    let h = lines.findIndex((l) => l.trim() === header);
    if (h < 0) {
      lines.push('', header);
      h = lines.length - 1;
    }
    let end = h + 1;
    while (end < lines.length && !isHeader(lines[end])) end++;
    while (end > h + 1 && !lines[end - 1].trim()) end--; // keep blank lines before the next section
    lines.splice(end, 0, v.trim());
  };
  add.forEach((v) => addTo(null, v));
  identity.forEach((v) => addTo('[identity]', v));
  const namesHeader = lines.find((l) => l.trim() === OLD_NAMES_HEADER) ? OLD_NAMES_HEADER : NAMES_HEADER;
  character.forEach((v) => addTo(namesHeader, v));
  return lines.join('\n') + '\n';
}

module.exports = { readTermsFile, parseTerms, loadUserTerms, editTermsText, HEADER };
