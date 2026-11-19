'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scanTexts, collectTexts } = require('../skills/upstream-report/scripts/leak-scan.js');
const { writeZip } = require('../skills/upstream-report/scripts/lib/zip.js');

const CLI = path.join(__dirname, '..', 'skills', 'upstream-report', 'scripts', 'leak-scan.js');
const tmp = () => require('./fixtures/tmp.js').mk('leak-test-');
const CONFIG = tmp(); // never the real config dir; no terms file inside
const run = (...args) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, EVEJS_CONTRIB_CONFIG_DIR: CONFIG } });
const runNoId = (...args) => run(...args, '--no-identity');
const labels = (text, opts) => scanTexts([{ name: 'f', text }], opts).map((h) => h.term);

test('generic labels hit', () => {
  assert.deepEqual(labels('see /home/sam/x'), ['home-path']);
  assert.deepEqual(labels('see /Users/sam/x'), ['home-path']);
  assert.deepEqual(labels('see C:\\Users\\Sam\\x'), ['home-path']);
  assert.deepEqual(labels('file:///home/sam/x'), ['home-path']);
  assert.deepEqual(labels('"C:\\\\Users\\\\Sam\\\\x"'), ['home-path']);
  assert.deepEqual(labels('ip 192.168.1.4'), ['private-ip']);
  assert.deepEqual(labels('ip 10.0.0.1'), ['private-ip']);
  assert.deepEqual(labels('ip 172.20.1.1'), ['private-ip']);
  assert.deepEqual(labels('ip 100.101.1.2'), ['private-ip']);
  assert.deepEqual(labels('host box.lan'), ['lan-host']);
  assert.deepEqual(labels('host a.b.internal'), ['lan-host']);
  assert.deepEqual(labels('mail a@b.org'), ['email']);
});

test('near misses do not hit', () => {
  for (const t of ['100.5', 'upstream.lang', 'version 261115.2', 'example.com', '1.192.168.1.4', '/home/', '127.0.0.1', '::1', '0.0.0.0', '::', '203.0.113.9', '2001:db8::1', '255.255.255.0']) {
    assert.deepEqual(labels(t), [], t);
  }
});

test('hit shape has name, term and 1-based line', () => {
  const hits = scanTexts([{ name: 'n.txt', text: 'ok\nbox.lan\n' }]);
  assert.deepEqual(hits, [{ name: 'n.txt', term: 'lan-host', line: 2 }]);
});

test('custom terms match case-insensitively on word boundaries', () => {
  const opts = { terms: ['Pilot Alpha'] };
  assert.deepEqual(labels('x pilot alpha y', opts), ['Pilot Alpha']);
  assert.deepEqual(labels('Pilot Alphanumeric', opts), []);
});

test('allow suppresses only the named label', () => {
  const text = 'a@b.org and box.lan';
  assert.deepEqual(labels(text, { allow: ['email'] }), ['lan-host']);
});

test('collectTexts walks dirs and zips, skips binary files', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 'bin'), Buffer.from([1, 0, 2]));
  writeZip([{ name: 'in/z.txt', data: Buffer.from('zipped') }, { name: 'in/', data: Buffer.alloc(0) }, { name: 'b.bin', data: Buffer.from([0, 1]) }], path.join(dir, 'p.zip'));
  const texts = collectTexts([dir]);
  const byText = texts.map((t) => t.text).sort();
  assert.deepEqual(byText, ['hello', 'zipped']);
});

test('CLI: clean exits 0, hit exits 2 with a refusing line, usage exits 64', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'nothing here');
  assert.equal(runNoId(dir).status, 0);
  fs.writeFileSync(path.join(dir, 'bad.txt'), 'x\nhost box.lan\n');
  const r = runNoId(dir);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^refusing: .*bad\.txt:2: lan-host$/m);
  assert.equal(run().status, 64);
  assert.equal(run(dir, '--bogus').status, 64);
  assert.equal(run(dir, '--terms').status, 64);
  assert.equal(run(dir, '--terms', path.join(dir, 'nope')).status, 64);
});

test('CLI: --terms file and --allow', () => {
  const dir = tmp();
  const scan = path.join(dir, 'scan');
  fs.mkdirSync(scan);
  fs.writeFileSync(path.join(scan, 'a.txt'), 'pilot alpha\nPilot Alphanumeric\nmail a@b.org\n');
  const terms = path.join(dir, 'terms.txt');
  fs.writeFileSync(terms, '# comment\n\nPilot Alpha\n');
  const r = runNoId(scan, '--terms', terms);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /a\.txt:1: Pilot Alpha/);
  assert.doesNotMatch(r.stdout, /a\.txt:2:/);
  assert.match(r.stdout, /a\.txt:3: email/);
  const r2 = runNoId(scan, '--terms', terms, '--allow', 'email');
  assert.doesNotMatch(r2.stdout, /email/);
  assert.match(r2.stdout, /Pilot Alpha/);
});

test('CLI: a planted term inside a zip is found', () => {
  const dir = tmp();
  writeZip([{ name: 'x/notes.txt', data: Buffer.from('line\nmeet pilot alpha\n') }], path.join(dir, 'b.zip'));
  const terms = path.join(dir, 't.txt');
  fs.writeFileSync(terms, 'Pilot Alpha\n');
  const r = runNoId(path.join(dir, 'b.zip'), '--terms', terms);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /x\/notes\.txt:2: Pilot Alpha/);
});

test('CLI: a symlink in a scanned dir is refused', (t) => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'real.txt'), 'x');
  try { fs.symlinkSync(path.join(dir, 'real.txt'), path.join(dir, 'link.txt')); } catch (e) { return t.skip('symlinks unavailable'); }
  const r = runNoId(dir);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /refusing: .*link\.txt/);
});

test('lan-host: hosts hit, ordinary code does not', () => {
  for (const t of ['box.lan', 'nas.local', 'host.internal', 'router.home.arpa', 'http://box.local:8080', 'ssh me@nas.local']) {
    assert.deepEqual(labels(t).filter((l) => l === 'lan-host'), ['lan-host'], t);
  }
  for (const t of ['config.local.json', 'settings.local.json', 'this.internal', 'cfg.local;', "require('./chat.local')", 'data/market-seed.local', 'x.internal(1)']) {
    assert.deepEqual(labels(t), [], t);
  }
});

test('email needs a letter-only TLD', () => {
  for (const t of ['evejs@261115.2', 'node@22.1.0', 'pkg@1.2.3']) assert.deepEqual(labels(t), [], t);
  assert.deepEqual(labels('mail sam@mail.org.'), ['email']);
});

test('home path without a trailing separator', () => {
  assert.deepEqual(labels('cwd: /home/sam'), ['home-path']);
  assert.deepEqual(labels('"/Users/sam"'), ['home-path']);
  assert.deepEqual(labels('cwd: C:\\Users\\sam'), ['home-path']);
  assert.deepEqual(labels('"C:\\\\Users\\\\Sam\\\\x"'), ['home-path']);
});

test('secrets: keys with values and long key-like strings; hashes pass', () => {
  assert.deepEqual(labels('token=abc123def456'), ['secret']);
  assert.deepEqual(labels('{"api_key": "Zx81fQpLm"}'), ['secret']);
  assert.deepEqual(labels('PASSWORD: hunter2hunter'), ['secret']);
  assert.deepEqual(labels('k ' + 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hJ'), ['secret']);
  const sha = 'a'.repeat(8) + '0123456789abcdef'.repeat(3) + '12345678';
  assert.deepEqual(labels(`${sha}  files/x.js`), []);
  assert.deepEqual(labels('commit 0123456789abcdef0123456789abcdef01234567'), []);
  assert.deepEqual(labels('the token: is optional'), []);
  const profile = JSON.stringify({ nodes: [{ id: 1, callFrame: { functionName: 'tick', url: 'file:///srv/app/server/tick.js', lineNumber: 10 }, hitCount: 5 }], samples: Array(50).fill(1), timeDeltas: Array(50).fill(1000) });
  assert.deepEqual(labels(profile), []);
});

test('identity: injected terms hit; the Signed line is exempt from them only', () => {
  const id = { identity: ['samwise'] };
  assert.deepEqual(labels('hello Samwise', id), ['identity']);
  assert.deepEqual(labels('Signed: samwise', id), []);
  assert.deepEqual(labels('Signed: samwise a@b.org', id), ['email', 'identity']);
  assert.deepEqual(labels('Signed: Samwise and also samwise elsewhere', id), ['identity'], 'exempt only when the text is exactly one identity term');
  assert.deepEqual(labels('xSigned: samwise', id), ['identity']);
});

test('identityTerms: built from injected sources, skips short and empty values', () => {
  const { identityTerms } = require('../skills/upstream-report/scripts/lib/identity.js');
  const get = (k) => ({ 'user.name': 'Sam Wise', 'user.email': 'sw@mail.example' })[k] || '';
  assert.deepEqual(identityTerms({ get, username: 'samw', hostname: 'ab' }), ['Sam Wise', 'sw@mail.example', 'samw']);
  assert.deepEqual(identityTerms({ get: () => '', username: '', hostname: '' }), []);
});

test('terms: regex terms and character names carry their labels', () => {
  const { parseTerms } = require('../skills/upstream-report/scripts/lib/terms.js');
  const { terms, names } = parseTerms('\uFEFF# c\r\nAcme Hosting\r\n/proj-[a-z]+-int/\r\n[character-names]\r\nPilot Alpha\r\n[terms]\r\nExampleCorp\r\n');
  const hits = scanTexts([{ name: 'f', text: 'acme hosting\nproj-abc-int\nPilot Alpha\nexamplecorp' }], { terms, names });
  assert.deepEqual(hits.map((h) => h.term), ['Acme Hosting', '/proj-[a-z]+-int/', 'character-name', 'ExampleCorp']);
  assert.throws(() => parseTerms('ok\n/(/\n'), /terms file:2: bad regex/);
});

test('CLI: bad regex in --terms exits 64; missing default file prints a hint; summary on stderr', () => {
  const dir = tmp();
  const bad = path.join(dir, 't');
  fs.writeFileSync(bad, 'a\n/(/\n');
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'fine');
  assert.equal(runNoId(dir, '--terms', bad).status, 64);
  const r = runNoId(dir);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /no leak-terms file: run leak-terms init/);
  assert.match(r.stderr, /scanning for 0 private terms \(0 character names\)/);
});

test('CLI: --terms ADDS to the default user file; repeatable; --no-user-terms opts out', () => {
  const cfg = tmp();
  const scan = tmp();
  fs.writeFileSync(path.join(cfg, 'leak-terms'), 'Acme Hosting\n');
  fs.writeFileSync(path.join(scan, 'a.txt'), 'we use acme hosting and ExampleCorp and Zorbco');
  const env = { ...process.env, EVEJS_CONTRIB_CONFIG_DIR: cfg };
  const go = (...a) => spawnSync(process.execPath, [CLI, scan, '--no-identity', ...a], { encoding: 'utf8', env });
  const r = go();
  assert.equal(r.status, 2);
  assert.match(r.stdout, /Acme Hosting/);
  assert.doesNotMatch(r.stdout, /ExampleCorp/);
  const other = path.join(cfg, 'other');
  fs.writeFileSync(other, 'ExampleCorp\n');
  const r2 = go('--terms', other);
  assert.match(r2.stdout, /Acme Hosting/);
  assert.match(r2.stdout, /ExampleCorp/);
  assert.match(r2.stderr, /scanning for 2 private terms/);
  const third = path.join(cfg, 'third');
  fs.writeFileSync(third, 'Zorbco\n');
  const r3 = go('--terms', other, '--terms', third);
  assert.match(r3.stdout, /Acme Hosting/);
  assert.match(r3.stdout, /ExampleCorp/);
  assert.match(r3.stdout, /Zorbco/);
  const r4 = go('--terms', other, '--no-user-terms');
  assert.doesNotMatch(r4.stdout, /Acme/);
  assert.match(r4.stdout, /ExampleCorp/);
  const r5 = go('--no-user-terms');
  assert.equal(r5.status, 0);
  assert.equal(go('--terms', path.join(cfg, 'nope')).status, 64);
});

test('terms: [identity] section parses, and the Signed line is exempt from those terms only', () => {
  const { parseTerms } = require('../skills/upstream-report/scripts/lib/terms.js');
  const { terms, names, identity } = parseTerms('Acme Hosting\n[identity]\nsamwise\n/sam-w/\n[character-names]\nPilot Alpha\n');
  assert.deepEqual(terms, ['Acme Hosting']);
  assert.deepEqual(names, ['Pilot Alpha']);
  assert.equal(identity.length, 2);
  assert.deepEqual(parseTerms('x\n').identity, []);
  assert.deepEqual(labels('Signed: samwise', { identity }), []);
  assert.deepEqual(labels('hello samwise', { identity }), ['identity']);
  // a plain term still hits everywhere, Signed line included
  assert.deepEqual(labels('Signed: samwise', { terms: ['samwise'] }), ['samwise']);
});

test('CLI: identity terms from the terms file get the Signed exemption', () => {
  const cfg = tmp();
  const scan = tmp();
  fs.writeFileSync(path.join(cfg, 'leak-terms'), '[identity]\nsamwise\n');
  fs.writeFileSync(path.join(scan, 'ok.md'), 'Signed: samwise\n');
  const env = { ...process.env, EVEJS_CONTRIB_CONFIG_DIR: cfg };
  const go = () => spawnSync(process.execPath, [CLI, scan, '--no-identity'], { encoding: 'utf8', env });
  assert.equal(go().status, 0);
  fs.writeFileSync(path.join(scan, 'bad.md'), 'by samwise\nSigned: samwise\n');
  const r = go();
  assert.equal(r.status, 2);
  assert.match(r.stdout, /bad\.md:1: identity/);
  assert.doesNotMatch(r.stdout, /ok\.md|bad\.md:2/);
});

test('CLI: binary files are reported on stderr; nested zips are scanned', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'blob'), Buffer.from([1, 0, 2]));
  const inner = path.join(tmp(), 'inner.zip');
  writeZip([{ name: 'deep.txt', data: Buffer.from('box.lan') }], inner);
  writeZip([{ name: 'inner.zip', data: fs.readFileSync(inner) }], path.join(dir, 'outer.zip'));
  const r = runNoId(dir);
  assert.match(r.stderr, /skipped \(binary\): .*blob/);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /outer\.zip\/inner\.zip\/deep\.txt:1: lan-host/);
});

test('CLI: a broken symlink argument exits 2', (t) => {
  const dir = tmp();
  try { fs.symlinkSync(path.join(dir, 'missing'), path.join(dir, 'dangling')); } catch (e) { return t.skip('symlinks unavailable'); }
  assert.equal(runNoId(path.join(dir, 'dangling')).status, 2);
});

test('secret: made-up secrets hit; ordinary code shapes do not', () => {
  for (const t of ['token=ghp_Ab12Cd34Ef56Gh78', 'api_key: "AbC123xyz789"', 'const o = { "secret": "k9Xz81fQpLm2" }', 'PASSWORD=hunter2hunter2']) {
    assert.deepEqual(labels(t), ['secret'], t);
  }
  for (const t of [
    'password: normalizeString(options.password, "")',
    'inviteToken: input.inviteToken,',
    'tokenCount: 123456',
    'const sessionToken = makeToken(32);',
    'token: this.nextToken,',
    'secret = "changeme"',
    'const tokens = []',
    'listT0TranquilWeatherPresentationStages(x)',
    'const k = Particle_Cloud_Sphere_Smoke_RedDark_01a;',
    'function buildDEFAULTABYSSALTIMERDURATIONMSPart1(scope) {',
  ]) assert.deepEqual(labels(t), [], t);
});

test('GET /users/123 is not a home path; /Users/sam still is', () => {
  assert.deepEqual(labels('GET /users/123'), []);
  assert.deepEqual(labels('GET /Users/sam'), ['home-path']);
  assert.deepEqual(labels('C:\\users\\sam\\x'), ['home-path']);
});

test('lan-host: camelCase property chains are not hosts', () => {
  assert.deepEqual(labels('context.visibilityRestrictions.local && x'), []);
  assert.deepEqual(labels('a.b.nas.local'), ['lan-host']);
});

test('email: git remotes are exempt', () => {
  assert.deepEqual(labels('git@github.com:owner/repo.git'), []);
  assert.deepEqual(labels('mail sam@github.com'), ['email']);
});

test('identityTerms skips common words', () => {
  const { identityTerms } = require('../skills/upstream-report/scripts/lib/identity.js');
  assert.deepEqual(identityTerms({ get: () => '', username: 'root', hostname: 'localhost' }), []);
  assert.deepEqual(identityTerms({ get: () => '', username: 'Admin', hostname: 'samsbox' }), ['samsbox']);
});

test('lan-host: real mixed-case hosts hit; only camelCase middle labels are code', () => {
  assert.deepEqual(labels('ssh Sams-MacBook-Pro.local'), ['lan-host']);
  assert.deepEqual(labels('ping MyNAS.local'), ['lan-host']);
  assert.deepEqual(labels('context.visibilityRestrictions.local && x'), []);
});

test('secret: a bare prefixed token hits', () => {
  assert.deepEqual(labels('use ghp_Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78'), ['secret']);
  assert.deepEqual(labels('sk_' + 'Zx81fQpLm2Nv94RtYb07WsKd63HcJe58'), ['secret']);
});

test('secret: identifier and property values with a digit do not hit', () => {
  for (const t of ['token: input.token2,', 'token = sessionId2;', 'password = config.dbPassword1', 'secret: myValue3']) {
    assert.deepEqual(labels(t), [], t);
  }
  assert.deepEqual(labels('PASSWORD=hunter2hunter2'), ['secret']);
});

test('email: only the git@<host>:path remote form is exempt', () => {
  assert.deepEqual(labels('git@github.com:owner/repo.git'), []);
  assert.deepEqual(labels('contact git@company.com please'), ['email']);
  assert.deepEqual(labels('git@company.com'), ['email']);
});

test('secret: dotted values hit unless every segment is identifier-shaped', () => {
  for (const t of ['password=abc.123defgh', 'password=s3cr3t.Pass', 'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw']) {
    assert.deepEqual(labels(t), ['secret'], t);
  }
  for (const t of ['token: input.token2,', 'password = config.dbPassword1', 'token = sessionId2.']) assert.deepEqual(labels(t), [], t);
});

test('email: ssh:// git remotes are exempt too', () => {
  assert.deepEqual(labels('ssh://git@github.com/owner/repo.git'), []);
  assert.deepEqual(labels('git+ssh://git@github.com/owner/repo.git'), []);
  assert.deepEqual(labels('ssh://git@host.example:22/owner/repo.git'), []);
  assert.deepEqual(labels('mailto:git@company.com'), ['email']);
});

test('secret: github_pat_ tokens hit', () => {
  const a = 'aB3dE6gH9jK2mN5pQ8sT1vW';
  const b = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cFhJ' + 'xY2zA5bC8dE1fG4hI7jK0lM3nO6';
  assert.deepEqual(labels(`github_pat_${a.slice(0, 22)}_${b.slice(0, 59)}`), ['secret']);
  assert.deepEqual(labels('x github_pat_' + 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cFhJx'), ['secret']);
});

// ---- fix round 5 ----
test('secret: github_pat_ tokens hit regardless of entropy shape (long lowercase / capital runs)', () => {
  const tails = [
    'abcdefghijklmnopqrstuv_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstu',
    'a1b2c3d4e5f6g7h8i9j0kl_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
    'AAAAAAAAAAAAAAAAAAAAAA_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  ];
  for (const t of tails) assert.deepEqual(labels('x github_pat_' + t), ['secret'], t);
  assert.deepEqual(labels('github_pat_short'), []);
});

test('secret: dotted property chains with inner digits are code; leet-style dotted values still hit', () => {
  for (const t of ['token: tokens.v2Token', 'secret: process.env.SECRET_2X', 'password = cfg.sha256Hex']) assert.deepEqual(labels(t), [], t);
  for (const t of ['password=abc.123defgh', 'password=s3cr3t.Pass', 'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw']) assert.deepEqual(labels(t), ['secret'], t);
});

test('account-login: an un-redacted user=<login>(<digits>) session login hits; placeholders and non-logins do not', () => {
  assert.deepEqual(labels('[Session 1.2.3.4:5 user=acct_zq(1001) char=<character-1>(9001)] ok').filter((l) => !['private-ip', 'ip-address'].includes(l)), ['account-login']);
  assert.deepEqual(labels('[Login] dup: closing user=acct_zq(1001) client=3'), ['account-login']);
  assert.deepEqual(labels('[Session s user=<account-1>(1001) char=<character-1>(9001)] ok'), []);
  assert.deepEqual(labels('user=undefined(undefined) user=? user=1001 char=5'), []);
});

// ---- fix round 6 ----
test('secret: dotted leetspeak values hit unless the chain starts at a known code root', () => {
  for (const t of ['password=Pa55word.Summer', 'password=Summer.Pa55word', 'token=Pa55word.x']) assert.deepEqual(labels(t), ['secret'], t);
  for (const t of ['apiKey = config.keys.k8sToken2', 'secret: process.env.SECRET_2X', 'token: this.sess1on.t0ken', 'key = opts.p4ss.w0rd']) assert.deepEqual(labels(t), [], t);
});

test('account-login: user=<login> client=<n> and handshake login forms hit; placeholders do not', () => {
  assert.deepEqual(labels('[CharService] Login takeover for X(5); evicting prior session user=acct_zq client=3'), ['account-login']);
  assert.deepEqual(labels('[HANDSHAKE] Login attempt: user="acct_zq" lang="en"'), ['account-login']);
  assert.deepEqual(labels('[HANDSHAKE] Account "acct_zq" not found'), ['account-login']);
  assert.deepEqual(labels('[HANDSHAKE] Password mismatch for "acct_zq"'), ['account-login']);
  assert.deepEqual(labels('[HANDSHAKE] Sent CryptoServerHandshake for user "acct_zq"'), ['account-login']);
  assert.deepEqual(labels('[HANDSHAKE] Account "<account-1>" not found user=<account-1> client=3 user=unknown client=0'), []);
});

test('own repository slug is exempt from identity terms only', () => {
  const opts = { identity: ['flurbo'], selfRefs: ['flurbo/evejs-contrib'] };
  assert.deepEqual(labels('claude plugin marketplace add flurbo/evejs-contrib', opts), []);
  assert.deepEqual(labels('see https://github.com/Flurbo/evejs-contrib.', opts), []);
  assert.deepEqual(labels('flurbo/evejs-contrib and also flurbo wrote it', opts), ['identity']);
  assert.deepEqual(labels('other-flurbo/evejs-contrib', opts), ['identity']);
  assert.deepEqual(labels('flurbo/evejs-contrib-fork', opts), ['identity']);
  assert.deepEqual(labels('flurbo/evejs-contrib at 192.168.1.4', opts), ['private-ip']);
  assert.deepEqual(labels('flurbo/evejs-contrib', { identity: ['flurbo'] }), ['identity']);
});

test('slugFromRepository reads URLs and slugs', () => {
  const { slugFromRepository } = require('../skills/upstream-report/scripts/leak-scan.js');
  assert.equal(slugFromRepository('https://github.com/a-b/evejs-contrib'), 'a-b/evejs-contrib');
  assert.equal(slugFromRepository('https://github.com/a/r.git'), 'a/r');
  assert.equal(slugFromRepository('a/r'), 'a/r');
  assert.equal(slugFromRepository(''), '');
  assert.equal(slugFromRepository('https://example.org/a/r'), '');
});

test('slugFromRepository also takes the package.json object form', () => {
  const { slugFromRepository } = require('../skills/upstream-report/scripts/leak-scan.js');
  assert.equal(slugFromRepository({ type: 'git', url: 'https://github.com/a/r.git' }), 'a/r');
  assert.equal(slugFromRepository({}), '');
});

test('--self CLI flag exempts the slug from identity; a bad value is a usage error', () => {
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = require('./fixtures/tmp.js').mk('self-flag-');
  fs.writeFileSync(path.join(dir, 'a.md'), 'claude plugin marketplace add flurbo/evejs-contrib\n');
  const home = require('./fixtures/tmp.js').mk('self-flag-home-');
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Flurbo\n\temail = nobody@example.org\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', EVEJS_CONTRIB_CONFIG_DIR: home };
  const scan = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'skills', 'upstream-report', 'scripts', 'leak-scan.js'), dir, ...args], { encoding: 'utf8', env, cwd: home });
  assert.notEqual(scan().status, 0, 'identity hit without --self');
  const ok = scan('--self', 'https://github.com/flurbo/evejs-contrib');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const bad = scan('--self', 'not a slug');
  assert.equal(bad.status, 64);
  assert.match(bad.stderr, /--self needs <owner>\/<repo>/);
});

// ---- final-review fixes: IP addresses, character names by shape, entry names, UTF-16 ----
test('ip-address: public IPv4/IPv6 hit; private ones keep the private-ip label; exempt ranges pass', () => {
  assert.deepEqual(labels('[Session 8.8.4.4:51234 user=<account-1>(1) char=<character-1>(2)] x'), ['ip-address']);
  assert.deepEqual(labels('tcp connect 172.32.0.1:443'), ['ip-address']);
  assert.deepEqual(labels('100.64.1.2'), ['private-ip']); // shared-address (CGNAT)
  assert.deepEqual(labels('from fd7a:115c:a1e0::1234'), ['private-ip']); // IPv6 ULA
  assert.deepEqual(labels('from fe80::1'), ['private-ip']); // link-local
  assert.deepEqual(labels('from 2606:4700::1111'), ['ip-address']);
  assert.deepEqual(labels('from ::ffff:10.1.2.3'), ['private-ip']);
  assert.deepEqual(labels('x', { allow: ['ip-address'] }), []);
  assert.deepEqual(labels('8.8.4.4', { allow: ['ip-address'] }), []);
});

test('ip-address: upstream code under patches/ and files/ only gets the private-range check', () => {
  const t = (name, text) => scanTexts([{ name, text }]).map((h) => h.term);
  assert.deepEqual(t('b/patches/0001.patch', '+ const dns = "8.8.8.8";'), []);
  assert.deepEqual(t('b/files/server/net.js', 'const dns = "8.8.8.8"; // 1.1.1.1'), []);
  assert.deepEqual(t('b/files/server/net.js', 'const lan = "192.168.1.1";'), ['private-ip']);
  assert.deepEqual(t('b/error-report/server-logs/server.log', 'peer 8.8.8.8'), ['ip-address']);
  assert.deepEqual(t('b.zip/top/patches/x.patch', 'dns 8.8.8.8'), []);
  assert.deepEqual(t('b/error-report/server-logs/server.log', 'peer 8.8.8.8'), ['ip-address']);
});

test('character-name: an un-redacted name in the server log shapes hits; placeholders, templates and numbers do not', () => {
  assert.deepEqual(labels('[Session s user=<account-1>(1) char=New Guy(90000002)] x'), ['character-name']);
  assert.deepEqual(labels('[CharService] Created character "Other Pilot" with ID 3'), ['character-name']);
  assert.deepEqual(labels('CreateCharacterWithDoll: name="Fourth Guy" race=1'), ['character-name']);
  assert.deepEqual(labels('[CharState] Applied Third One(4) ship=1'), ['character-name']);
  assert.deepEqual(labels('[Session s user=<account-1>(1) char=<character-1>(2)] x'), []);
  assert.deepEqual(labels('char=undefined(undefined) char=9001 name="Some Group"'), []);
  assert.deepEqual(labels('log(`[CharService] Created character "${name}" with ID ${id}`)'), []);
  const t = (name, text) => scanTexts([{ name, text }]).map((h) => h.term);
  assert.deepEqual(t('b/files/server/x.js', 'Created character "Other Pilot" with ID'), [], 'upstream code is exempt');
});

test('entry names are scanned as line 0, not the scanned root', () => {
  const hits = scanTexts([{ name: 'Pilot Alpha-root/server/Pilot Alpha.log', text: 'ok\n' }], { names: ['Pilot Alpha'] });
  assert.deepEqual(hits, [{ name: 'Pilot Alpha-root/server/Pilot Alpha.log', term: 'character-name', line: 0 }]);
  assert.deepEqual(scanTexts([{ name: 'Pilot Alpha-root/server/x.log', text: 'ok\n' }], { names: ['Pilot Alpha'] }), []);
});

test('collectTexts decodes UTF-16 text (BOM) instead of skipping it; real binaries are still reported', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'u16.log'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('C:\\Users\\Sam\\x\r\n', 'utf16le')]));
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
  const skipped = [];
  const texts = collectTexts([dir], { onSkip: (n) => skipped.push(n) });
  assert.equal(texts.length, 1);
  assert.match(texts[0].text, /Users/);
  assert.deepEqual(skipped.map((n) => path.basename(n)), ['blob.bin']);
  assert.deepEqual(scanTexts(texts).map((h) => h.term), ['home-path']);
});

test('CLI: --names and --hosts files are scanned for (labels character-name and host)', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.log'), 'Zephyra Quill docked at depot-7\n');
  const names = path.join(dir, 'names.txt');
  fs.writeFileSync(names, 'Zephyra Quill\n');
  const hosts = path.join(dir, 'hosts.txt');
  fs.writeFileSync(hosts, 'depot-7\n');
  const r = runNoId(path.join(dir, 'a.log'), '--names', names, '--hosts', hosts);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /a\.log:1: character-name/);
  assert.match(r.stdout, /a\.log:1: host/);
  assert.equal(runNoId(path.join(dir, 'a.log')).status, 0);
});

test('home path: lower-case forward-slash Windows forms hit; a /users/<id> route does not', () => {
  assert.deepEqual(labels('c:/users/sam/x'), ['home-path']);
  assert.deepEqual(labels('/c/users/sam/x'), ['home-path']);
  assert.deepEqual(labels('GET /users/123'), []);
});

test('lan-host: UNC forms hit', () => {
  assert.deepEqual(labels('\\\\nas.local\\share'), ['lan-host']);
  assert.deepEqual(labels('//nas.local/share'), ['lan-host']);
  assert.deepEqual(labels('see src/box.lan/x'), []);
});

test('identityTerms: a fully qualified host name also gives its first label (unless short or common)', () => {
  const { identityTerms } = require('../skills/upstream-report/scripts/lib/identity.js');
  const none = () => '';
  assert.deepEqual(identityTerms({ get: none, username: '', hostname: 'box.example.org' }), ['box.example.org', 'box']);
  assert.deepEqual(identityTerms({ get: none, username: '', hostname: 'ab.example.org' }), ['ab.example.org']);
  assert.deepEqual(identityTerms({ get: none, username: '', hostname: 'localhost.localdomain' }), ['localhost.localdomain']);
});

test('home paths: /root/ and C:\\Documents and Settings\\<name>', () => {
  assert.deepEqual(labels('see /root/x.log'), ['home-path']);
  assert.deepEqual(labels('see C:\\Documents and Settings\\Sam\\x'), ['home-path']);
  assert.deepEqual(labels('see c:/documents and settings/sam/x'), ['home-path']);
  assert.deepEqual(labels('the /rootfs/x and /ROOT/x'), []);
  for (const t of ['/root/x', 'cd "/root/x"', 'PATH=/root/bin', 'open(/root/x)', 'at /root/x']) assert.deepEqual(labels(t), ['home-path'], t);
  for (const t of ['at /app/src/root/index.js:3', 'GET /api/root/list', '/proc/1/root/etc/hosts', 'node_modules/x/root/y', './root/x', '../root/x']) assert.deepEqual(labels(t), [], t);
});

test('email: reserved domains (XMPP JIDs on localhost, .invalid, .test, .example, example.*) are not emails', () => {
  for (const t of ['room1@conference.localhost/abc123', 'a@localhost', 'a@x.localhost', 'a@x.invalid', 'a@host.test', 'a@x.example', 'a@example.com', 'a@mail.example.net', 'a@example.org']) {
    assert.deepEqual(labels(t), [], t);
  }
  assert.deepEqual(labels('a@b.org'), ['email']);
  assert.deepEqual(labels('a@notexample.com'), ['email']);
  assert.deepEqual(labels('room@conference.localhost and a@b.org'), ['email']);
});

test('upstream-code exemption is only the bundle top-level patches/ and files/', () => {
  const t = (name) => scanTexts([{ name, text: 'peer 8.8.8.8' }]).map((h) => h.term);
  assert.deepEqual(t('b/patches/x.patch'), []);
  assert.deepEqual(t('b/files/x.js'), []);
  assert.deepEqual(t('b.zip/top/files/x.js'), []);
  assert.deepEqual(t('b/evidence/files/x.log'), ['ip-address']);
  assert.deepEqual(t('b/error-report/files/x.log'), ['ip-address']);
  assert.deepEqual(t('b/top/patches/x.patch'), ['ip-address']);
  assert.deepEqual(t('b.zip/top/evidence/files/x.log'), ['ip-address']);
  assert.deepEqual(t('b.zip/evidence/files/x.log'), ['ip-address']);
});

test('the old name label is a silent alias of the character-name allow label', () => {
  const text = '[Session s user=<account-1>(1) char=New Guy(90000002)] x';
  assert.deepEqual(labels(text, { allow: ['play' + 'er-name'] }), []);
  assert.deepEqual(labels(text, { allow: ['character-name'] }), []);
});
