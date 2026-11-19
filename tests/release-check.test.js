'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs, winCmdLine } = require('../scripts/release-check.js');

const REPO = path.join(__dirname, '..');
const tmp = () => require('./fixtures/tmp.js').mk('release-test-');
const { cleanEnv } = require('./fixtures/tmp.js');
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// Fakes log their argv as JSON lines to $FAKE_LOG; a path ending in .js is run with node (also on Windows).
const FAKE = (name) => `'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: '${name}', args }) + '\\n');
if ('${name}' === 'claude' && args.includes('-p')) console.log('skills: upstream-report and upstream-report-perf');
if (process.env.FAKE_FAIL === '${name}' && args[0] !== '--version') { console.error('fake failure'); process.exit(1); }
`;

// A throwaway repo on main with a local bare repo as its remote, plus the fakes.
function setup() {
  const base = fs.realpathSync(tmp());
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  for (const f of ['.claude-plugin', 'scripts', 'skills', 'LICENSE', 'README.md', 'package.json', '.gitignore']) {
    fs.cpSync(path.join(REPO, f), path.join(repo, f), { recursive: true });
  }
  const remote = path.join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Release Test');
  git(repo, 'config', 'user.email', 'release-test@users.noreply.github.com');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'main');
  const log = path.join(base, 'calls.log');
  const ghJs = path.join(base, 'fake-gh.js');
  const claudeJs = path.join(base, 'fake-claude.js');
  const testJs = path.join(base, 'fake-test.js');
  fs.writeFileSync(ghJs, FAKE('gh'));
  fs.writeFileSync(claudeJs, FAKE('claude'));
  fs.writeFileSync(testJs, FAKE('tests'));
  const env = {
    ...cleanEnv(),
    FAKE_LOG: log,
    EVEJS_CONTRIB_GH: ghJs,
    EVEJS_CONTRIB_TEST_NO_REMOTE_CHECK: '1', // the fixture's remote is a local bare repo, not <owner>/<repo>
    EVEJS_CONTRIB_CLAUDE: claudeJs,
    EVEJS_CONTRIB_TEST: testJs,
    EVEJS_CONTRIB_CONFIG_DIR: path.join(base, 'config'),
  };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const run = (...args) => spawnSync(process.execPath, [path.join(repo, 'scripts', 'release-check.js'), ...args], { cwd: repo, encoding: 'utf8', env });
  return { base, repo, remote, calls, run, env };
}
const versionIn = (repo) => JSON.parse(fs.readFileSync(path.join(repo, '.claude-plugin', 'plugin.json'), 'utf8')).version;

test('parseArgs', () => {
  assert.deepEqual(parseArgs([]), { terms: null, skipSmoke: false, skipValidate: false });
  assert.equal(parseArgs(['--skip-smoke', '--terms', 'f']).terms, 'f');
  assert.throws(() => parseArgs(['--terms']), /needs a value/);
  for (const flag of ['--nope', '--patch', '--minor', '--major', '--dry-run', '--owner']) assert.throws(() => parseArgs([flag]), /unknown argument/);
});

test('passes: validates, smoke tests, and changes nothing (no commit, tag, push or gh call)', () => {
  const s = setup();
  const head = git(s.repo, 'rev-parse', 'HEAD');
  const r = s.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const claude = s.calls().filter((c) => c.tool === 'claude').map((c) => c.args.join(' '));
  assert.ok(claude.includes('plugin validate --strict .'));
  assert.ok(claude.some((a) => a.includes('--plugin-dir .') && a.includes('-p ')));
  assert.ok(!claude.some((a) => a.startsWith('plugin update') || a.startsWith('plugin marketplace')), 'no install update');
  assert.ok(!s.calls().some((c) => c.tool === 'gh'));
  assert.equal(git(s.repo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(s.repo, 'status', '--porcelain'), '');
  assert.equal(git(s.repo, 'tag', '--list'), '');
  assert.equal(git(s.remote, 'tag', '--list'), '');
  assert.ok(!fs.existsSync(path.join(s.repo, 'dist')));
});

test('--skip-smoke skips only the smoke test', () => {
  const s = setup();
  const r = s.run('--skip-smoke');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(s.calls().some((c) => c.tool === 'claude' && c.args[0] === 'plugin'));
  assert.ok(!s.calls().some((c) => c.tool === 'claude' && c.args.includes('-p')));
});

test('a failing validate refuses', () => {
  const s = setup();
  s.env.FAKE_FAIL = 'claude';
  const r = s.run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /claude plugin validate --strict failed/);
});

test('a smoke test that misses a skill refuses', () => {
  const s = setup();
  fs.writeFileSync(path.join(s.base, 'fake-claude.js'), FAKE('claude').replace(/console\.log\('skills:[^']*'\)/, "console.log('skills: none')"));
  const r = s.run();
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /did not list/);
});

test('without a runnable claude it refuses unless --skip-validate is given', () => {
  const s = setup();
  s.env.EVEJS_CONTRIB_CLAUDE = path.join(s.base, 'no-such-claude');
  const r = s.run();
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /claude cannot be found or run.*--skip-validate/);
  const ok = s.run('--skip-validate');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /validation and smoke test skipped \(--skip-validate\)/);
  assert.equal(s.calls().filter((c) => c.tool === 'claude').length, 0);
});

test('a private term in a tracked file refuses before claude runs; generic example paths are fine', () => {
  const s = setup();
  fs.mkdirSync(path.join(s.repo, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(s.repo, 'tests', 'fixture.js'), '// the flurbo project\n');
  git(s.repo, 'add', '-A');
  git(s.repo, 'commit', '-q', '-m', 'fixture');
  const terms = path.join(s.base, 'terms');
  fs.writeFileSync(terms, 'flurbo\n');
  const r = s.run('--skip-smoke', '--terms', terms);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /tests\/fixture\.js:1: flurbo/);
  assert.deepEqual(s.calls(), []);
  fs.writeFileSync(path.join(s.repo, 'tests', 'fixture.js'), '// /home/sam/x and box.lan\n');
  git(s.repo, 'commit', '-q', '-am', 'example paths');
  assert.equal(s.run('--skip-smoke').status, 0);
});

test('on Windows a claude.cmd found on PATH is run through cmd.exe', () => {
  const { bin } = require('../scripts/release-check.js');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\n');
  const b = bin('EVEJS_CONTRIB_CLAUDE', 'claude', { PATH: dir }, 'win32');
  assert.deepEqual(b, { cmd: path.join(dir, 'claude.cmd'), pre: [], shim: true });
  assert.deepEqual(bin('EVEJS_CONTRIB_CLAUDE', 'claude', { PATH: tmp() }, 'win32'), { cmd: 'claude', pre: [] });
  assert.deepEqual(bin('EVEJS_CONTRIB_CLAUDE', 'claude', { PATH: dir }, 'linux'), { cmd: 'claude', pre: [] });
});

test('Windows PATH lookup is directory-first: an earlier directory wins whatever its extension', () => {
  const { bin } = require('../scripts/release-check.js');
  const first = tmp();
  const second = tmp();
  fs.writeFileSync(path.join(first, 'claude.cmd'), '@echo off\n');
  fs.writeFileSync(path.join(second, 'claude.exe'), '');
  const env = { PATH: [first, second].join(path.delimiter) };
  assert.equal(bin('EVEJS_CONTRIB_CLAUDE', 'claude', env, 'win32').cmd, path.join(first, 'claude.cmd'));
  fs.writeFileSync(path.join(first, 'claude.exe'), '');
  assert.equal(bin('EVEJS_CONTRIB_CLAUDE', 'claude', env, 'win32').cmd, path.join(first, 'claude.exe'), '.exe before .cmd within a directory');
});

test('a .cmd shim line quotes every argument and refuses cmd metacharacters', () => {
  assert.equal(winCmdLine(['C:\\Program Files\\claude.cmd', '--plugin-dir', '.']), '""C:\\Program Files\\claude.cmd" "--plugin-dir" ".""');
  for (const bad of ['a&b', 'a|b', 'a<b', 'a>b', 'a^b', '%PATH%', 'a!b', 'say "hi"', 'a\nb', '{"mcpServers":{}}']) {
    assert.throws(() => winCmdLine(['claude.cmd', bad]), /cannot pass .* through cmd\.exe/, bad);
  }
});

test('the smoke test passes the MCP config as a file path', () => {
  const s = setup();
  const r = s.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const smoke = s.calls().find((c) => c.tool === 'claude' && c.args.includes('-p'));
  const cfg = smoke.args[smoke.args.indexOf('--mcp-config') + 1];
  assert.ok(!/[{"]/.test(cfg), cfg);
  assert.ok(!fs.existsSync(cfg), 'temp config cleaned up');
});

