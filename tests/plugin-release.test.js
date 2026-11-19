'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { bumped, parseArgs, winCmdLine } = require('../scripts/plugin-release.js');

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
  const run = (...args) => spawnSync(process.execPath, [path.join(repo, 'scripts', 'plugin-release.js'), ...args], { cwd: repo, encoding: 'utf8', env });
  return { base, repo, remote, calls, run, env };
}
const versionIn = (repo) => JSON.parse(fs.readFileSync(path.join(repo, '.claude-plugin', 'plugin.json'), 'utf8')).version;

test('bumped and parseArgs', () => {
  assert.equal(bumped('0.1.9', 'patch'), '0.1.10');
  assert.equal(bumped('0.1.9', 'minor'), '0.2.0');
  assert.equal(bumped('0.1.9', 'major'), '1.0.0');
  assert.throws(() => bumped('x', 'patch'), /MAJOR\.MINOR\.PATCH/);
  assert.equal(parseArgs([]).remote, 'origin');
  assert.equal(parseArgs(['--minor', '--owner', 'o', '--dry-run']).bump, 'minor');
  assert.throws(() => parseArgs(['--owner']), /needs a value/);
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
});

test('refuses a dirty tree', () => {
  const s = setup();
  fs.appendFileSync(path.join(s.repo, 'README.md'), '\nedited\n');
  const r = s.run('--skip-smoke');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /working tree is dirty/);
  assert.deepEqual(s.calls(), []);
});

test('refuses a branch other than main', () => {
  const s = setup();
  git(s.repo, 'checkout', '-q', '-b', 'feature');
  const r = s.run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /release from main only \(on feature\)/);
});

test('refuses a remote that does not exist', () => {
  const s = setup();
  const r = s.run('--remote', 'nowhere');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no git remote named nowhere/);
  assert.equal(versionIn(s.repo), '0.1.0');
});

test('full run: bumps, tags, pushes, creates the release with the zip, updates the install', () => {
  const s = setup();
  const before = versionIn(s.repo);
  const r = s.run('--owner', 'someowner');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const want = bumped(before, 'patch');
  assert.equal(versionIn(s.repo), want);
  assert.equal(git(s.repo, 'log', '-1', '--format=%s'), `release: v${want}`);
  assert.equal(git(s.repo, 'rev-parse', `v${want}^{commit}`), git(s.repo, 'rev-parse', 'HEAD'));
  assert.equal(git(s.repo, 'status', '--porcelain'), '');
  // the bare remote got the branch tip and the tag
  assert.equal(git(s.remote, 'rev-parse', 'main'), git(s.repo, 'rev-parse', 'HEAD'));
  assert.equal(git(s.remote, 'rev-parse', `v${want}^{commit}`), git(s.repo, 'rev-parse', 'HEAD'));
  const zip = path.join(s.repo, 'dist', `evejs-contrib-${want}.zip`);
  assert.ok(fs.existsSync(zip));
  const calls = s.calls();
  const gh = calls.filter((c) => c.tool === 'gh');
  assert.equal(gh.length, 1);
  assert.deepEqual(gh[0].args.slice(0, 4), ['release', 'create', `v${want}`, zip]);
  assert.equal(gh[0].args[gh[0].args.indexOf('--repo') + 1], 'someowner/evejs-contrib');
  const claude = calls.filter((c) => c.tool === 'claude').map((c) => c.args.join(' '));
  assert.ok(claude.some((a) => a === 'plugin validate --strict .'));
  assert.ok(claude.some((a) => a.includes('--plugin-dir .') && a.includes('-p ')));
  assert.ok(claude.includes('plugin marketplace update evejs-contrib'));
  assert.ok(claude.includes('plugin update evejs-contrib@evejs-contrib'));
  assert.ok(calls.some((c) => c.tool === 'tests'));
  assert.match(r.stdout, /restart or \/reload-plugins/);
});

test('owner defaults to the one in package.json repository; --minor bumps the minor', () => {
  const s = setup();
  const r = s.run('--minor', '--skip-smoke');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(versionIn(s.repo), '0.2.0');
  const gh = s.calls().find((c) => c.tool === 'gh');
  const { repository } = JSON.parse(fs.readFileSync(path.join(s.repo, 'package.json'), 'utf8'));
  assert.equal(gh.args[gh.args.indexOf('--repo') + 1], repository.replace('https://github.com/', ''));
  assert.ok(!s.calls().some((c) => c.tool === 'claude' && c.args.includes('-p')), 'smoke skipped');
});

test('--dry-run changes nothing and pushes nothing', () => {
  const s = setup();
  const head = git(s.repo, 'rev-parse', 'HEAD');
  const r = s.run('--dry-run', '--owner', 'someowner');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(git(s.repo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(s.repo, 'status', '--porcelain'), '');
  assert.equal(git(s.repo, 'tag', '--list'), '');
  assert.equal(git(s.remote, 'tag', '--list'), '');
  assert.equal(versionIn(s.repo), '0.1.0');
  assert.ok(!fs.existsSync(path.join(s.repo, 'dist')));
  assert.ok(!fs.existsSync(path.join(s.repo, '.git', 'FETCH_HEAD')), 'no fetch');
  assert.ok(!s.calls().some((c) => c.tool === 'gh'), 'gh not called');
  assert.ok(!s.calls().some((c) => c.tool === 'claude' && c.args[0] === 'plugin' && c.args[1] !== 'validate'), 'no install update');
  assert.match(r.stdout, /\[dry-run\] git push --atomic origin main v0\.1\.1/);
  assert.match(r.stdout, /\[dry-run\] .*release create v0\.1\.1 .*--repo someowner\/evejs-contrib/);
  assert.match(r.stdout, /\[dry-run\] .*plugin marketplace update evejs-contrib/);
  assert.match(r.stdout, /\[dry-run\] .*plugin update evejs-contrib@evejs-contrib/);
});

test('a failing validate refuses before anything changes', () => {
  const s = setup();
  s.env.FAKE_FAIL = 'claude';
  const r = s.run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /claude plugin validate --strict failed/);
  assert.equal(versionIn(s.repo), '0.1.0');
  assert.equal(git(s.repo, 'tag', '--list'), '');
});

test('a leak found while building undoes the commit and tag and pushes nothing', () => {
  const s = setup();
  fs.appendFileSync(path.join(s.repo, 'README.md'), '\nsee /home/sam/x\n');
  git(s.repo, 'commit', '-q', '-am', 'leak');
  const head = git(s.repo, 'rev-parse', 'HEAD');
  const r = s.run('--skip-smoke');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /home-path/);
  assert.equal(git(s.repo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(s.repo, 'tag', '--list'), '');
  assert.equal(versionIn(s.repo), '0.1.0');
  assert.equal(git(s.remote, 'tag', '--list'), '');
  assert.ok(!s.calls().some((c) => c.tool === 'gh'));
});

test('without a runnable claude it refuses, dry-run included, unless --skip-validate is given', () => {
  const s = setup();
  s.env.EVEJS_CONTRIB_CLAUDE = path.join(s.base, 'no-such-claude');
  for (const args of [[], ['--dry-run']]) {
    const r = s.run(...args);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /claude cannot be found or run.*--skip-validate/);
  }
  assert.equal(versionIn(s.repo), '0.1.0');
  assert.equal(git(s.repo, 'tag', '--list'), '');
  const ok = s.run('--skip-validate');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /validation and smoke test skipped \(--skip-validate\)/);
  assert.equal(s.calls().filter((c) => c.tool === 'claude').length, 0);
  assert.equal(s.calls().filter((c) => c.tool === 'gh').length, 1);
});

test('refuses before committing when the remote already has the tag or is ahead', () => {
  const s = setup();
  // another clone pushes the tag the release would create
  const other = path.join(s.base, 'other');
  git(s.base, 'clone', '-q', s.remote, other);
  git(other, 'config', 'user.name', 'Other');
  git(other, 'config', 'user.email', 'other@example.org');
  git(other, 'tag', 'v0.1.1');
  git(other, 'push', '-q', 'origin', 'v0.1.1');
  let r = s.run('--skip-smoke');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /origin already has tag v0\.1\.1/);
  assert.equal(git(s.repo, 'tag', '--list'), '');
  assert.equal(versionIn(s.repo), '0.1.0');
  // and a commit on the remote's main that this checkout lacks
  git(other, 'push', '-q', 'origin', ':refs/tags/v0.1.1');
  fs.writeFileSync(path.join(other, 'extra.txt'), 'x\n');
  git(other, 'add', 'extra.txt');
  git(other, 'commit', '-q', '-m', 'ahead');
  git(other, 'push', '-q', 'origin', 'main');
  r = s.run('--skip-smoke');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /origin\/main has commits this checkout lacks/);
  assert.equal(git(s.repo, 'tag', '--list'), '');
  assert.equal(versionIn(s.repo), '0.1.0');
  assert.ok(!s.calls().some((c) => c.tool === 'gh'));
});

test('a failed push says what is left locally and how to undo or retry, and publishes nothing', () => {
  const s = setup();
  // a pre-receive hook on the bare remote rejects everything; --atomic means neither ref lands
  const hook = path.join(s.remote, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const r = s.run('--skip-smoke');
  if (process.platform === 'win32') return; // hooks need a POSIX shell
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /git push failed; nothing was published/);
  assert.match(r.stderr, /release commit and tag v0\.1\.1 are still local/);
  assert.match(r.stderr, /Retry: git push --atomic origin main v0\.1\.1/);
  assert.match(r.stderr, /Undo:  git tag -d v0\.1\.1 && git reset --hard [0-9a-f]{40}/);
  assert.equal(git(s.remote, 'tag', '--list'), '');
  assert.ok(!s.calls().some((c) => c.tool === 'gh'));
  assert.equal(git(s.repo, 'tag', '--list'), 'v0.1.1');
});

test('--terms is passed to the zip build', () => {
  const s = setup();
  fs.appendFileSync(path.join(s.repo, 'README.md'), '\nthe flurbo project\n');
  git(s.repo, 'commit', '-q', '-am', 'word');
  const terms = path.join(s.base, 'terms');
  fs.writeFileSync(terms, 'flurbo\n');
  const r = s.run('--skip-smoke', '--terms', terms);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /README\.md:\d+: flurbo/);
  assert.equal(git(s.repo, 'tag', '--list'), '');
  assert.ok(!s.calls().some((c) => c.tool === 'gh'));
});

test('on Windows a claude.cmd found on PATH is run through cmd.exe', () => {
  const { bin } = require('../scripts/plugin-release.js');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\n');
  const b = bin('EVEJS_CONTRIB_CLAUDE', 'claude', { PATH: dir }, 'win32');
  assert.deepEqual(b, { cmd: path.join(dir, 'claude.cmd'), pre: [], shim: true });
  assert.deepEqual(bin('EVEJS_CONTRIB_CLAUDE', 'claude', { PATH: tmp() }, 'win32'), { cmd: 'claude', pre: [] });
  assert.deepEqual(bin('EVEJS_CONTRIB_CLAUDE', 'claude', { PATH: dir }, 'linux'), { cmd: 'claude', pre: [] });
});

test('Windows PATH lookup is directory-first: an earlier directory wins whatever its extension', () => {
  const { bin } = require('../scripts/plugin-release.js');
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

// ---- final-review fixes: history emails, tracked-tree scan, remote vs owner ----
test('refuses when a commit in the history has a non-noreply author or committer email', () => {
  const s = setup();
  fs.appendFileSync(path.join(s.repo, 'README.md'), '\nmore\n');
  git(s.repo, 'config', 'user.email', 'someone@example.org');
  git(s.repo, 'commit', '-q', '-am', 'private address');
  git(s.repo, 'config', 'user.email', 'release-test@users.noreply.github.com');
  const r = s.run('--skip-smoke', '--dry-run');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /not a @users\.noreply\.github\.com address/);
  assert.doesNotMatch(r.stderr, /someone@example/, 'the address itself is not printed');
  assert.equal(git(s.repo, 'tag', '--list'), '');
  assert.deepEqual(s.calls().filter((c) => c.tool === 'gh'), []);
});

test('refuses when this checkout would author the release commit with a private address', () => {
  const s = setup();
  git(s.repo, 'config', 'user.email', 'someone@example.org');
  const r = s.run('--skip-smoke');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /GIT_(AUTHOR|COMMITTER)_IDENT is not a @users\.noreply\.github\.com address/);
  assert.equal(versionIn(s.repo), '0.1.0');
});

test('a private term in a tracked file that is not in the zip refuses before anything is committed', () => {
  const s = setup();
  fs.mkdirSync(path.join(s.repo, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(s.repo, 'tests', 'fixture.js'), '// the flurbo project\n');
  git(s.repo, 'add', '-A');
  git(s.repo, 'commit', '-q', '-m', 'fixture');
  const terms = path.join(s.base, 'terms');
  fs.writeFileSync(terms, 'flurbo\n');
  const r = s.run('--skip-smoke', '--terms', terms, '--dry-run');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /tests\/fixture\.js:1: flurbo/);
  assert.equal(git(s.repo, 'tag', '--list'), '');
  // generic example paths in fixtures are fine
  fs.writeFileSync(path.join(s.repo, 'tests', 'fixture.js'), '// /home/sam/x and box.lan\n');
  git(s.repo, 'commit', '-q', '-am', 'example paths');
  const ok = s.run('--skip-smoke', '--dry-run');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
});

test('refuses when --remote is not the repository the release would be created on', () => {
  const s = setup();
  const env = { ...s.env };
  delete env.EVEJS_CONTRIB_TEST_NO_REMOTE_CHECK;
  const r = spawnSync(process.execPath, [path.join(s.repo, 'scripts', 'plugin-release.js'), '--owner', 'someowner', '--skip-smoke', '--dry-run'], { cwd: s.repo, encoding: 'utf8', env });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /is not someowner\/evejs-contrib/);
  assert.deepEqual(s.calls(), []);
});

test('the remote-vs-owner check still runs when EVEJS_CONTRIB_GH points at another gh', () => {
  const s = setup();
  const env = { ...s.env };
  delete env.EVEJS_CONTRIB_TEST_NO_REMOTE_CHECK;
  assert.ok(env.EVEJS_CONTRIB_GH);
  const r = spawnSync(process.execPath, [path.join(s.repo, 'scripts', 'plugin-release.js'), '--owner', 'someowner', '--skip-smoke', '--dry-run'], { cwd: s.repo, encoding: 'utf8', env });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /is not someowner\/evejs-contrib/);
});
