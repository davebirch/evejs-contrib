'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { redactText } = require('../skills/upstream-report/scripts/redact.js');

const CLI = path.join(__dirname, '..', 'skills', 'upstream-report', 'scripts', 'redact.js');
const tmp = () => require('./fixtures/tmp.js').mk('redact-test-');
const isolated = (cfg = tmp()) => ({ ...process.env, EVEJS_CONTRIB_CONFIG_DIR: cfg });
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: isolated() });
const put = (root, rel, text) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const get = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('manifest.json: escaped Windows home path loses the user and stays valid JSON', () => {
  const d = tmp();
  put(d, 'in/manifest.json', JSON.stringify({ schema: 'evejs-error-report/1', logs: { dir: 'C:\\Users\\Sam\\EveJS\\_local\\logs' } }, null, 2));
  const r = run(path.join(d, 'in'), path.join(d, 'out'));
  assert.equal(r.status, 0, r.stderr);
  const text = get(d, 'out/manifest.json');
  assert.ok(!text.includes('Sam'));
  assert.equal(JSON.parse(text).logs.dir, '<home>/EveJS\\_local\\logs');
  assert.match(r.stderr, /paths 1/);
});

test('EvEJSConfig.bat line loses the Windows user', () => {
  const d = tmp();
  put(d, 'in/client-setup/EvEJSConfig.bat', '@echo off\r\nset EVE_DIR=C:\\Users\\Sam\\Games\\EVE\r\n');
  assert.equal(run(path.join(d, 'in'), path.join(d, 'out')).status, 0);
  const text = get(d, 'out/client-setup/EvEJSConfig.bat');
  assert.ok(!text.includes('Sam'));
  assert.equal(text, '@echo off\r\nset EVE_DIR=<home>/Games\\EVE\r\n');
});

test('JSONL: startedBy redacted, line still parses, other lines untouched', () => {
  const line = JSON.stringify({ event: 'closeWatchStarted', startedBy: 'Pilot Alpha', n: 1 });
  const { text, counts } = redactText(`${line}\nnot json Pilot\n`, { jsonl: true });
  const [first, second] = text.split('\n');
  assert.deepEqual(JSON.parse(first), { event: 'closeWatchStarted', startedBy: '<redacted>', n: 1 });
  assert.equal(second, 'not json Pilot');
  assert.equal(counts.fields, 1);
});

test('--field adds keys; nested objects and arrays are covered', () => {
  const t = JSON.stringify({ a: [{ owner: 'x' }], startedBy: 'y' });
  const { text } = redactText(t, { fields: ['owner'] });
  assert.deepEqual(JSON.parse(text), { a: [{ owner: '<redacted>' }], startedBy: '<redacted>' });
});

test('names are numbered by first appearance, consistently across files, longest first', () => {
  const d = tmp();
  put(d, 'in/a.log', 'Pilot Alpha docked; Pilot Alpha Jr left\n');
  put(d, 'in/b.txt', 'Pilot Beta met Pilot Alpha\n');
  const names = path.join(d, 'names.txt');
  fs.writeFileSync(names, '# names\nPilot Alpha\nPilot Alpha Jr\nPilot Beta\n');
  const r = run(path.join(d, 'in'), path.join(d, 'out'), '--names', names);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(get(d, 'out/a.log'), '<character-1> docked; <character-2> left\n');
  assert.equal(get(d, 'out/b.txt'), '<character-3> met <character-1>\n');
  assert.ok(!r.stderr.includes('Pilot'), 'mapping must not be printed');
});

test('hosts become <host-N>', () => {
  const { text, counts } = redactText('connect box.example then other.example, box.example', { hosts: ['box.example', 'other.example'] });
  assert.equal(text, 'connect <host-1> then <host-2>, <host-1>');
  assert.equal(counts.hosts, 3);
});

test('.cpuprofile url keeps valid JSON and loses the home path', () => {
  const d = tmp();
  put(d, 'in/cpu-001.cpuprofile', JSON.stringify({ nodes: [{ callFrame: { url: 'file:///home/sam/evejs/server/src/a.js' } }] }));
  assert.equal(run(path.join(d, 'in'), path.join(d, 'out')).status, 0);
  const text = get(d, 'out/cpu-001.cpuprofile');
  assert.ok(!text.includes('/home/sam'));
  assert.equal(JSON.parse(text).nodes[0].callFrame.url, 'file://<home>/evejs/server/src/a.js');
});

test('macOS and Linux home paths', () => {
  assert.equal(redactText('/Users/sam/x /home/sam/y').text, '<home>/x <home>/y');
});

test('regex metacharacters in a name match literally', () => {
  const { text, counts } = redactText('A.B and AxB', { names: ['A.B'] });
  assert.equal(text, '<character-1> and AxB');
  assert.equal(counts.names, 1);
});

test('in === out exits 64 and writes nothing', () => {
  const d = tmp();
  put(d, 'in/a.txt', '/home/sam/x');
  assert.equal(run(path.join(d, 'in'), path.join(d, 'in')).status, 64);
  assert.equal(get(d, 'in/a.txt'), '/home/sam/x');
});

test('usage errors exit 64', () => {
  assert.equal(run().status, 64);
  assert.equal(run('a', 'b', '--bogus').status, 64);
});

test('text is decided by content: an unknown extension is redacted; a binary refuses unless allowed', () => {
  const d = tmp();
  put(d, 'in/n/report.node', '/home/sam/x');
  const ok = run(path.join(d, 'in'), path.join(d, 'out'));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(get(d, 'out/n/report.node'), '<home>/x');
  fs.writeFileSync(path.join(d, 'in', 'n', 'blob.bin'), Buffer.from([0, 1, 2, 0, 255]));
  const bad = run(path.join(d, 'in'), path.join(d, 'out2'));
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /refusing: binary file can't be redacted: n\/blob\.bin/);
  assert.ok(!fs.existsSync(path.join(d, 'out2')), 'nothing written on refusal');
  const allowed = run(path.join(d, 'in'), path.join(d, 'out3'), '--allow-binary', 'blob.bin');
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stderr, /not redacted: review by hand: n\/blob\.bin/);
  assert.ok(fs.readFileSync(path.join(d, 'out3', 'n', 'blob.bin')).equals(Buffer.from([0, 1, 2, 0, 255])));
});

test('single-file input writes a single file', () => {
  const d = tmp();
  put(d, 'in.txt', '/home/sam/x');
  assert.equal(run(path.join(d, 'in.txt'), path.join(d, 'out.txt')).status, 0);
  assert.equal(get(d, 'out.txt'), '<home>/x');
});

// ---- fix round 1 ----
const SKILL = path.join(__dirname, '..', 'skills', 'upstream-report', 'scripts');
const scan = (...a) => spawnSync(process.execPath, [path.join(SKILL, 'leak-scan.js'), ...a, '--no-identity'], { encoding: 'utf8', env: isolated() });

test('server-health.log: JSON lines by content, numeric startedBy replaced', () => {
  const d = tmp();
  const l1 = JSON.stringify({ time: 't', event: 'closeWatchStarted', startedBy: 90000001 });
  put(d, 'in/server-logs/server-health.log', `${l1}\n\n${JSON.stringify({ time: 't2', startedBy: 'Pilot A' })}\r\n`);
  assert.equal(run(path.join(d, 'in'), path.join(d, 'out')).status, 0);
  const lines = get(d, 'out/server-logs/server-health.log').split('\n').filter((l) => l.trim());
  assert.equal(JSON.parse(lines[0]).startedBy, '<redacted>');
  assert.equal(JSON.parse(lines[1]).startedBy, '<redacted>');
});

test('CLI JSONL file redacts startedBy', () => {
  const d = tmp();
  put(d, 'in/events.jsonl', JSON.stringify({ startedBy: 'Pilot A' }) + '\n');
  assert.equal(run(path.join(d, 'in'), path.join(d, 'out')).status, 0);
  assert.equal(JSON.parse(get(d, 'out/events.jsonl')).startedBy, '<redacted>');
});

test('home paths: spaced user, no trailing separator, multi-escaped', () => {
  const cases = [
    ['C:\\Users\\Sam Lee\\EveJS\\x', '<home>/EveJS\\x'],
    ['set USERPROFILE=C:\\Users\\Sam\r\n', 'set USERPROFILE=<home>\r\n'],
    ['{"cwd":"/home/sam"}', '{"cwd":"<home>"}'],
    ['C:\\\\\\\\Users\\\\\\\\Sam\\\\\\\\x', '<home>/x'],
    ['"/Users/sam"', '"<home>"'],
  ];
  for (const [i, o] of cases) assert.equal(redactText(i).text, o, i);
});

test('leak-scan and redact agree on home-path forms', () => {
  for (const t of ['C:\\Users\\Sam Lee\\EveJS\\x', 'set USERPROFILE=C:\\Users\\Sam', '"cwd":"/home/sam"', 'C:\\\\\\\\Users\\\\\\\\Sam']) {
    const d = tmp();
    put(d, 'f.txt', t + '\n');
    assert.equal(scan(path.join(d, 'f.txt')).status, 2, t);
    assert.equal(redactText(t).counts.paths, 1, t);
  }
});

test('UTF-8 BOM does not defeat field redaction and is kept', () => {
  const d = tmp();
  put(d, 'in/launcher.json', '\uFEFF' + JSON.stringify({ startedBy: 'Pilot A', ok: 1 }));
  assert.equal(run(path.join(d, 'in'), path.join(d, 'out')).status, 0);
  const text = get(d, 'out/launcher.json');
  assert.equal(text.charCodeAt(0), 0xfeff);
  assert.equal(JSON.parse(text.slice(1)).startedBy, '<redacted>');
});

test('non-UTF-8 bytes pass through unchanged with a warning', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'in'));
  const buf = Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from(' /home/sam/x\n')]);
  fs.writeFileSync(path.join(d, 'in', 'a.log'), buf);
  const r = run(path.join(d, 'in'), path.join(d, 'out'));
  assert.equal(r.status, 0);
  assert.match(r.stderr, /not valid UTF-8/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'out', 'a.log')), Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from(' <home>/x\n')]));
});

test('names that look like placeholders do not rewrite them', () => {
  const { text } = redactText('/home/sam/x see Pilot A, home and character', { names: ['Pilot A', 'home', 'character'], hosts: ['redacted'] });
  assert.equal(text, '<home>/x see <character-1>, <character-2> and <character-3>');
});

test('exit 2 on symlinks lists every refusal and writes nothing', (t) => {
  const d = tmp();
  put(d, 'in/ok.txt', 'x');
  try {
    fs.symlinkSync(path.join(d, 'in', 'ok.txt'), path.join(d, 'in', 'l1'));
    fs.symlinkSync(path.join(d, 'in', 'ok.txt'), path.join(d, 'in', 'l2'));
  } catch (e) { return t.skip('symlinks unavailable'); }
  const r = run(path.join(d, 'in'), path.join(d, 'out'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /l1/);
  assert.match(r.stderr, /l2/);
  assert.equal(fs.existsSync(path.join(d, 'out')), false);
});

test('in/out containment resolves symlinks', (t) => {
  const d = tmp();
  put(d, 'in/a.txt', 'x');
  try { fs.symlinkSync(path.join(d, 'in'), path.join(d, 'link'), 'dir'); } catch (e) { return t.skip('symlinks unavailable'); }
  assert.equal(run(path.join(d, 'in'), path.join(d, 'link')).status, 64);
  assert.equal(run(path.join(d, 'in'), path.join(d, 'link', 'sub')).status, 64);
});

test('--terms file character names are redacted; default terms file is read; no mapping printed', () => {
  const d = tmp();
  put(d, 'in/a.log', 'Pilot A and Pilot B and Other\n');
  put(d, 'terms', 'Other\n[character-names]\nPilot A\n');
  const r = run(path.join(d, 'in'), path.join(d, 'out'), '--terms', path.join(d, 'terms'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(get(d, 'out/a.log'), '<character-1> and Pilot B and Other\n');
  const cfg = tmp();
  put(cfg, 'leak-terms', '[character-names]\nPilot B\n');
  const r2 = spawnSync(process.execPath, [CLI, path.join(d, 'in'), path.join(d, 'out2')], { encoding: 'utf8', env: isolated(cfg) });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(get(d, 'out2/a.log'), 'Pilot A and <character-1> and Other\n');
  assert.ok(!r2.stderr.includes('Pilot'));
  assert.equal(run(path.join(d, 'in'), path.join(d, 'out3'), '--terms', path.join(d, 'missing')).status, 64);
});

// ---- fix round 2 ----
test('one-line CRLF JSON keeps its CRLF; pretty CRLF JSON too', () => {
  assert.equal(redactText('{"startedBy":1}\r\n').text, '{"startedBy":"<redacted>"}\r\n');
  assert.equal(redactText('{\r\n  "startedBy": 1\r\n}\r\n').text, '{\r\n  "startedBy": "<redacted>"\r\n}\r\n');
});

test('non-UTF-8 warning wording and non-ASCII names match as latin1 bytes', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'in'));
  const name = 'Zo\u00eb';
  fs.writeFileSync(path.join(d, 'in', 'a.log'), Buffer.concat([Buffer.from([0xe9, 0x20]), Buffer.from(name + ' and '), Buffer.from([0xff, 0x20, 0x5a, 0x6f, 0xeb, 0x0a])]));
  put(d, 'names', name + '\n');
  const r = run(path.join(d, 'in'), path.join(d, 'out'), '--names', path.join(d, 'names'));
  assert.match(r.stderr, /not valid UTF-8: redacted as latin1, other bytes unchanged/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'out', 'a.log')), Buffer.concat([Buffer.from([0xe9, 0x20]), Buffer.from('<character-1> and '), Buffer.from([0xff, 0x20]), Buffer.from('<character-1>\n')]));
});

test('truncated health log: partial first line still loses startedBy', () => {
  const t = '[ErrorReport] Truncated: first 100 bytes omitted\n...e":"x","startedBy":90000001,"n":2}\n{"startedBy":"Pilot A"}\n...{"startedBy":"Pi';
  const { text, counts } = redactText(t);
  assert.ok(!text.includes('90000001') && !text.includes('Pilot A') && !text.includes('"Pi'), text);
  assert.equal(counts.fields, 3);
  assert.match(text, /"n":2\}/);
});

test('home path before an escaped quote keeps JSON valid', () => {
  const src = JSON.stringify({ a: '"C:\\Users\\Sam" x', b: 'C:\\Users\\Sam\\' });
  const out = redactText(src).text;
  assert.ok(!out.includes('Sam'));
  assert.doesNotThrow(() => JSON.parse(out));
});

test('spaced macOS user', () => {
  assert.equal(redactText('/Users/Sam Lee/x').text, '<home>/x');
  assert.equal(redactText('/Users/sam/x and /other/y').text, '<home>/x and /other/y');
});

test('a failed run leaves no partial out', (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('permissions');
  const d = tmp();
  put(d, 'in/a.txt', 'x');
  put(d, 'in/z/b.txt', 'y');
  fs.chmodSync(path.join(d, 'in', 'z', 'b.txt'), 0o000);
  const r = run(path.join(d, 'in'), path.join(d, 'out'));
  fs.chmodSync(path.join(d, 'in', 'z', 'b.txt'), 0o644);
  assert.equal(r.status, 2);
  assert.deepEqual(fs.readdirSync(d).sort(), ['in']);
});

test('/users/123 in a URL path is not a home path, in redact and leak-scan', () => {
  const t = 'GET /users/123 HTTP/1.1';
  assert.equal(redactText(t).text, t);
  const d = tmp();
  put(d, 'f.txt', t + '\n');
  assert.equal(scan(path.join(d, 'f.txt')).status, 0);
  assert.equal(redactText('C:\\users\\sam\\x').text, '<home>/x');
});

// ---- fix round 3 ----
test('loose pass: already-redacted values are not recounted', () => {
  const t = '[ErrorReport] Truncated: x\n..."startedBy":"<redacted>","n":2}\n';
  const { text, counts } = redactText(t);
  assert.equal(text, t);
  assert.equal(counts.fields, 0);
});

test('loose pass leaves prose alone', () => {
  const t = 'Set "startedBy": true in config, then restart';
  assert.deepEqual(redactText(t), { text: t, counts: { names: 0, hosts: 0, paths: 0, fields: 0, ips: 0 } });
});

test('loose pass redacts a whole object or array value, to end of line if cut', () => {
  const a = redactText('...,"x":1,"startedBy":{"id":1,"n":"Sam"},"y":2}').text;
  assert.equal(a, '...,"x":1,"startedBy":"<redacted>","y":2}');
  const b = redactText('...,"x":1,"startedBy":{"id":1,"n":"Sa').text;
  assert.equal(b, '...,"x":1,"startedBy":"<redacted>"');
  assert.equal(redactText('...,"x":1,"startedBy":[1,{"a":"]"}],"y":2}').text, '...,"x":1,"startedBy":"<redacted>","y":2}');
});

test('loose pass redacts a field inside an escaped JSON string', () => {
  const src = JSON.stringify({ msg: '{"startedBy":5,"k":1}' });
  const { text, counts } = redactText(src + '\nplain');
  assert.equal(counts.fields, 1);
  assert.ok(!text.includes('5,'));
  assert.equal(JSON.parse(text.split('\n')[0]).msg, '{"startedBy":"<redacted>","k":1}');
});

// ---- fix round 4 ----
test('cut values inside an escaped JSON string keep the JSON valid', () => {
  const cases = [
    JSON.stringify({ m: '{"startedBy":9000' }),
    JSON.stringify({ lastErrors: ['server-health.log: {"startedBy":9000'], k: 1 }),
    JSON.stringify({ lastErrors: ['x {"startedBy":"Pilot A'], k: 1 }),
    JSON.stringify({ lastErrors: ['x {"startedBy":{"id":1,"n":"Sa'], k: 1 }),
    JSON.stringify({ lastErrors: ['x {"startedBy":{"id":1,"n":"Sam"},"z":2}'], k: 1 }),
  ];
  for (const src of cases) {
    const { text, counts } = redactText(src + '\nplain');
    const first = text.split('\n')[0];
    assert.doesNotThrow(() => JSON.parse(first), first);
    assert.equal(JSON.parse(first).k ?? 1, 1);
    assert.ok(/<redacted>/.test(first) && !/9000|Pilot|"Sa|Sam/.test(first), first);
    assert.equal(counts.fields, 1, first);
  }
});

test('a single cut fragment with no "{" is left alone unless it follows a Truncated marker (documented gate)', () => {
  assert.equal(redactText('..."startedBy":"Pilot A').text, '..."startedBy":"Pilot A');
  assert.equal(redactText('[ErrorReport] Truncated: x\n..."startedBy":"Pilot A').text, '[ErrorReport] Truncated: x\n..."startedBy":"<redacted>"');
});

// ---- fix round 5 ----
test('enclosing-quote check counts the backslash run: values/objects ending in a backslash stay valid JSON', () => {
  const cases = [
    JSON.stringify({ m: '{"startedBy":"Pilot A\\', k: 1 }),
    JSON.stringify({ m: '{"startedBy":{"id":1,"n":"x\\', k: 1 }),
  ];
  for (const src of cases) {
    const { text, counts } = redactText(src + '\nplain');
    const first = text.split('\n')[0];
    assert.doesNotThrow(() => JSON.parse(first), first);
    assert.equal(JSON.parse(first).k, 1);
    assert.ok(/<redacted>/.test(first) && !/Pilot|"x/.test(first), first);
    assert.equal(counts.fields, 1, first);
  }
});

test('an escaped quote inside an escaped string value does not end the value early', () => {
  const src = JSON.stringify({ m: '{"startedBy":"Pi\\"lot A","z":2}', k: 1 });
  const { text, counts } = redactText(src + '\nplain');
  const first = text.split('\n')[0];
  assert.doesNotThrow(() => JSON.parse(first), first);
  assert.equal(JSON.parse(first).m, '{"startedBy":"<redacted>","z":2}');
  assert.ok(!/lot A/.test(first), first);
  assert.equal(counts.fields, 1);
});

test('account logins in session lines are redacted structurally, numbered per bundle', () => {
  const t = '[Session 1.2.3.4:5 user=acct_zq(1001) char=Pilot A(9001)] ok\n[Login] dup: closing user=acct_zq(1001) client=3\nuser=other_one(1002) user=ACCT_ZQ(1001)\nuser=undefined(undefined) user=?\n';
  const { text, counts } = redactText(t, { names: ['Pilot A'] });
  assert.equal(text,
    '[Session <ip-1>:5 user=<account-1>(1001) char=<character-1>(9001)] ok\n[Login] dup: closing user=<account-1>(1001) client=3\nuser=<account-2>(1002) user=<account-1>(1001)\nuser=undefined(undefined) user=?\n');
  assert.equal(counts.names, 5);
  assert.equal(redactText(text).text, text);
});

test('account logins are numbered consistently across files in a tree', () => {
  const d = tmp();
  put(d, 'in/a.log', 'user=acct_zq(1001)\n');
  put(d, 'in/b.log', 'user=other(1002) user=acct_zq(1001)\n');
  const r = run(path.join(d, 'in'), path.join(d, 'out'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(get(d, 'out/a.log'), 'user=<account-1>(1001)\n');
  assert.equal(get(d, 'out/b.log'), 'user=<account-2>(1002) user=<account-1>(1001)\n');
});

// ---- fix round 6 ----
test('other upstream login forms are redacted structurally, sharing the account numbering', () => {
  const t = [
    '[Session s user=acct_zq(1001) char=x(1)] ok',
    '[CharService] Login takeover for X(5); evicting prior session user=acct_zq client=3',
    '[CharService] Rejected duplicate login; already active on user=other_one client=0',
    '[CharService] evicting user=unknown client=0',
    '[HANDSHAKE] Login attempt: user="acct_zq" lang="en"',
    '[HANDSHAKE] Account "other_one" not found',
    '[HANDSHAKE] Login attempt failed for "acct_zq": account not found',
    '[HANDSHAKE] Sent CryptoServerHandshake for user "Third.One"',
    '',
  ].join('\n');
  const { text, counts } = redactText(t);
  assert.equal(text, [
    '[Session s user=<account-1>(1001) char=x(1)] ok',
    '[CharService] Login takeover for X(5); evicting prior session user=<account-1> client=3',
    '[CharService] Rejected duplicate login; already active on user=<account-2> client=0',
    '[CharService] evicting user=unknown client=0',
    '[HANDSHAKE] Login attempt: user="<account-1>" lang="en"',
    '[HANDSHAKE] Account "<account-2>" not found',
    '[HANDSHAKE] Login attempt failed for "<account-1>": account not found',
    '[HANDSHAKE] Sent CryptoServerHandshake for user "<account-3>"',
    '',
  ].join('\n'));
  assert.equal(counts.names, 7);
  assert.equal(redactText(text).text, text);
});

// ---- final-review fixes: IP addresses, names by shape, content-based text detection ----
const SESSION = '[Session 8.8.4.4:51234 user=acct_zq(1001) char=New Guy(90000002)] hello\n';

test('IPv4 and IPv6 addresses become <ip-N>, numbered per bundle; loopback, unspecified, documentation stay', () => {
  const t = [
    SESSION.trim(),
    'tcp connect 10.1.2.3:443 then 100.64.9.9 and 8.8.4.4 again',
    'from fd7a:115c:a1e0::1234 and fe80::1%eth0 and [2606:4700::1111]:8080 and ::ffff:192.168.1.5',
    'ok 127.0.0.1 ::1 0.0.0.0 :: 203.0.113.9 198.51.100.7 192.0.2.1 2001:db8::5 255.255.255.0',
  ].join('\n');
  const { text, counts } = redactText(t);
  assert.match(text, /\[Session <ip-1>:51234 /);
  assert.match(text, /tcp connect <ip-2>:443 then <ip-3> and <ip-1> again/);
  assert.match(text, /from <ip-4> and <ip-5>%eth0 and \[<ip-6>\]:8080 and <ip-7>/);
  assert.match(text, /ok 127\.0\.0\.1 ::1 0\.0\.0\.0 :: 203\.0\.113\.9 198\.51\.100\.7 192\.0\.2\.1 2001:db8::5 255\.255\.255\.0$/);
  assert.equal(counts.ips, 8);
  assert.equal(redactText(text).text, text, 'idempotent');
});

test('an IP that sits in a timestamp-like or word-like token is left alone', () => {
  const t = 'at 12:34:56 version 1.2.3 node 22.1.0 a::b dead::beef 1.2.3.4.5\n';
  assert.equal(redactText(t).text, t);
});

test('character names are redacted by log shape even when no terms file lists them', () => {
  const t = SESSION +
    '[CharService] Created character "Other Pilot" with ID 90000003\n' +
    '[CharService] CreateCharacterWithDoll: name="Fourth Guy" race=1\n' +
    '[CharState] Applied Third One(90000004) ship=1\n' +
    '[Session 10.0.0.9:1 user=undefined(undefined) char=undefined(undefined)] x\n' +
    '[OwnerGroupManager] Create char=9001 name="Some Access Group"\n';
  const { text, counts } = redactText(t, {});
  assert.match(text, /char=<character-1>\(90000002\)/);
  assert.match(text, /Created character "<character-2>" with ID/);
  assert.match(text, /name="<character-3>" race=1/);
  assert.match(text, /Applied <character-4>\(90000004\) ship=1/);
  assert.match(text, /char=undefined\(undefined\)/);
  assert.match(text, /char=9001 name="Some Access Group"/);
  assert.ok(!/New Guy|Other Pilot|Fourth Guy|Third One/.test(text));
  assert.equal(counts.names, 5); // four names and one account login
  assert.equal(redactText(text).text, text, 'idempotent');
});

test('a name found by shape is redacted everywhere in the tree, with one number, and reported', () => {
  const d = tmp();
  put(d, 'in/a.log', SESSION);
  put(d, 'in/b/notes.txt', 'New Guy docked; new guy undocked\n');
  const r = run(path.join(d, 'in'), path.join(d, 'out'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(get(d, 'out/a.log'), /char=<character-1>\(90000002\)/);
  assert.equal(get(d, 'out/b/notes.txt'), '<character-1> docked; <character-1> undocked\n');
  assert.match(r.stderr, /1 character name\(s\) found in the logs were not in your terms/);
  assert.doesNotMatch(r.stderr, /New Guy/);
});

test('UTF-16 (BOM) text is decoded, redacted and written back as UTF-16 with its BOM', () => {
  const d = tmp();
  const body = 'C:\\Users\\Sam\\x and 8.8.4.4 and Zephyra Quill\r\n';
  fs.mkdirSync(path.join(d, 'in'));
  fs.writeFileSync(path.join(d, 'in', 'u16.log'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]));
  const be = Buffer.from(body, 'utf16le');
  for (let i = 0; i < be.length; i += 2) { const x = be[i]; be[i] = be[i + 1]; be[i + 1] = x; }
  fs.writeFileSync(path.join(d, 'in', 'u16be.txt'), Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
  fs.writeFileSync(path.join(d, 'names'), 'Zephyra Quill\n');
  const r = run(path.join(d, 'in'), path.join(d, 'out'), '--names', path.join(d, 'names'));
  assert.equal(r.status, 0, r.stderr);
  const out = fs.readFileSync(path.join(d, 'out', 'u16.log'));
  assert.deepEqual([...out.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(out.subarray(2).toString('utf16le'), '<home>/x and <ip-1> and <character-1>\r\n');
  const outBe = fs.readFileSync(path.join(d, 'out', 'u16be.txt'));
  assert.deepEqual([...outBe.subarray(0, 2)], [0xfe, 0xff]);
});

test('file names are redacted too (names and hosts)', () => {
  const d = tmp();
  put(d, 'in/Zephyra Quill/server.log.old', 'x\n');
  fs.writeFileSync(path.join(d, 'names'), 'Zephyra Quill\n');
  const r = run(path.join(d, 'in'), path.join(d, 'out'), '--names', path.join(d, 'names'));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(d, 'out', 'character-1', 'server.log.old')));
});

test('a Node fatal-error report loses its environmentVariables', () => {
  const t = JSON.stringify({ header: { host: 'x' }, environmentVariables: { USERNAME: 'Sam', PATH: '/bin' } }, null, 2);
  const { text } = redactText(t);
  assert.ok(!text.includes('Sam'));
  assert.equal(JSON.parse(text).environmentVariables, '<redacted>');
});

test('/root home path: redacted where it is a home, left alone as a path segment', () => {
  assert.equal(redactText('/root/x "/root/y" a=/root/z (/root/w)').text, '<home>/x "<home>/y" a=<home>/z (<home>/w)');
  const same = 'at /app/src/root/index.js GET /api/root/list /proc/1/root/etc/hosts';
  assert.equal(redactText(same).text, same);
});
