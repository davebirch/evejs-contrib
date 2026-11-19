'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readZip } = require('../skills/upstream-report/scripts/lib/zip.js');

const REPO = path.join(__dirname, '..');
const BUILD = path.join(REPO, 'scripts', 'build-zip.js');
const tmp = () => require('./fixtures/tmp.js').mk('zip-build-');
const CONFIG = tmp(); // no terms file inside, never the real config dir
const run = (args, cwd = REPO) =>
  spawnSync(process.execPath, [BUILD, ...args], { encoding: 'utf8', cwd, env: { ...process.env, EVEJS_CONTRIB_CONFIG_DIR: CONFIG } });

// A copy of the sources only (no .git, dist, node_modules).
function copyRepo() {
  const dir = tmp();
  for (const f of ['.claude-plugin', 'skills', 'LICENSE', 'README.md', 'package.json']) {
    fs.cpSync(path.join(REPO, f), path.join(dir, f), { recursive: true });
  }
  return dir;
}
const version = JSON.parse(fs.readFileSync(path.join(REPO, '.claude-plugin', 'plugin.json'), 'utf8')).version;

test('zip has both layouts with identical bytes and nothing else', () => {
  const out = tmp();
  const r = run(['--out', out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const zipPath = path.join(out, `evejs-contrib-${version}.zip`);
  assert.equal(r.stdout.trim(), zipPath);
  const entries = readZip(zipPath);
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  const claude = byName.get('evejs-contrib/skills/upstream-report/SKILL.md');
  assert.ok(claude && claude.length);
  assert.ok(claude.equals(byName.get('evejs-contrib/.agents/skills/upstream-report/SKILL.md')));
  for (const n of byName.keys()) {
    if (n.startsWith('evejs-contrib/skills/')) {
      assert.ok(byName.get(n).equals(byName.get(n.replace('evejs-contrib/skills/', 'evejs-contrib/.agents/skills/'))), n);
    }
    assert.ok(/^evejs-contrib\/(\.claude-plugin\/|skills\/|\.agents\/skills\/|LICENSE$|README\.md$)/.test(n), `unexpected entry ${n}`);
  }
  for (const want of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'LICENSE', 'README.md']) {
    assert.ok(byName.has(`evejs-contrib/${want}`), want);
  }
  assert.ok(![...byName.keys()].some((n) => /^evejs-contrib\/(tests|dist|\.git|\.github|node_modules|scripts)\/|package\.json|plugin-release|build-zip/.test(n)));
});

test('refuses a symlink in the sources', (t) => {
  const dir = copyRepo();
  try { fs.symlinkSync(path.join(dir, 'LICENSE'), path.join(dir, 'skills', 'link')); } catch (e) { return t.skip('symlinks unavailable'); }
  const r = run(['--root', dir, '--out', tmp()]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /symlink not allowed: skills\/link/);
});

test('refuses a planted --terms word', () => {
  const dir = copyRepo();
  fs.appendFileSync(path.join(dir, 'README.md'), '\nthe flurbo project\n');
  const terms = path.join(tmp(), 'terms');
  fs.writeFileSync(terms, 'flurbo\n');
  const out = tmp();
  const r = run(['--root', dir, '--out', out, '--terms', terms]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /README\.md:\d+: flurbo/);
  assert.deepEqual(fs.readdirSync(out), []);
});

test('--terms adds to the default user file; --no-user-terms opts out', () => {
  const dir = copyRepo();
  fs.appendFileSync(path.join(dir, 'README.md'), '\nthe flurbo and acme projects\n');
  const cfg = tmp();
  fs.writeFileSync(path.join(cfg, 'leak-terms'), 'acme\n');
  const terms = path.join(tmp(), 'terms');
  fs.writeFileSync(terms, 'flurbo\n');
  const go = (...a) => spawnSync(process.execPath, [BUILD, '--root', dir, '--out', tmp(), ...a], { encoding: 'utf8', env: { ...process.env, EVEJS_CONTRIB_CONFIG_DIR: cfg } });
  const r = go('--terms', terms);
  assert.match(r.stdout, /flurbo/);
  assert.match(r.stdout, /acme/);
  const r2 = go('--terms', terms, '--no-user-terms');
  assert.match(r2.stdout, /flurbo/);
  assert.doesNotMatch(r2.stdout, /acme/);
});

test('refuses a generic leak (home path)', () => {
  const dir = copyRepo();
  fs.appendFileSync(path.join(dir, 'README.md'), '\nsee /home/sam/x\n');
  const r = run(['--root', dir, '--out', tmp()]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /README\.md:\d+: home-path/);
});

test('refuses a skill without SKILL.md', () => {
  const dir = copyRepo();
  fs.mkdirSync(path.join(dir, 'skills', 'empty-skill'));
  fs.writeFileSync(path.join(dir, 'skills', 'empty-skill', 'note.md'), 'x\n');
  const r = run(['--root', dir, '--out', tmp()]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /skill empty-skill has no SKILL\.md/);
});

test('the repository slug is exempt from identity terms, other mentions are not', () => {
  const dir = copyRepo();
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.repository = 'https://github.com/flurboowner/evejs-contrib';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  // an identity of "flurboowner" via git config in a throwaway HOME
  const home = tmp();
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Flurboowner\n\temail = nobody@example.org\n');
  const env = { ...process.env, EVEJS_CONTRIB_CONFIG_DIR: CONFIG, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  const go = () => spawnSync(process.execPath, [BUILD, '--root', dir, '--out', tmp()], { encoding: 'utf8', env, cwd: home });
  fs.appendFileSync(path.join(dir, 'README.md'), '\nclaude plugin marketplace add flurboowner/evejs-contrib\nhttps://github.com/flurboowner/evejs-contrib\n');
  let r = go();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  fs.appendFileSync(path.join(dir, 'README.md'), '\nbuilt by flurboowner\n');
  r = go();
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, /README\.md:\d+: identity/);
});

test('no scan exemptions: the pattern sources build clean, and any hit in them refuses', () => {
  const lib = path.join('skills', 'upstream-report', 'scripts', 'lib');
  let dir = copyRepo();
  let r = run(['--root', dir, '--out', tmp()]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const [file, line, label] of [['patterns.js', '// e.g. /home/sam/x', 'home-path'], ['hosts.js', '// e.g. box.local', 'lan-host'], ['patterns.js', '// e.g. 192.168.1.4', 'private-ip'], ['zip.js', '// e.g. /home/sam/x', 'home-path']]) {
    dir = copyRepo();
    fs.appendFileSync(path.join(dir, lib, file), `\n${line}\n`);
    r = run(['--root', dir, '--out', tmp()]);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stdout, new RegExp(`lib/${file.replace('.', '\\.')}:\\d+: ${label}`));
  }
});

test('a malformed terms file is a refusal, not a crash', () => {
  const terms = path.join(tmp(), 'terms');
  fs.writeFileSync(terms, '/(unclosed/\n');
  const r = run(['--out', tmp(), '--terms', terms]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /cannot use terms file .*bad regex/);
  assert.doesNotMatch(r.stderr, /at .*\.js:\d+/);
});

test('the built zip passes python zipfile -t', (t) => {
  const out = tmp();
  assert.equal(run(['--out', out]).status, 0);
  const py = ['python3', 'python'].find((p) => spawnSync(p, ['-I', '--version']).status === 0);
  if (!py) return t.skip('python is not installed');
  const r = spawnSync(py, ['-I', '-m', 'zipfile', '-t', path.join(out, `evejs-contrib-${version}.zip`)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('the built zip passes claude plugin validate', (t) => {
  const probe = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return t.skip('claude is not on PATH');
  const out = tmp();
  assert.equal(run(['--out', out]).status, 0);
  const dest = tmp();
  const pyBin = ['python3', 'python'].find((p) => spawnSync(p, ['-I', '--version']).status === 0);
  if (!pyBin) return t.skip('python is not installed');
  const x = spawnSync(pyBin, ['-I', '-m', 'zipfile', '-e', path.join(out, `evejs-contrib-${version}.zip`), dest], { encoding: 'utf8' });
  assert.equal(x.status, 0, x.stderr);
  const v = spawnSync('claude', ['plugin', 'validate', path.join(dest, 'evejs-contrib')], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stdout + v.stderr);
});
