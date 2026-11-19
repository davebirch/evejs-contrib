'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { configDir } = require('../skills/upstream-report/scripts/lib/config.js');

const SCRIPT = path.join(__dirname, '..', 'skills', 'upstream-report', 'scripts', 'leak-terms.js');
const SCAN = path.join(__dirname, '..', 'skills', 'upstream-report', 'scripts', 'leak-scan.js');
const tmp = () => require('./fixtures/tmp.js').mk('terms-test-');
const cfg = tmp();
const env = { ...process.env, EVEJS_CONTRIB_CONFIG_DIR: cfg };
const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', env });
const termsFile = path.join(cfg, 'leak-terms');

function fixtureLogs() {
  const logs = tmp();
  fs.writeFileSync(path.join(logs, 'server.log'),
    '\uFEFF[Session 10.0.0.9:5000 user=acct_alpha(77) char=Pilot Alpha(9001)] login ok\r\n' +
    '[CharService] Created character "Pilot Beta" with ID 9002 ship=5\r\n' +
    '[CharService] CreateCharacterWithDoll: name="Pilot Gamma" race=1 bloodline=2\r\n' +
    '[CharState] Applied Pilot Alpha(9001) ship=Rifter(587) activeShipID=1\r\n' +
    '[OwnerGroupManager] Create char=9001 name="Some Access Group"\r\n' +
    '[Session 10.0.0.9:5000 user=undefined(undefined) char=undefined(undefined)]\r\n' +
    '{"event":"closeWatchStarted","startedBy":4242}\r\n' +
    'connect from nas.local ok\r\n');
  return logs;
}

test('configDir: APPDATA, then XDG_CONFIG_HOME, then ~/.config (platform cases, no globals touched)', () => {
  assert.equal(configDir({ APPDATA: path.join('C:', 'Roaming') }, '/h'), path.join('C:', 'Roaming', 'evejs-contrib'));
  assert.equal(configDir({ APPDATA: 'A', XDG_CONFIG_HOME: 'X' }, '/h'), path.join('A', 'evejs-contrib'));
  assert.equal(configDir({ XDG_CONFIG_HOME: '/x/cfg' }, '/h'), path.join('/x/cfg', 'evejs-contrib'));
  assert.equal(configDir({ HOME: '/mac/home' }, '/h'), path.join('/mac/home', '.config', 'evejs-contrib'));
  assert.equal(configDir({ USERPROFILE: 'U' }, '/h'), path.join('U', '.config', 'evejs-contrib'));
  assert.equal(configDir({}, '/h'), path.join('/h', '.config', 'evejs-contrib'));
  assert.equal(configDir({ EVEJS_CONTRIB_CONFIG_DIR: '/t', APPDATA: 'A' }, '/h'), '/t');
});

test('init proposes candidates and writes nothing without --yes', () => {
  const logs = fixtureLogs();
  const r = run('init', '--logs', logs);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, ''));
  assert.ok(lines.some((l) => /^Pilot Alpha .*character name.*character name in logs/.test(l)), r.stdout);
  assert.ok(lines.some((l) => /^Pilot Beta /.test(l)));
  assert.ok(lines.some((l) => /^Pilot Gamma /.test(l)));
  assert.ok(lines.some((l) => /^acct_alpha .*account name in logs/.test(l)));
  assert.ok(lines.some((l) => /^nas\.local .*LAN-style/.test(l)));
  assert.ok(!lines.some((l) => /Access Group|4242|undefined|Rifter/.test(l)), r.stdout);
  assert.match(r.stdout, /anything else you would rather not share/);
  assert.ok(!fs.existsSync(termsFile));
});

test('init --yes writes the confirmed list under the config dir; scan reads it', () => {
  const r = run('init', '--add', 'Acme Hosting', '--add', 'nas.local', '--character', 'Pilot Alpha', '--yes');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /scanning for 3 private terms \(1 character names\)/);
  const text = fs.readFileSync(termsFile, 'utf8');
  assert.ok(text.indexOf('Acme Hosting') < text.indexOf('[character-names]'));
  assert.ok(text.indexOf('[character-names]') < text.indexOf('Pilot Alpha'));
  assert.ok(!text.includes('\r'));
  const scan = tmp();
  fs.writeFileSync(path.join(scan, 'a.txt'), 'by pilot alpha at acme hosting');
  const s = spawnSync(process.execPath, [SCAN, scan, '--no-identity'], { encoding: 'utf8', env });
  assert.equal(s.status, 2);
  assert.match(s.stdout, /a\.txt:1: Acme Hosting/);
  assert.match(s.stdout, /a\.txt:1: character-name/);
  assert.doesNotMatch(s.stdout, /Pilot Alpha/);
});

test('edit --add/--remove/--character round-trips and keeps comments', () => {
  fs.writeFileSync(termsFile, '# mine\r\nAcme Hosting\r\n[character-names]\r\nPilot Alpha\r\n');
  let r = run('edit', '--add', 'ExampleCorp', '--character', 'Pilot Gamma', '--remove', 'Acme Hosting', '--remove', 'Pilot Alpha');
  assert.equal(r.status, 0, r.stderr);
  const text = fs.readFileSync(termsFile, 'utf8');
  assert.ok(text.startsWith('# mine\n'));
  assert.ok(text.includes('ExampleCorp') && text.includes('Pilot Gamma'));
  assert.ok(!text.includes('Acme') && !text.includes('Pilot Alpha'));
  assert.ok(text.indexOf('ExampleCorp') < text.indexOf('[character-names]'));
  r = run('edit', '--add', 'ExampleCorp'); // no duplicates
  assert.equal(fs.readFileSync(termsFile, 'utf8').match(/ExampleCorp/g).length, 1);
});

test('show summarises and lists new character names from logs', () => {
  fs.writeFileSync(termsFile, 'ExampleCorp\n[character-names]\nPilot Alpha\n');
  const r = run('show', '--logs', fixtureLogs());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /scanning for 2 private terms \(1 character names\); leak-terms edit to change/);
  assert.match(r.stdout, /new character names: Pilot Beta, Pilot Gamma$/m);
});

test('--terms picks the file; nothing is written to the plugin dir; usage errors exit 64', () => {
  const other = path.join(tmp(), 'sub', 't');
  assert.equal(run('init', '--terms', other, '--add', 'ExampleCorp', '--yes').status, 0);
  assert.ok(fs.readFileSync(other, 'utf8').includes('ExampleCorp'));
  assert.equal(run().status, 64);
  assert.equal(run('bogus').status, 64);
  assert.equal(run('init', '--add').status, 64);
  assert.equal(run('init', '--logs', '/no/such/dir').status, 64);
  const pluginDir = path.join(__dirname, '..', 'skills', 'upstream-report');
  assert.ok(!fs.existsSync(path.join(pluginDir, 'leak-terms')));
});

test('edit with no flags runs $EDITOR without a shell, even when the config dir has spaces', () => {
  const dir = path.join(tmp(), 'dir with spaces');
  fs.mkdirSync(dir);
  const fake = path.join(dir, 'fake-editor.js');
  fs.writeFileSync(fake, "require('fs').appendFileSync(process.argv[process.argv.length - 1], 'EditedByFake\\n');");
  const e = { ...process.env, EVEJS_CONTRIB_CONFIG_DIR: dir, EDITOR: `"${process.execPath}" "${fake}"` };
  const r = spawnSync(process.execPath, [SCRIPT, 'edit'], { encoding: 'utf8', env: e });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.readFileSync(path.join(dir, 'leak-terms'), 'utf8').includes('EditedByFake'));
});

test('edit reports a failed editor with a non-zero exit', () => {
  const e = { ...process.env, EVEJS_CONTRIB_CONFIG_DIR: tmp(), EDITOR: 'no-such-editor-binary-xyz' };
  const r = spawnSync(process.execPath, [SCRIPT, 'edit'], { encoding: 'utf8', env: e });
  assert.notEqual(r.status, 0);
  // On Windows the bare name is retried through cmd.exe (so code.cmd works), which then reports the missing
  // command itself and exits non-zero; elsewhere we print our own message.
  assert.match(r.stderr, process.platform === 'win32' ? /not recognized|could not run editor/ : /could not run editor/);
});

test('editorSpawn: .cmd/.bat editors on Windows go through a quoted shell command; others do not', () => {
  const { editorSpawn } = require('../skills/upstream-report/scripts/leak-terms.js');
  const win = editorSpawn(['C:\\Tools\\My Ed\\code.cmd', '--wait'], 'C:\\Users\\x y\\leak-terms', 'win32');
  assert.equal(win.options.shell, true);
  assert.equal(win.cmd, '"C:\\Tools\\My Ed\\code.cmd" "--wait" "C:\\Users\\x y\\leak-terms"');
  assert.deepEqual(win.args, []);
  const exe = editorSpawn(['C:\\Tools\\ed.exe'], 'f', 'win32');
  assert.ok(!exe.options.shell);
  assert.deepEqual([exe.cmd, exe.args], ['C:\\Tools\\ed.exe', ['f']]);
  const nix = editorSpawn(['vi'], '/a b/f', 'linux');
  assert.ok(!nix.options.shell);
  assert.deepEqual([nix.cmd, nix.args], ['vi', ['/a b/f']]);
});

test('runEditor: on win32 an ENOENT retries once through a quoted shell command', () => {
  const { runEditor } = require('../skills/upstream-report/scripts/leak-terms.js');
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return calls.length === 1 ? { error: { code: 'ENOENT' } } : { status: 0 };
  };
  const r = runEditor(['code', '--wait'], 'C:\\a b\\leak-terms', { platform: 'win32', spawn });
  assert.equal(r.status, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].cmd, 'code');
  assert.equal(calls[1].cmd, '"code" "--wait" "C:\\a b\\leak-terms"');
  assert.equal(calls[1].opts.shell, true);
  // no retry elsewhere, and none when the first spawn works
  calls.length = 0;
  assert.equal(runEditor(['vi'], 'f', { platform: 'linux', spawn }).error.code, 'ENOENT');
  assert.equal(calls.length, 1);
});

// ---- fix round 5 ----
test('init --logs accepts a report zip (read in memory) and proposes character names and account logins', () => {
  const { writeZip } = require('../skills/upstream-report/scripts/lib/zip.js');
  const dir = tmp();
  const zip = path.join(dir, 'error-report.zip');
  writeZip([
    { name: 'server-logs/server-health.log', data: Buffer.from('2026-11-18T00:00:00Z INF [Session 7 user=acct_zq(1001) char=Pilot Zed(90000001)] logged in\n') },
    { name: 'manifest.json', data: Buffer.from('{}') },
  ], zip);
  const before = fs.readdirSync(dir).sort();
  const r = run('init', '--logs', zip);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\d+\. Pilot Zed .*character name/m);
  assert.match(r.stdout, /^\d+\. acct_zq .*account name in logs/m);
  assert.deepEqual(fs.readdirSync(dir).sort(), before, 'nothing written next to the zip');
  assert.equal(run('init', '--logs', path.join(dir, 'missing.zip')).status, 64);
});

test('init says plainly that a proposal writes nothing, with or without --add', () => {
  const MSG = 'proposal only; nothing written — re-run with --yes and the confirmed list';
  assert.ok(run('init').stdout.includes(MSG));
  assert.ok(run('init', '--add', 'ExampleCorp').stdout.includes(MSG));
  assert.ok(!run('init', '--add', 'ExampleCorp', '--yes').stdout.includes('proposal only'));
});

test('--help prints usage and exits 0, for the command and on its own', () => {
  for (const args of [['--help'], ['init', '--help'], ['edit', '-h'], ['show', '--help']]) {
    const r = run(...args);
    assert.equal(r.status, 0, args.join(' '));
    assert.match(r.stdout, /usage: node leak-terms\.js/);
    assert.match(r.stdout, /--yes/);
  }
});

test('init --yes writes proposed identity terms under [identity]; the Signed line passes, other uses hit', () => {
  const gitcfg = path.join(tmp(), 'gitconfig');
  fs.writeFileSync(gitcfg, '[user]\n\tname = Sam Wise\n\temail = samwise@mail.example\n');
  const e = { ...env, EVEJS_CONTRIB_CONFIG_DIR: tmp(), GIT_CONFIG_GLOBAL: gitcfg, GIT_CONFIG_SYSTEM: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
  const opts = { encoding: 'utf8', env: e, cwd: tmp() };
  const r = spawnSync(process.execPath, [SCRIPT, 'init', '--add', 'Sam Wise', '--add', 'samwise', '--add', 'ExampleCorp', '--yes'], opts);
  assert.equal(r.status, 0, r.stderr);
  const text = fs.readFileSync(path.join(e.EVEJS_CONTRIB_CONFIG_DIR, 'leak-terms'), 'utf8');
  const lines = text.split('\n');
  const idAt = lines.indexOf('[identity]');
  assert.ok(idAt > 0, text);
  assert.ok(lines.indexOf('ExampleCorp') < idAt);
  assert.ok(lines.indexOf('Sam Wise') > idAt && lines.indexOf('samwise') > idAt);
  assert.match(r.stdout, /scanning for 3 private terms/);
  const scan = tmp();
  fs.writeFileSync(path.join(scan, 'ok.md'), 'Signed: samwise\n');
  assert.equal(spawnSync(process.execPath, [SCAN, scan, '--no-identity'], opts).status, 0);
  fs.writeFileSync(path.join(scan, 'bad.md'), 'by samwise\nExampleCorp\nSigned: ExampleCorp\n');
  const s = spawnSync(process.execPath, [SCAN, scan, '--no-identity'], opts);
  assert.equal(s.status, 2);
  assert.match(s.stdout, /bad\.md:1: identity/);
  assert.match(s.stdout, /bad\.md:3: ExampleCorp/); // plain terms hit everywhere, Signed line included
});

test('edit --add keeps adding before the first section; an existing [identity] section survives', () => {
  fs.writeFileSync(termsFile, 'A\n[identity]\nsamwise\n[character-names]\nPilot Alpha\n');
  assert.equal(run('edit', '--add', 'B', '--character', 'Pilot Beta').status, 0);
  const lines = fs.readFileSync(termsFile, 'utf8').split('\n');
  assert.ok(lines.indexOf('B') < lines.indexOf('[identity]'));
  assert.ok(lines.indexOf('Pilot Beta') > lines.indexOf('[character-names]'));
  assert.ok(lines.indexOf('samwise') > lines.indexOf('[identity]') && lines.indexOf('samwise') < lines.indexOf('[character-names]'));
});

test('editTermsText: an identity term already present as a plain term moves into [identity]', () => {
  const { editTermsText, parseTerms } = require('../skills/upstream-report/scripts/lib/terms.js');
  const out = editTermsText('# mine\nsamwise\nExampleCorp\n[character-names]\nPilot Alpha\n', { identity: ['SamWise'] });
  const p = parseTerms(out);
  assert.deepEqual(p.identity, ['SamWise']);
  assert.deepEqual(p.terms, ['ExampleCorp']);
  assert.deepEqual(p.names, ['Pilot Alpha']);
  assert.ok(out.includes('# mine'));
  // already in [identity]: unchanged, no duplicate
  assert.equal(editTermsText(out, { identity: ['samwise'] }), out);
});

test('init --yes --add <identity term> migrates an existing plain line (CLI)', () => {
  const gitcfg = path.join(tmp(), 'gitconfig');
  fs.writeFileSync(gitcfg, '[user]\n\tname = Sam Wise\n\temail = samwise@example.org\n');
  const dir = tmp();
  const e = { ...env, EVEJS_CONTRIB_CONFIG_DIR: dir, GIT_CONFIG_GLOBAL: gitcfg, GIT_CONFIG_SYSTEM: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(path.join(dir, 'leak-terms'), 'Sam Wise\nExampleCorp\n');
  const r = spawnSync(process.execPath, [SCRIPT, 'init', '--add', 'Sam Wise', '--yes'], { encoding: 'utf8', env: e, cwd: tmp() });
  assert.equal(r.status, 0, r.stderr);
  const lines = fs.readFileSync(path.join(dir, 'leak-terms'), 'utf8').split('\n');
  assert.equal(lines.filter((l) => l === 'Sam Wise').length, 1);
  assert.ok(lines.indexOf('Sam Wise') > lines.indexOf('[identity]'));
});

test('the older names section and flag still parse, silently; new files use the new names', () => {
  const { parseTerms } = require('../skills/upstream-report/scripts/lib/terms.js');
  const oldHeader = '[' + 'play' + 'er-names]';
  const oldFlag = '--' + 'play' + 'er';
  assert.deepEqual(parseTerms(`${oldHeader}\nPilot Alpha\n`).names, ['Pilot Alpha']);
  fs.writeFileSync(termsFile, `A\n${oldHeader}\nPilot Alpha\n`);
  const r = run('edit', oldFlag, 'Pilot Beta');
  assert.equal(r.status, 0, r.stderr);
  const text = fs.readFileSync(termsFile, 'utf8');
  assert.ok(text.indexOf(oldHeader) < text.indexOf('Pilot Beta'), 'joins the existing section');
  assert.match(r.stdout, /\(2 character names\)/);
  assert.doesNotMatch(r.stdout + r.stderr, /play/i);
  fs.writeFileSync(termsFile, 'A\n');
  assert.equal(run('edit', '--character', 'Pilot Gamma').status, 0);
  assert.ok(fs.readFileSync(termsFile, 'utf8').includes('[character-names]\nPilot Gamma'));
  assert.doesNotMatch(run('--help').stdout + run('init', '--help').stdout, /play/i);
});
