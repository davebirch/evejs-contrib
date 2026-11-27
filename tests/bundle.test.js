'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const { readZip } = require('../skills/upstream-report/scripts/lib/zip.js');
const { makeErrorReport } = require('./fixtures/make-error-report.js');
const { makeMiniRepo } = require('./fixtures/make-mini-repo.js');

const CLI = path.join(__dirname, '..', 'skills', 'upstream-report', 'scripts', 'bundle.js');
const tmp = () => require('./fixtures/tmp.js').mk('bundle-test-');
const CONFIG = tmp(); // never the real config dir; no terms file inside
const run = (...args) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, EVEJS_CONTRIB_CONFIG_DIR: CONFIG } });
const runNoId = (...args) => run(...args, '--no-identity');
const put = (root, rel, text) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const get = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const README_HEALTH = '## Health capture\n\n[Report](error-report/manifest.json)\n';
const README_NA = '## Health capture\n\nHealth capture: not applicable: data fix, no tick-loop change\n';

// A complete, passing bundle built from the mini repo.
function goodBundle({ health = README_HEALTH, report = true } = {}) {
  const d = tmp();
  const repo = path.join(d, 'repo');
  const base = makeMiniRepo(repo);
  const b = path.join(d, 'bundle');
  assert.equal(run('init', b, '--area', 'fleet', '--version', 'EveJS 000000.1').status, 0);
  put(b, 'README.md', `# Fleet fix\n\nSee [bug](BUG-REPORT.md) and [handoff](DEVELOPER-HANDOFF.md).\n\n${health}`);
  put(b, 'BUG-REPORT.md', '# Bug\n\n## Trade-offs and behaviour changes\n\nNone.\n');
  put(b, 'DEVELOPER-HANDOFF.md', '# Handoff\n\n## Merge checklist\n\n1. Review the diff.\n');
  put(b, 'tests/verification-results.md', '# Results\n\nSee [transcript](patch-validation.txt).\n');
  fs.writeFileSync(path.join(b, 'patches', '01-fleet.patch'), execFileSync('git', ['-C', repo, 'diff', base, 'HEAD']));
  put(b, 'files/note.txt', 'note\n');
  const v = runNoId('validate', b, '--repo', repo, '--base', base);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  if (report) {
    const z = path.join(d, 'report.zip');
    makeErrorReport(z);
    const r = run('add-report', b, z);
    assert.equal(r.status, 0, r.stderr);
  }
  assert.equal(run('manifest', b).status, 0);
  return { d, repo, base, b };
}
const check = (b) => runNoId('check', b);
const refusals = (r) => r.stdout.split('\n').filter((l) => l.startsWith('refusing:'));
// Change a bundle file, refresh the manifest, and expect exactly one kind of refusal.
function breakIt(b, fn) {
  fn(b);
  assert.equal(run('manifest', b).status, 0);
  return check(b);
}

test('add-report: redacts, keeps manifest valid, prints versions and window', () => {
  const d = tmp();
  const z = path.join(d, 'report.zip');
  makeErrorReport(z, { profile: true });
  const b = path.join(d, 'b');
  const r = run('add-report', b, z);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /EveJS 000000\.1/);
  assert.match(r.stdout, /"hours": 6/);
  const m = JSON.parse(get(b, 'error-report/manifest.json'));
  assert.equal(m.schema, 'evejs-error-report/1');
  for (const rel of ['manifest.json', 'server-logs/server.log', 'server-logs/server-health.log', 'profiling/cpu-001.cpuprofile']) {
    const t = get(b, `error-report/${rel}`);
    assert.ok(!t.includes('Sam'), rel);
    assert.ok(!t.includes('/home/') && !t.includes('C:\\Users'), rel);
  }
  assert.ok(get(b, 'error-report/server-logs/server-health.log').includes('closeWatchStarted'));
});

test('add-report: --as evidence target; names from --names and from a terms file become <character-N>', () => {
  const d = tmp();
  const health = path.join(d, 'health.jsonl');
  put(d, 'health.jsonl', '{"time":"2026-11-18T16:00:00.000Z","event":"note","text":"Zed Quillfeather docked"}\n');
  const z = path.join(d, 'report.zip');
  makeErrorReport(z, { health: fs.readFileSync(health, 'utf8') });
  put(d, 'names.txt', 'Quillfeather\n');
  const r = run('add-report', path.join(d, 'b'), z, '--as', 'evidence/before/error-report', '--names', path.join(d, 'names.txt'));
  assert.equal(r.status, 0, r.stderr);
  const log = get(d, 'b/evidence/before/error-report/server-logs/server-health.log');
  assert.ok(!log.includes('Quillfeather'));
  assert.match(log, /Zed <character-1> docked/);
  put(d, 'terms', '[character-names]\nZed\n');
  const r2 = run('add-report', path.join(d, 'b2'), z, '--terms', path.join(d, 'terms'));
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(get(d, 'b2/error-report/server-logs/server-health.log'), /<character-1> Quillfeather docked/);
});

test('add-report and add-profiles leave no staging folders behind', () => {
  const d = tmp();
  const z = path.join(d, 'report.zip');
  makeErrorReport(z, { closeWatch: path.join(d, 'cw') });
  const b = path.join(d, 'b');
  assert.equal(run('add-report', b, z).status, 0);
  assert.equal(run('add-profiles', b, path.join(d, 'cw'), '--as', 'evidence/before').status, 0);
  assert.deepEqual(fs.readdirSync(b).sort(), ['error-report', 'evidence']);
  assert.deepEqual(fs.readdirSync(path.join(b, 'evidence')), ['before']);
  assert.deepEqual(fs.readdirSync(path.join(b, 'evidence/before')), ['close-watch']);
});

test('fixture: Close Watch records match upstream (time, numeric startedBy, cpuCapture summary)', () => {
  const d = tmp();
  makeErrorReport(path.join(d, 'r.zip'));
  const lines = readZip(path.join(d, 'r.zip')).find((e) => e.name === 'server-logs/server-health.log').data.toString().trim().split('\n').map(JSON.parse);
  for (const r of lines) assert.match(r.time, /^\d{4}-\d\d-\d\dT/);
  assert.equal(typeof lines.find((r) => r.event === 'closeWatchStarted').startedBy, 'number');
  const c = lines.find((r) => r.event === 'cpuCapture');
  for (const k of ['atMs', 'durationMs', 'partial', 'tick', 'sampleCount', 'sampledMs', 'gcMs', 'idleMs', 'programMs', 'selfFunctions', 'totalFunctions', 'stacks', 'profileFile']) assert.ok(k in c, k);
});

test('add-report: a startedBy name string is redacted too', () => {
  const d = tmp();
  const z = path.join(d, 'r.zip');
  makeErrorReport(z, { health: '{"time":"2026-11-18T16:00:00.000Z","event":"closeWatchStarted","minutes":15,"startedBy":"Zed Quillfeather"}\n' });
  assert.equal(run('add-report', path.join(d, 'b'), z).status, 0);
  assert.ok(!get(d, 'b/error-report/server-logs/server-health.log').includes('Quillfeather'));
});

test('add-report: other schema refused with the R12 message, nothing written', () => {
  const d = tmp();
  const z = path.join(d, 'report.zip');
  makeErrorReport(z, { schema: 'evejs-error-report/2' });
  const b = path.join(d, 'b');
  const r = run('add-report', b, z);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /refusing: upstream changed the report format: read the collector's --help and README, then update the skill/);
  assert.ok(!fs.existsSync(b));
});

test('add-report: second run to the same target refused; bad --as refused', () => {
  const d = tmp();
  const z = path.join(d, 'report.zip');
  makeErrorReport(z);
  const b = path.join(d, 'b');
  assert.equal(run('add-report', b, z).status, 0);
  const again = run('add-report', b, z);
  assert.equal(again.status, 2);
  assert.match(again.stdout, /refusing: .*already exists/);
  assert.equal(run('add-report', b, z, '--as', 'elsewhere').status, 64);
});

test('add-profiles: redacts a home-path frame URL, keeps file names, refuses empty and existing', () => {
  const d = tmp();
  const z = path.join(d, 'report.zip');
  makeErrorReport(z, { closeWatch: path.join(d, 'cw') });
  const b = path.join(d, 'b');
  const r = run('add-profiles', b, path.join(d, 'cw'), '--as', 'evidence/after');
  assert.equal(r.status, 0, r.stderr);
  const names = fs.readdirSync(path.join(d, 'cw')).sort();
  assert.deepEqual(fs.readdirSync(path.join(b, 'evidence/after/close-watch')).sort(), names);
  for (const n of names) assert.match(r.stdout, new RegExp(n.replace(/\./g, '\\.')));
  const all = names.map((n) => get(b, `evidence/after/close-watch/${n}`)).join('');
  assert.ok(!all.includes('/home/sam'));
  assert.ok(all.includes('<home>/'));
  const again = run('add-profiles', b, path.join(d, 'cw'), '--as', 'evidence/after');
  assert.equal(again.status, 2);
  fs.mkdirSync(path.join(d, 'empty'));
  const e = run('add-profiles', b, path.join(d, 'empty'), '--as', 'evidence/before');
  assert.equal(e.status, 2);
  assert.match(e.stdout, /refusing: .*no \.cpuprofile/);
});

test('init: skeletons with area and version filled in; refuses non-empty dir', () => {
  const d = tmp();
  const b = path.join(d, 'b');
  assert.equal(run('init', b, '--area', 'fleet', '--version', 'EveJS 000000.1').status, 0);
  for (const p of ['patches', 'files', 'tests']) assert.ok(fs.statSync(path.join(b, p)).isDirectory());
  const readme = get(b, 'README.md');
  assert.match(readme, /fleet/);
  assert.match(readme, /EveJS 000000\.1/);
  assert.ok(!readme.includes('<area>') && !readme.includes('<version>'));
  for (const h of ['Start here', 'Apply to a clean checkout', 'Backup before testing', 'Health capture', 'Coverage', 'Questions for upstream', 'Manifest']) {
    assert.match(readme, new RegExp(`^## ${h}$`, 'm'));
  }
  assert.match(readme, /--ignore-space-change/);
  assert.match(get(b, 'DEVELOPER-HANDOFF.md'), /^## Merge checklist$/m);
  assert.match(get(b, 'tests/verification-results.md'), /^## Directed tests$/m);
  assert.equal(run('init', b, '--area', 'fleet', '--version', 'x').status, 2);
  assert.equal(run('init', path.join(d, 'c')).status, 64);
});

test('validate: passes on the mini repo; transcript has no absolute paths; worktree removed', () => {
  const { repo, base, b } = goodBundle();
  const t = get(b, 'tests/patch-validation.txt');
  assert.match(t, /git apply --check patches\/01-fleet\.patch/);
  assert.match(t, /node --check server\/src\/fleet\.js/);
  assert.ok(!t.includes('/tmp/') && !t.includes(os.tmpdir()) && !t.includes('/home/'));
  assert.ok(!execFileSync('git', ['-C', repo, 'worktree', 'list']).toString().includes('bundle-test-validate'));
  assert.equal(execFileSync('git', ['-C', repo, 'worktree', 'list']).toString().trim().split('\n').length, 1);
  assert.match(t, new RegExp(`^base: ${base.replace(/[./]/g, '\\$&')} `, 'm'));
});

test('validate: a patch that does not apply is refused and the worktree still removed', () => {
  const { repo, base, b } = goodBundle();
  fs.writeFileSync(path.join(b, 'patches', '02-bad.patch'), 'diff --git a/nope.js b/nope.js\n--- a/nope.js\n+++ b/nope.js\n@@ -1 +1 @@\n-a\n+b\n');
  const r = runNoId('validate', b, '--repo', repo, '--base', base);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /refusing: .*02-bad\.patch/);
  assert.equal(execFileSync('git', ['-C', repo, 'worktree', 'list']).toString().trim().split('\n').length, 1);
});

test('validate: a patch that deletes a .js file passes', () => {
  const d = tmp();
  const repo = path.join(d, 'repo');
  const base = makeMiniRepo(repo);
  fs.writeFileSync(path.join(repo, 'server', 'src', 'extra.js'), 'module.exports = 1;\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'add extra']);
  const base2 = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', repo, 'rm', '-q', 'server/src/extra.js']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'remove extra']);
  const b = path.join(d, 'b');
  assert.equal(run('init', b, '--area', 'x', '--version', 'v').status, 0);
  fs.writeFileSync(path.join(b, 'patches', '01-del.patch'), execFileSync('git', ['-C', repo, 'diff', base2, 'HEAD']));
  const r = run('validate', b, '--repo', repo, '--base', base2);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(get(b, 'tests/patch-validation.txt'), /^Result: PASS$/m);
});

test('validate: transcript ends Result: PASS or FAIL, and check refuses a FAIL transcript', () => {
  const { repo, base, b } = goodBundle();
  assert.match(get(b, 'tests/patch-validation.txt'), /^Result: PASS$/m);
  fs.writeFileSync(path.join(b, 'patches', '02-bad.patch'), 'diff --git a/nope.js b/nope.js\n--- a/nope.js\n+++ b/nope.js\n@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(runNoId('validate', b, '--repo', repo, '--base', base).status, 2);
  assert.match(get(b, 'tests/patch-validation.txt'), /^Result: FAIL$/m);
  fs.rmSync(path.join(b, 'patches', '02-bad.patch'));
  const r = breakIt(b, () => {});
  assert.equal(r.status, 2);
  assert.match(r.stdout, /patch-validation\.txt: not Result: PASS/);
});

test('validate: an -optional patch is also checked alone on the base', () => {
  const { repo, base, b } = goodBundle();
  // Applies only after 01 (needs the fixed line), so alone on the base it must fail.
  const patch = fs.readFileSync(path.join(b, 'patches', '01-fleet.patch'), 'latin1');
  const dependent = patch.replace(/n \+ 2/g, 'n + 3').replace(/-  return n \+ 1;\r?\n/, (m) => m.replace('n + 1', 'n + 2'));
  fs.writeFileSync(path.join(b, 'patches', '02-more-optional.patch'), dependent, 'latin1');
  const r = runNoId('validate', b, '--repo', repo, '--base', base);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, /02-more-optional\.patch.*base|base.*02-more-optional\.patch/);
});

test('manifest: hash of a CRLF patch equals sha256 of its raw bytes; sorted; excludes itself', () => {
  const { b } = goodBundle();
  const raw = fs.readFileSync(path.join(b, 'patches', '01-fleet.patch'));
  assert.ok(raw.includes('\r\n'));
  const lines = get(b, 'manifest-sha256.txt').trim().split('\n');
  const want = `${crypto.createHash('sha256').update(raw).digest('hex')}  patches/01-fleet.patch`;
  assert.ok(lines.includes(want));
  assert.ok(!lines.some((l) => l.endsWith('manifest-sha256.txt')));
  assert.deepEqual(lines, [...lines].sort((x, y) => (x.slice(66) < y.slice(66) ? -1 : 1)));
});

test('check: a good bundle passes, with the N/A line too', () => {
  const { b } = goodBundle();
  const r = check(b);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const na = goodBundle({ health: README_NA, report: false });
  assert.equal(check(na.b).status, 0);
});

test('check: evidence before/after links accepted', () => {
  const { d, b } = goodBundle({ health: '## Health capture\n\n[before](evidence/before/error-report/manifest.json) [after](evidence/after/error-report/manifest.json)\n', report: false });
  const z = path.join(d, 'r.zip');
  makeErrorReport(z);
  assert.equal(run('add-report', b, z, '--as', 'evidence/before/error-report').status, 0);
  assert.equal(run('add-report', b, z, '--as', 'evidence/after/error-report').status, 0);
  assert.equal(run('manifest', b).status, 0);
  const r = check(b);
  assert.equal(r.status, 0, r.stdout);
});

test('check: refuses each problem separately', () => {
  const cases = {
    'no health section': (b) => put(b, 'README.md', '# Fleet\n\nNothing here.\n'),
    'leftover TODO': (b) => put(b, 'BUG-REPORT.md', '# Bug\n\n## Trade-offs and behaviour changes\n\nTODO(bundle): fill me\n'),
    'broken link': (b) => put(b, 'README.md', `# R\n\n[x](missing.md)\n\n${README_HEALTH}`),
    '41-line bug report': (b) => put(b, 'BUG-REPORT.md', ['## Trade-offs and behaviour changes', ...Array.from({ length: 40 }, (_, i) => `line ${i}`)].join('\n') + '\n'),
    'planted home path': (b) => put(b, 'files/note.txt', 'see /home/sam/x\n'),
    'no merge checklist item': (b) => put(b, 'DEVELOPER-HANDOFF.md', '# H\n\n## Merge checklist\n\nnothing\n'),
    'no patches': (b) => fs.rmSync(path.join(b, 'patches', '01-fleet.patch')),
    'no validation transcript': (b) => fs.rmSync(path.join(b, 'tests', 'patch-validation.txt')),
    'empty files': (b) => fs.rmSync(path.join(b, 'files', 'note.txt')),
    'missing top doc': (b) => fs.rmSync(path.join(b, 'BUG-REPORT.md')),
    'report manifest wrong schema': (b) => put(b, 'error-report/manifest.json', '{"schema":"other/1"}'),
    'linked report missing': (b) => fs.rmSync(path.join(b, 'error-report'), { recursive: true }),
  };
  const expect = {
    'no health section': /Health capture/, 'leftover TODO': /TODO\(bundle\)/, 'broken link': /broken link missing\.md/,
    '41-line bug report': /41 lines/, 'planted home path': /home-path/, 'no merge checklist item': /numbered item/,
    'no patches': /no \.patch/, 'no validation transcript': /patch-validation/, 'empty files': /files\/ is empty/,
    'missing top doc': /missing BUG-REPORT/, 'report manifest wrong schema': /schema is not/, 'linked report missing': /does not exist/,
  };
  for (const [name, fn] of Object.entries(cases)) {
    const { b } = goodBundle();
    const r = breakIt(b, fn);
    assert.equal(r.status, 2, `${name}: ${r.stdout}`);
    if (!['no validation transcript', 'missing top doc', 'linked report missing'].includes(name)) assert.equal(refusals(r).length, 1, `${name}: ${r.stdout}`); // those also break a link
    assert.match(r.stdout, expect[name], name);
  }
});

test('check: exactly 40 lines passes; stale manifest refused; symlink refused', (t) => {
  const { b } = goodBundle();
  put(b, 'BUG-REPORT.md', ['## Trade-offs and behaviour changes', ...Array.from({ length: 39 }, (_, i) => `line ${i}`)].join('\n') + '\n');
  assert.equal(run('manifest', b).status, 0);
  assert.equal(check(b).status, 0);
  put(b, 'files/note.txt', 'changed\n');
  const stale = check(b);
  assert.equal(stale.status, 2);
  assert.match(stale.stdout, /manifest-sha256\.txt/);
  assert.equal(run('manifest', b).status, 0);
  try { fs.symlinkSync(path.join(b, 'files', 'note.txt'), path.join(b, 'files', 'link.txt')); } catch (e) { return t.skip('symlinks unavailable'); }
  const sym = check(b);
  assert.equal(sym.status, 2);
  assert.match(sym.stdout, /symlink/);
  assert.equal(run('manifest', b).status, 2);
});

test('check: leak scan uses a terms file', () => {
  const { d, b } = goodBundle();
  put(d, 'terms', 'Frobnicator\n');
  put(b, 'files/note.txt', 'the Frobnicator\n');
  assert.equal(run('manifest', b).status, 0);
  const r = runNoId('check', b, '--terms', path.join(d, 'terms'));
  assert.equal(r.status, 2);
  assert.match(r.stdout, /Frobnicator/);
});

test('check: --terms adds to the default user file; --no-user-terms opts out; identity section keeps the Signed exemption', () => {
  const { d, b } = goodBundle();
  const cfg = tmp();
  fs.writeFileSync(path.join(cfg, 'leak-terms'), 'Frobnicator\n[identity]\nsamwise\n');
  put(d, 'extra', 'Gizmoco\n');
  put(b, 'files/note.txt', 'the Frobnicator and Gizmoco\n');
  put(b, 'README.md', fs.readFileSync(path.join(b, 'README.md'), 'utf8') + '\nSigned: samwise\n');
  assert.equal(run('manifest', b).status, 0);
  const env = { ...process.env, EVEJS_CONTRIB_CONFIG_DIR: cfg };
  const go = (...a) => spawnSync(process.execPath, [CLI, 'check', b, '--no-identity', ...a], { encoding: 'utf8', env });
  const r = go('--terms', path.join(d, 'extra'));
  assert.equal(r.status, 2);
  assert.match(r.stdout, /Frobnicator/);
  assert.match(r.stdout, /Gizmoco/);
  assert.doesNotMatch(r.stdout, /identity/);
  const r2 = go('--terms', path.join(d, 'extra'), '--no-user-terms');
  assert.doesNotMatch(r2.stdout, /Frobnicator/);
  assert.match(r2.stdout, /Gizmoco/);
});

test('add-report: character names come from the default file and every --terms file', () => {
  const d = tmp();
  const cfg = tmp();
  fs.writeFileSync(path.join(cfg, 'leak-terms'), '[character-names]\nZed\n');
  put(d, 'more', '[character-names]\nQuillfeather\n');
  put(d, 'health.jsonl', '{"time":"2026-11-18T16:00:00.000Z","event":"note","text":"Zed Quillfeather docked"}\n');
  const z = path.join(d, 'report.zip');
  makeErrorReport(z, { health: fs.readFileSync(path.join(d, 'health.jsonl'), 'utf8') });
  const env = { ...process.env, EVEJS_CONTRIB_CONFIG_DIR: cfg };
  const r = spawnSync(process.execPath, [CLI, 'add-report', path.join(d, 'b'), z, '--terms', path.join(d, 'more')], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(get(d, 'b/error-report/server-logs/server-health.log'), /<character-\d> <character-\d> docked/);
  const r2 = spawnSync(process.execPath, [CLI, 'add-report', path.join(d, 'b2'), z, '--terms', path.join(d, 'more'), '--no-user-terms'], { encoding: 'utf8', env });
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(get(d, 'b2/error-report/server-logs/server-health.log'), /Zed <character-1> docked/);
});

test('zip: refuses when check fails; otherwise every entry starts <name>/', () => {
  const { d, b } = goodBundle();
  const out = path.join(d, 'EveJS-fleet-report.zip');
  put(b, 'BUG-REPORT.md', 'TODO(bundle): x\n');
  const bad = runNoId('zip', b, out);
  assert.equal(bad.status, 2);
  assert.ok(!fs.existsSync(out) && !fs.existsSync(out + '.part'));
  put(b, 'BUG-REPORT.md', '# Bug\n\n## Trade-offs and behaviour changes\n\nNone.\n');
  assert.equal(run('manifest', b).status, 0);
  const ok = runNoId('zip', b, out);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const entries = readZip(out);
  assert.ok(entries.length > 5);
  for (const e of entries) assert.ok(e.name.startsWith('EveJS-fleet-report/'), e.name);
  assert.ok(entries.some((e) => e.name === 'EveJS-fleet-report/patches/01-fleet.patch'));
  assert.ok(!fs.existsSync(out + '.part'));
});

test('usage errors exit 64', () => {
  assert.equal(run().status, 64);
  assert.equal(run('bogus').status, 64);
  assert.equal(run('manifest').status, 64);
});

// ---- final-review fixes: content-based redaction, refusals, self-scan, check options ----
const SESSION_LOG = '[Session 8.8.4.4:51234 user=acct_zq(1001) char=Zephyra Quill(90000002)] hello\n';
const u16 = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);

test('add-report: a name in a rotated log and a UTF-16 log is redacted, whatever the extension', () => {
  const d = tmp();
  const z = path.join(d, 'r.zip');
  makeErrorReport(z, {
    extra: [
      { name: 'server-logs/server.log.old', data: Buffer.from('Zephyra Quill was here\n') },
      { name: 'server-logs/docker-compose-server.log', data: u16('Zephyra Quill from C:\\Users\\Sam\\x at 8.8.4.4\r\n') },
    ],
  });
  put(d, 'names.txt', 'Zephyra Quill\n');
  const b = path.join(d, 'b');
  const r = run('add-report', b, z, '--names', path.join(d, 'names.txt'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(get(b, 'error-report/server-logs/server.log.old'), '<character-1> was here\n');
  const out = fs.readFileSync(path.join(b, 'error-report/server-logs/docker-compose-server.log'));
  assert.deepEqual([...out.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(out.subarray(2).toString('utf16le'), '<character-1> from <home>/x at <ip-1>\r\n');
  assert.equal(runNoId('check', b, '--names', path.join(d, 'names.txt')).stdout.includes('character-name'), false);
});

test('add-report: an undecodable (binary) file is refused by name, nothing written, unless --allow-binary names it', () => {
  const d = tmp();
  const z = path.join(d, 'r.zip');
  makeErrorReport(z, { extra: [{ name: 'server-logs/blob.dat', data: Buffer.from([0, 1, 2, 0, 9]) }] });
  const b = path.join(d, 'b');
  const r = run('add-report', b, z);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /refusing: binary file can't be redacted: server-logs\/blob\.dat/);
  assert.ok(!fs.existsSync(b), 'nothing written');
  const ok = run('add-report', b, z, '--allow-binary', 'blob.dat');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /not redacted: review by hand: error-report\/server-logs\/blob\.dat/);
});

test('add-report: a given name that survives redaction in an allowed binary is refused', () => {
  const d = tmp();
  const z = path.join(d, 'r.zip');
  makeErrorReport(z, { extra: [{ name: 'server-logs/blob.dat', data: Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from('Zephyra Quill')]) }] });
  put(d, 'names.txt', 'Zephyra Quill\n');
  const b = path.join(d, 'b');
  const r = run('add-report', b, z, '--names', path.join(d, 'names.txt'), '--allow-binary', 'blob.dat');
  assert.equal(r.status, 2);
  assert.match(r.stdout, /blob\.dat: a name or host survived in a binary file/);
  assert.ok(!fs.existsSync(b));
});

test('add-report: names found only by log shape are redacted and reported (empty terms file)', () => {
  const d = tmp();
  const z = path.join(d, 'r.zip');
  makeErrorReport(z, { extra: [{ name: 'server-logs/session.log', data: Buffer.from(SESSION_LOG) }] });
  const b = path.join(d, 'b');
  const r = run('add-report', b, z);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(get(b, 'error-report/server-logs/session.log'), '[Session <ip-1>:51234 user=<account-1>(1001) char=<character-1>(90000002)] hello\n');
  assert.match(r.stderr, /1 character name\(s\) found in the logs were not in your terms/);
});

test('check: --names and --hosts are scanned for; --allow suppresses a label or term (check and zip)', () => {
  const { b, d } = goodBundle();
  put(b, 'files/up.js', 'const x = "Zephyra Quill"; // box.example\n');
  assert.equal(run('manifest', b).status, 0);
  put(d, 'names.txt', 'Zephyra Quill\n');
  put(d, 'hosts.txt', 'box.example\n');
  const r = runNoId('check', b, '--names', path.join(d, 'names.txt'), '--hosts', path.join(d, 'hosts.txt'));
  assert.equal(r.status, 2);
  assert.match(r.stdout, /up\.js:1: character-name/);
  assert.match(r.stdout, /up\.js:1: host/);
  put(d, 'terms', 'gizmo\n');
  put(b, 'files/up2.js', '// a gizmo list\n');
  assert.equal(run('manifest', b).status, 0);
  const t = runNoId('check', b, '--terms', path.join(d, 'terms'));
  assert.match(t.stdout, /up2\.js:1: gizmo/);
  const ok = runNoId('check', b, '--terms', path.join(d, 'terms'), '--allow', 'gizmo');
  assert.doesNotMatch(ok.stdout, /gizmo/);
  const z = runNoId('zip', b, path.join(d, 'out.zip'), '--terms', path.join(d, 'terms'), '--allow', 'gizmo', '--names', path.join(d, 'names.txt'));
  assert.match(z.stdout, /character-name/); // still refused for the name; --allow only lifted "gizmo"
  assert.doesNotMatch(z.stdout, /gizmo/);
});

test('check: a binary in evidence/ is refused unless allowed; elsewhere it is only listed on stderr', () => {
  const { b } = goodBundle();
  const bin = Buffer.from([0, 1, 2, 3]);
  fs.writeFileSync(path.join(b, 'files', 'logo.bin'), bin);
  assert.equal(run('manifest', b).status, 0);
  const ok = check(b);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stderr, /not scanned \(binary\): files\/logo\.bin/);
  fs.mkdirSync(path.join(b, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(b, 'evidence', 'dump.bin'), bin);
  assert.equal(run('manifest', b).status, 0);
  const bad = check(b);
  assert.equal(bad.status, 2);
  assert.match(bad.stdout, /refusing: evidence\/dump\.bin: binary file in the evidence was not scanned/);
  assert.equal(runNoId('check', b, '--allow-binary', 'dump.bin').status, 0);
});

test('check: a UTF-16 file in the bundle is scanned, not skipped', () => {
  const { b } = goodBundle();
  fs.writeFileSync(path.join(b, 'files', 'u16.txt'), u16('see C:\\Users\\Sam\\x\r\n'));
  assert.equal(run('manifest', b).status, 0);
  const r = check(b);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /files\/u16\.txt:1: home-path/);
});

test('check: a patch edited after validate is refused until validate runs again', () => {
  const { b } = goodBundle();
  fs.appendFileSync(path.join(b, 'patches', '01-fleet.patch'), '\n');
  assert.equal(run('manifest', b).status, 0);
  const r = check(b);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /patches\/01-fleet\.patch changed since tests\/patch-validation\.txt was written/);
});

test('manifest and zip skip .DS_Store and Thumbs.db', () => {
  const { b } = goodBundle();
  put(b, '.DS_Store', 'junk');
  put(b, 'files/Thumbs.db', 'junk');
  assert.equal(run('manifest', b).status, 0);
  assert.ok(!get(b, 'manifest-sha256.txt').includes('DS_Store'));
  assert.ok(!get(b, 'manifest-sha256.txt').includes('Thumbs'));
  assert.equal(check(b).status, 0);
});

test('validate leaves other worktrees alone (no git worktree prune)', () => {
  const d = tmp();
  const repo = path.join(d, 'repo');
  const base = makeMiniRepo(repo);
  const other = path.join(d, 'other-wt');
  execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', other, base]);
  fs.rmSync(other, { recursive: true, force: true }); // an unplugged drive: metadata stays
  const b = path.join(d, 'bundle');
  assert.equal(run('init', b, '--area', 'fleet', '--version', 'EveJS 000000.1').status, 0);
  fs.writeFileSync(path.join(b, 'patches', '01.patch'), execFileSync('git', ['-C', repo, 'diff', base, 'HEAD']));
  assert.equal(runNoId('validate', b, '--repo', repo, '--base', base).status, 0);
  assert.match(execFileSync('git', ['-C', repo, 'worktree', 'list']).toString(), /other-wt/);
});

test('add-report: generic hits in a collector zip (emails, LAN hosts, secrets) do not refuse; check still does', () => {
  const d = tmp();
  const z = path.join(d, 'r.zip');
  makeErrorReport(z, { extra: [{ name: 'server-logs/xmpp-stub.log', data: Buffer.from('room1@conference.localhost/abc\nmail a@b.org db.lan:27017 token=Ab12Cd34Ef56\n') }] });
  const b = path.join(d, 'b');
  const r = run('add-report', b, z, '--no-identity');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const c = runNoId('check', b);
  assert.equal(c.status, 2);
  assert.match(c.stdout, /xmpp-stub\.log:\d+: email/);
});

test('add-report: a binary inside an allowed zip does not crash the self-scan; a surviving name in it is refused', () => {
  const { writeZip } = require('../skills/upstream-report/scripts/lib/zip.js');
  const d = tmp();
  const inner = path.join(d, 'inner.zip');
  writeZip([{ name: 'inner.bin', data: Buffer.from([0, 1, 2, 0, 9]) }], inner);
  const z = path.join(d, 'r.zip');
  makeErrorReport(z, { extra: [{ name: 'server-logs/blobs.zip', data: fs.readFileSync(inner) }] });
  const b = path.join(d, 'b');
  const r = run('add-report', b, z, '--allow-binary', 'blobs.zip', '--allow-binary', 'inner.bin');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const inner2 = path.join(d, 'inner2.zip');
  writeZip([{ name: 'inner.bin', data: Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from('Zephyra Quill')]) }], inner2);
  const z2 = path.join(d, 'r2.zip');
  makeErrorReport(z2, { extra: [{ name: 'server-logs/blobs.zip', data: fs.readFileSync(inner2) }] });
  put(d, 'names.txt', 'Zephyra Quill\n');
  const b2 = path.join(d, 'b2');
  const r2 = run('add-report', b2, z2, '--names', path.join(d, 'names.txt'), '--allow-binary', 'blobs.zip', '--allow-binary', 'inner.bin');
  assert.equal(r2.status, 2, r2.stdout + r2.stderr);
  assert.doesNotMatch(r2.stderr, /ENOTDIR|at /);
  assert.match(r2.stdout, /survived in a binary file/);
});

test('add-report: a directory named *.zip inside a report is a directory, not a crash (no EISDIR)', () => {
  const d = tmp();
  const z = path.join(d, 'r.zip');
  makeErrorReport(z, { extra: [{ name: 'server-logs/blobs.zip/inner.bin', data: Buffer.from([0, 1, 2, 0, 9]) }] });
  const b = path.join(d, 'b');
  const r = run('add-report', b, z, '--no-identity', '--allow-binary', 'inner.bin');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stderr, /EISDIR|at /);
});

// ---- the Discord post beside the zip ----
const POST = '**Fleet invites drop the second wing**\n\nInviting into wing 2 lands in wing 1.\n\nFull report, patch, tests and evidence in the attached zip.\n';

test('zip --post: writes the zip and, beside it, the post byte for byte as <stem>.post.md', () => {
  const { d, b } = goodBundle();
  const post = path.join(d, 'draft.md');
  const bytes = Buffer.from(POST.replace(/\n/g, '\r\n'), 'utf8');
  fs.writeFileSync(post, bytes);
  const out = path.join(d, 'out', 'EveJS-fleet-report.zip');
  const r = runNoId('zip', b, out, '--post', post);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const written = path.join(d, 'out', 'EveJS-fleet-report.post.md');
  assert.ok(fs.existsSync(out));
  assert.deepEqual(fs.readFileSync(written), bytes);
  assert.deepEqual(fs.readdirSync(path.join(d, 'out')).sort(), ['EveJS-fleet-report.post.md', 'EveJS-fleet-report.zip']);
  assert.ok(!readZip(out).some((e) => /post\.md$/.test(e.name)), 'the post is never inside the zip');
  assert.match(r.stdout, /EveJS-fleet-report\.post\.md/);
});

test('zip without --post writes no post and needs none', () => {
  const { d, b } = goodBundle();
  const out = path.join(d, 'out', 'EveJS-fleet-report.zip');
  const r = runNoId('zip', b, out);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(fs.readdirSync(path.join(d, 'out')), ['EveJS-fleet-report.zip']);
  assert.doesNotMatch(r.stdout + r.stderr, /post/);
});

test('zip --post: a bad post, or a bad bundle, means neither file is written', () => {
  const { d, b } = goodBundle();
  const out = path.join(d, 'out', 'r.zip');
  const post = path.join(d, 'draft.md');
  fs.writeFileSync(post, `${POST}![chart](a.png)\n`);
  const r = runNoId('zip', b, out, '--post', post);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /refusing: draft\.md: .*image/);
  assert.ok(!fs.existsSync(path.join(d, 'out')) || fs.readdirSync(path.join(d, 'out')).length === 0);
  fs.writeFileSync(post, POST);
  put(b, 'BUG-REPORT.md', 'TODO(bundle): x\n');
  const r2 = runNoId('zip', b, out, '--post', post);
  assert.equal(r2.status, 2);
  assert.ok(!fs.existsSync(path.join(d, 'out')) || fs.readdirSync(path.join(d, 'out')).length === 0);
  assert.equal(runNoId('zip', b, out, '--post', path.join(d, 'missing.md')).status, 64);
});

test('zip --post: a post inside the bundle folder is refused (it would ship in the zip)', () => {
  const { d, b } = goodBundle();
  put(b, 'post.md', POST);
  assert.equal(run('manifest', b).status, 0);
  const r = runNoId('zip', b, path.join(d, 'r.zip'), '--post', path.join(b, 'post.md'));
  assert.equal(r.status, 2);
  assert.match(r.stdout, /refusing: .*outside the bundle/);
  assert.ok(!fs.existsSync(path.join(d, 'r.zip')));
});

test('check --post checks the post too', () => {
  const { d, b } = goodBundle();
  const post = path.join(d, 'draft.md');
  fs.writeFileSync(post, POST);
  assert.equal(runNoId('check', b, '--post', post).status, 0);
  fs.writeFileSync(post, `${POST}[p](patches/01-fleet.patch)\n`);
  const r = runNoId('check', b, '--post', post);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /refusing: draft\.md: line \d+: link into the zip/);
});

test('zip: --post may come anywhere among the options, after --terms included', () => {
  const { d, b } = goodBundle();
  const post = path.join(d, 'draft.md');
  fs.writeFileSync(post, POST);
  put(d, 'terms', 'gizmo\n');
  const out = path.join(d, 'out', 'r.zip');
  const r = runNoId('zip', b, out, '--terms', path.join(d, 'terms'), '--post', post);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(get(d, 'out/r.post.md'), POST);
  // the terms file applies to the post as well
  fs.writeFileSync(post, `${POST}A gizmo broke.\n`);
  const r2 = runNoId('zip', b, path.join(d, 'out2', 'r.zip'), '--terms', path.join(d, 'terms'), '--post', post);
  assert.equal(r2.status, 2);
  assert.match(r2.stdout, /refusing: leak: draft\.md:\d+: gizmo/);
  assert.ok(!fs.existsSync(path.join(d, 'out2')) || fs.readdirSync(path.join(d, 'out2')).length === 0);
  const r3 = runNoId('zip', '--post', post, b, path.join(d, 'out3', 'r.zip'), '--allow', 'gizmo', '--terms', path.join(d, 'terms'));
  assert.equal(r3.status, 0, r3.stdout + r3.stderr);
  assert.ok(fs.existsSync(path.join(d, 'out3', 'r.post.md')));
});

test('zip without --post refuses when a post already sits beside the output zip (it would be stale)', () => {
  const { d, b } = goodBundle();
  const out = path.join(d, 'out', 'r.zip');
  put(d, 'out/r.post.md', POST);
  const r = runNoId('zip', b, out);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /refusing: stale post beside the output: r\.post\.md: delete it or pass --post/);
  assert.ok(!fs.existsSync(out));
  // with --post it is replaced
  const post = path.join(d, 'draft.md');
  fs.writeFileSync(post, POST.replace('Fleet', 'Wing'));
  assert.equal(runNoId('zip', b, out, '--post', post).status, 0);
  assert.equal(get(d, 'out/r.post.md'), POST.replace('Fleet', 'Wing'));
});

test('zip --post is all or nothing: if the post cannot be put in place, the new zip is removed too', () => {
  const { d, b } = goodBundle();
  const out = path.join(d, 'out', 'r.zip');
  fs.mkdirSync(path.join(d, 'out', 'r.post.md'), { recursive: true }); // a folder where the post goes: its rename fails
  const post = path.join(d, 'draft.md');
  fs.writeFileSync(post, POST);
  const r = runNoId('zip', b, out, '--post', post);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /refusing: /);
  assert.deepEqual(fs.readdirSync(path.join(d, 'out')), ['r.post.md']);
});

test('zip --post: the inside-the-bundle check uses real paths (a "..x.md" name is inside; case on macOS and Windows)', () => {
  const { d, b } = goodBundle();
  put(b, '..x.md', POST);
  assert.equal(run('manifest', b).status, 0);
  const r = runNoId('zip', b, path.join(d, 'r.zip'), '--post', path.join(b, '..x.md'));
  assert.equal(r.status, 2);
  assert.match(r.stdout, /refusing: \.\.x\.md: the post must be outside the bundle folder/);
  // a symlinked path to the bundle is still the bundle
  const link = path.join(d, 'link');
  let linked = true;
  try { fs.symlinkSync(b, link, 'junction'); } catch (e) { linked = false; }
  if (linked) {
    const r2 = runNoId('zip', b, path.join(d, 'r2.zip'), '--post', path.join(link, '..x.md'));
    assert.equal(r2.status, 2);
    assert.match(r2.stdout, /outside the bundle folder/);
  }
  if (process.platform === 'darwin' || process.platform === 'win32') {
    const r3 = runNoId('zip', b, path.join(d, 'r3.zip'), '--post', path.join(path.dirname(b), path.basename(b).toUpperCase(), '..x.md'));
    assert.equal(r3.status, 2);
    assert.match(r3.stdout, /outside the bundle folder/);
  }
  // a sibling folder whose name starts with the bundle's is outside
  put(d, 'bundle-notes/post.md', POST);
  assert.equal(runNoId('zip', b, path.join(d, 'r4.zip'), '--post', path.join(d, 'bundle-notes', 'post.md')).status, 0);
});

test('zip --post: a refusal from a failed move names any old file it could not put back', () => {
  // the message format only: placeAll's own tests cover the moves
  const { refusalFor } = require('../skills/upstream-report/scripts/bundle.js');
  const e = Object.assign(new Error('locked'), { code: 'EPERM', leftover: ['/x/r.zip.7.old'] });
  assert.equal(refusalFor(e), 'EPERM: locked: the old r.zip is left at r.zip.7.old: rename it back');
  assert.equal(refusalFor(Object.assign(new Error('locked'), { code: 'EPERM' })), 'EPERM: locked: nothing written');
});

// ---- submissions carry functional tests only; own still-needed checks stay out; trade-offs section required

const REFUSE_TESTS = /refusing: tests\/patches\/ is for your own still-needed checks; keep it out of the submission: /;

test('check: refuses a tests/patches path in files/', () => {
  const { b } = goodBundle();
  const r = breakIt(b, (x) => put(x, 'files/server/tests/patches/still-needed.test.js', 'x\n'));
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, REFUSE_TESTS);
  assert.match(r.stdout, /files\/server\/tests\/patches\/still-needed\.test\.js/);
});

test('check: refuses a top-level tests/patches path in files/', () => {
  const { b } = goodBundle();
  const r = breakIt(b, (x) => put(x, 'files/tests/patches/a.js', 'x\n'));
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, REFUSE_TESTS);
});

test('validate: refuses a patch touching server/tests/patches/', () => {
  const { b, repo, base } = goodBundle();
  put(b, 'patches/02-own.patch', [
    'diff --git a/server/tests/patches/x.test.js b/server/tests/patches/x.test.js',
    'new file mode 100644', '--- /dev/null', '+++ b/server/tests/patches/x.test.js', '@@ -0,0 +1 @@', '+x', ''].join('\n'));
  const r = runNoId('validate', b, '--repo', repo, '--base', base);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, REFUSE_TESTS);
  assert.match(r.stdout, /server\/tests\/patches\/x\.test\.js/);
  // a deleted file shows on the '--- a/' side
  put(b, 'patches/02-own.patch', '--- a/tests/patches/y.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n');
  const d = runNoId('validate', b, '--repo', repo, '--base', base);
  assert.equal(d.status, 2);
  assert.match(d.stdout, REFUSE_TESTS);
});

test('check and validate: server/tests/<fix>/ functional tests are fine, even patches-cleanup', () => {
  const { b, repo, base } = goodBundle();
  for (const rel of ['files/server/tests/fleet-fix/a.test.js', 'files/server/tests/patches-cleanup/x.test.js', 'files/server/tests/my-patches/y.test.js', 'files/server/src/patches/z.js']) put(b, rel, 'ok\n');
  const r = breakIt(b, () => {});
  assert.equal(r.status, 0, r.stdout);
  put(b, 'patches/02-ok.patch', [
    'diff --git a/server/tests/patches-cleanup/x.test.js b/server/tests/patches-cleanup/x.test.js',
    'new file mode 100644', '--- /dev/null', '+++ b/server/tests/patches-cleanup/x.test.js', '@@ -0,0 +1 @@', '+x', ''].join('\n'));
  const v = runNoId('validate', b, '--repo', repo, '--base', base);
  assert.doesNotMatch(v.stdout, /still-needed/);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.doesNotMatch(v.stdout + v.stderr, /refusing/);
});

test('validate: refuses rename, copy, diff --git, quoted, spaced and mixed-case still-needed paths', () => {
  const { b, repo, base } = goodBundle();
  const cases = {
    'diff --git a/ok.js b/tests/patches/x.js\nnew file mode 100644\n': 'tests/patches/x.js',
    'diff --git a/tests/patches/x.js b/ok.js\ndeleted file mode 100644\n': 'tests/patches/x.js',
    'similarity index 90%\nrename from tests/patches/x.js\nrename to server/ok.js\n': 'tests/patches/x.js',
    'similarity index 90%\nrename from server/ok.js\nrename to tests/patches/x.js\n': 'tests/patches/x.js',
    'copy from server/ok.js\ncopy to "tests/patches/x.js"\n': 'tests/patches/x.js',
    '--- "a/tests/patches/x.js"\n+++ "b/server/ok.js"\n': 'tests/patches/x.js',
    '--- a/server/ok.js\n+++ b/tests/patches/my file.js\t2026-01-01 00:00:00\n': 'tests/patches/my file.js',
    'diff --git "a/ok.js" "b/tests/patches/q x.js"\n': 'tests/patches/q x.js',
    'diff --git a/my dir/ok.js b/tests/patches/x y.js\n': 'tests/patches/x y.js',
    '--- a/Tests/Patches/x.js\n+++ b/Tests/Patches/x.js\n': 'Tests/Patches/x.js',
  };
  for (const [text, shown] of Object.entries(cases)) {
    put(b, 'patches/02-own.patch', text);
    const r = runNoId('validate', b, '--repo', repo, '--base', base);
    assert.equal(r.status, 2, text + r.stdout);
    assert.match(r.stdout, REFUSE_TESTS, text);
    assert.ok(r.stdout.split('\n').some((x) => x.endsWith(`: ${shown}`)), text + r.stdout);
  }
});

test('validate: a hunk body line that looks like a header does not trigger the refusal', () => {
  const { b, repo, base } = goodBundle();
  put(b, 'patches/02-ok.patch', [
    'diff --git a/server/notes.txt b/server/notes.txt', '--- a/server/notes.txt', '+++ b/server/notes.txt',
    '@@ -1,2 +1,2 @@', '--- a/tests/patches/x', '+++ b/tests/patches/x', ' ctx', ''].join('\n'));
  const v = runNoId('validate', b, '--repo', repo, '--base', base);
  assert.doesNotMatch(v.stdout, /still-needed/);
  // after the hunk ends, a real header is seen again
  put(b, 'patches/02-ok.patch', [
    '--- a/server/notes.txt', '+++ b/server/notes.txt', '@@ -1 +1 @@', '-a', '+b',
    '--- a/tests/patches/x', '+++ b/tests/patches/x', ''].join('\n'));
  const w = runNoId('validate', b, '--repo', repo, '--base', base);
  assert.equal(w.status, 2);
  assert.match(w.stdout, REFUSE_TESTS);
});

test('check: a bundle with no tests at all is fine', () => {
  const { b } = goodBundle();
  assert.ok(!fs.existsSync(path.join(b, 'files', 'server', 'tests')));
  const r = check(b);
  assert.equal(r.status, 0, r.stdout);
});

test('check: refuses a BUG-REPORT.md without a Trade-offs and behaviour changes heading', () => {
  const { b } = goodBundle();
  const r = breakIt(b, (x) => put(x, 'BUG-REPORT.md', '# Bug\n\nShort.\n'));
  assert.equal(r.status, 2, r.stdout);
  assert.deepEqual(refusals(r), ['refusing: BUG-REPORT.md has no "Trade-offs and behaviour changes" section']);
});

test('check: accepts the section holding just None., any heading level and case', () => {
  for (const h of ['## Trade-offs and behaviour changes', '### TRADE-OFFS AND BEHAVIOUR CHANGES', '# trade-offs and behaviour changes']) {
    const { b } = goodBundle();
    const r = breakIt(b, (x) => put(x, 'BUG-REPORT.md', `# Bug\n\n${h}\n\nNone.\n`));
    assert.equal(r.status, 0, `${h}: ${r.stdout}`);
  }
  const { b } = goodBundle();
  const r = breakIt(b, (x) => put(x, 'BUG-REPORT.md', '# Bug\n\nSee trade-offs and behaviour changes below.\n'));
  assert.equal(r.status, 2, 'prose mention is not a heading');
});

test('the still-needed matcher: folder segment only, backslashes normalised', () => {
  const { isStillNeededTestPath: m } = require('../skills/upstream-report/scripts/bundle.js');
  for (const p of ['tests/patches/a.js', 'files/server/tests/patches/a.js', 'files\\server\\tests\\patches\\a.js', 'b/server/tests/patches/a.js']) assert.ok(m(p), p);
  for (const p of ['server/tests/patches-cleanup/a.js', 'server/tests/x/patches/a.js', 'server/src/tests-patches/a.js', 'server/mytests/patches/a.js', 'server/tests/mypatches/a.js', 'server/tests/patches.js', 'tests/patchesx/a.js']) assert.ok(!m(p), p);
  assert.ok(m('server/Tests/Patches/a.js'));
});
