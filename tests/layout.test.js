'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

test('the version lives only in plugin.json and package.json, and they match', () => {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
  const plugin = read('.claude-plugin/plugin.json');
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
  assert.equal(read('package.json').version, plugin.version);
  const market = read('.claude-plugin/marketplace.json');
  assert.ok(!('version' in market), 'marketplace.json has a version');
  for (const p of market.plugins || []) assert.ok(!('version' in p), `marketplace entry ${p.name} has a version`);
});

test('plugin.json', () => {
  const p = readJson('.claude-plugin/plugin.json');
  assert.equal(p.name, 'evejs-contrib');
  assert.equal(typeof p.description, 'string');
  assert.ok(p.description.length > 0);
  assert.match(p.version, /^\d+\.\d+\.\d+$/);
  assert.equal(p.license, 'MIT');
  assert.deepEqual(p.author, { name: 'evejs-contrib contributors' }, 'a generic author, no personal name (validate --strict wants one)');
});

test('marketplace.json', () => {
  const m = readJson('.claude-plugin/marketplace.json');
  assert.equal(m.name, 'evejs-contrib');
  assert.equal(m.owner.name, 'evejs-contrib contributors');
  assert.deepEqual(m.plugins.map(({ name, source }) => ({ name, source })), [
    { name: 'evejs-contrib', source: './' },
  ]);
});

test('LICENSE', () => {
  const l = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
  assert.ok(l.startsWith('MIT License'));
  assert.ok(l.includes('Copyright (c) 2026 evejs-contrib contributors'));
});

function parseFrontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(m, 'missing front matter');
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    assert.ok(
      !/^[>|][0-9+-]*\s*(#.*)?$/.test(kv[2]),
      `front matter key "${kv[1]}" uses a folded/block scalar; write it on one line`,
    );
    out[kv[1]] = kv[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

function lineCount(text) {
  return text.replace(/\r?\n$/, '').split(/\r?\n/).length;
}

test('parseFrontMatter helpers', () => {
  assert.deepEqual(parseFrontMatter('---\nname: a\ndescription: "Use when x: y"\n---\nbody\n'),
    { name: 'a', description: 'Use when x: y' });
  assert.deepEqual(parseFrontMatter("---\r\nname: a\r\ndescription: 'Use when z'\r\n---\r\nbody\r\n"),
    { name: 'a', description: 'Use when z' });
  assert.deepEqual(Object.keys(parseFrontMatter('---\nname: a\ndescription: d\nextra: 1\n---\n')).sort(),
    ['description', 'extra', 'name']);
  assert.throws(() => parseFrontMatter('---\nname: a\ndescription: >\n  Use when\n---\n'), /block scalar/);
  assert.throws(() => parseFrontMatter('no front matter'), /missing front matter/);
  assert.equal(lineCount('a\nb\n'), 2);
  assert.equal(lineCount('a\nb'), 2);
  assert.equal(lineCount('a\r\nb\r\n'), 2);
});

const skillsDir = path.join(root, 'skills');
const skills = fs.existsSync(skillsDir)
  ? fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(skillsDir, d.name, 'SKILL.md')))
      .map((d) => d.name)
  : [];

for (const name of skills) {
  test(`skill ${name}`, () => {
    const text = fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8');
    const fm = parseFrontMatter(text);
    const at = `skill ${name}`;
    assert.deepEqual(Object.keys(fm).sort(), ['description', 'name'], `${at}: front matter keys must be exactly name and description`);
    assert.equal(fm.name, name, `${at}: name must match the folder`);
    assert.match(fm.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${at}: name must be lowercase letters, digits, single hyphens`);
    assert.ok(fm.name.length <= 64, `${at}: name must be at most 64 chars`);
    assert.ok(fm.description.startsWith('Use when'), `${at}: description must start "Use when"`);
    assert.ok(fm.description.length <= 1024, `${at}: description must be at most 1024 chars`);
    assert.ok(lineCount(text) < 200, `${at}: SKILL.md must be under 200 lines`);
  });
}

test('both skills are found', () => {
  assert.ok(skills.includes('upstream-report'), 'skills/upstream-report/SKILL.md missing');
  assert.ok(skills.includes('upstream-report-perf'), 'skills/upstream-report-perf/SKILL.md missing');
});

test('perf skill, evidence shape and comparison skeleton state the pristine-baseline condition', () => {
  for (const rel of ['skills/upstream-report-perf/SKILL.md', 'skills/upstream-report-perf/references/evidence-shape.md', 'skills/upstream-report-perf/assets/evidence-skeleton/performance-comparison.md']) {
    const t = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.match(t, /pristine/i, `${rel}: must say the baseline is the pristine release`);
    assert.match(t, /prerequisite/i, `${rel}: must mention the patch's prerequisites`);
  }
});

// Wording hygiene: the shared repo never names the private things or the setup it was born in. The list
// is a hashed list of words the wording rule bans (SHA-256 of each lowercased word), so this file does
// not name them itself. Each word token of a tracked text file (lowercased, split on non-letters, also
// with a trailing "s" stripped) is checked against the set. The last digest is the one for the word in
// upstream's own `.json` profiler file name, which is allowed when the token is followed by `.json`.
const crypto = require('node:crypto');
const BANNED_DIGESTS = [
  'cdb59355f3ba293977fc0945fb85f11822d412c45c7520c7121bd2234f6c1f48',
  'ebf20cefc9169e0b714703d63d480c3e63c64a8535a13acf5a62ea66c5f0ea8c',
  'cde48537ca2c28084ff560826d0e6388b7c57a51497a6cb56f397289e52ff41b',
  '795b104abe3e4134960ca245ded0e617f162c751209347b7f003bc35e062f43e',
  '5460b4688ee74bb2b768fc995034192e22f0f9efdd28daf6dff46e215782ad89',
  'ec9a6e9fe278eb1a471fbab6f40367d8548078b651d9c71581c57c2a6ca379e0',
];
const JSON_NAME_DIGEST = BANNED_DIGESTS[BANNED_DIGESTS.length - 1];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const bannedSet = new Set(BANNED_DIGESTS);

function bannedTokens(line) {
  const hits = [];
  for (const m of line.matchAll(/[A-Za-z]+/g)) {
    const w = m[0].toLowerCase();
    const forms = w.endsWith('s') ? [w, w.slice(0, -1)] : [w];
    if (!forms.some((f) => bannedSet.has(sha(f)))) continue;
    if (sha(w) === JSON_NAME_DIGEST && line.startsWith('.json', m.index + m[0].length)) continue;
    hits.push(m.index);
  }
  return hits;
}

test('hygiene: no setup-specific wording in tracked files', () => {
  const { execFileSync } = require('node:child_process');
  let files;
  try { files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean); } catch (e) { return; }
  // The two files that parse the older names of the character-names section and flag are the only places
  // those words appear.
  const ALIASES = new Set(['skills/upstream-report/scripts/lib/terms.js', 'skills/upstream-report/scripts/leak-terms.js']);
  for (const f of files) {
    if (ALIASES.has(f) || /\.zip$/.test(f)) continue;
    let text;
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch (e) { continue; }
    text.split('\n').forEach((l, i) => {
      assert.equal(bannedTokens(l).length, 0, `${f}:${i + 1}`);
    });
  }
});

test('hygiene: the hashed wording check still fires', () => {
  const word = (codes) => String.fromCharCode(...codes);
  const banned = word([102, 114, 105, 101, 110, 100]); // assembled at runtime, not written out
  const jsonName = word([108, 97, 117, 110, 99, 104, 101, 114]);
  const tmp = path.join(require('node:os').tmpdir(), `wording-selftest-${process.pid}.txt`);
  fs.writeFileSync(tmp, `a ${banned}s b\n${jsonName}.json ok\n${jsonName} bad\n`);
  try {
    const lines = fs.readFileSync(tmp, 'utf8').split('\n');
    assert.equal(bannedTokens(lines[0]).length, 1, 'plural form must be caught');
    assert.equal(bannedTokens(lines[1]).length, 0, '.json file name must be allowed');
    assert.equal(bannedTokens(lines[2]).length, 1, 'bare word must be caught');
  } finally { fs.rmSync(tmp, { force: true }); }
});
