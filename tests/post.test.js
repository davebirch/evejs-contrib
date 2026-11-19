'use strict';
// The Discord post that travels beside a bundle zip: bundle.js checkPost and the check-post command.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkPost, POST_LIMIT } = require('../skills/upstream-report/scripts/bundle.js');

const CLI = path.join(__dirname, '..', 'skills', 'upstream-report', 'scripts', 'bundle.js');
const tmp = () => require('./fixtures/tmp.js').mk('post-test-');
const CONFIG = tmp(); // never the real config dir; no terms file inside
const run = (...args) =>
  spawnSync(process.execPath, [CLI, ...args, '--no-identity'], { encoding: 'utf8', env: { ...process.env, EVEJS_CONTRIB_CONFIG_DIR: CONFIG } });

const HEAD = '**Fleet invites drop the second wing**\n\nInviting a member into wing 2 puts them in wing 1. ';
const TAIL = '\n\nFull report, patch, tests and evidence in the attached zip.\n';
// A post whose message text (trimmed, as Discord sends it) is exactly n characters.
const sized = (n, fill = 'x') => {
  const body = `${HEAD}${TAIL}`.trim();
  return `${HEAD}${fill.repeat(n - [...body].length)}${TAIL}`;
};
const msgLen = (s) => [...s.trim()].length;
const ok = (text, opts) => assert.deepEqual(checkPost(text, opts), []);
const fails = (text, re, opts) => {
  const p = checkPost(text, opts);
  assert.ok(p.some((x) => re.test(x)), `expected ${re} in ${JSON.stringify(p)}`);
};

test('the limit is 1,900 characters', () => assert.equal(POST_LIMIT, 1900));

test('a post of exactly 1,900 characters passes and 1,901 fails, counted in characters, not bytes', () => {
  assert.equal(msgLen(sized(1900)), 1900);
  ok(sized(1900));
  fails(sized(1901), /1901 characters \(limit 1900\)/);
  // é is two bytes and 🚀 four (two UTF-16 units): both count as one character
  ok(sized(1900, 'é'));
  ok(sized(1900, '🚀'));
  fails(sized(1901, '🚀'), /1901 characters/);
});

test('an empty post fails', () => {
  fails('', /empty/);
  fails('\n  \n', /empty/);
});

test('two parts with a correct marker, each within the limit, pass; one part over fails', () => {
  const two = `${sized(1900)}--- part 2/2 ---\n${sized(1900)}`;
  ok(two);
  fails(`${sized(1900)}--- part 2/2 ---\n${sized(1901)}`, /part 2 is 1901 characters/);
  fails(`${sized(1901)}--- part 2/2 ---\n${sized(10 + msgLen(HEAD + TAIL))}`, /part 1 is 1901 characters/);
  // an optional "part 1/2" marker on the first line is allowed too
  ok(`--- part 1/2 ---\n${sized(1900)}--- part 2/2 ---\n${sized(1900)}`);
});

test('a part marker with a wrong count or number fails; a malformed marker fails', () => {
  fails(`${sized(500)}--- part 2/3 ---\n${sized(500)}`, /part 2\/3.*2 parts/);
  fails(`${sized(500)}--- part 3/2 ---\n${sized(500)}`, /part 3\/2/);
  fails(`${sized(500)}--- part 2/2 ---\n${sized(500)}--- part 2/2 ---\n${sized(500)}`, /part 2\/2.*3 parts/);
  fails(`${sized(500)}--- part 1/1 ---\n`, /part 1\/1/);
  fails(`${sized(500)}--- Part 2 of 2 ---\n${sized(500)}`, /malformed part marker/);
  fails(`${sized(500)}--- part 2/2 ---\n\n`, /part 2 is empty/);
});

test('a marker inside a code block is text, not a marker', () => {
  ok(`${HEAD}\n\n\`\`\`\n--- part 2/2 ---\n\`\`\`\n${TAIL}`);
});

test('a pipe table outside a code block fails; the same table inside one passes', () => {
  const table = '| Metric | Before | After |\n|---|---|---|\n| tick p50 | 12 ms | 4 ms |\n';
  fails(`${HEAD}\n\n${table}${TAIL}`, /line 5: table outside a code block/);
  fails(`${HEAD}\n\nMetric | Before\n--- | ---\ntick | 12\n${TAIL}`, /table/);
  ok(`${HEAD}\n\n\`\`\`\n${table}\`\`\`\n${TAIL}`);
});

test('a table in a code block must stay small: at most 8 lines of at most 60 characters', () => {
  const row = (i) => `| row ${i} | 1 | 2 |`;
  const rows = (n) => ['| a | b | c |', '|---|---|---|', ...Array.from({ length: n }, (_, i) => row(i))].join('\n');
  ok(`${HEAD}\n\n\`\`\`\n${rows(6)}\n\`\`\`\n${TAIL}`);
  fails(`${HEAD}\n\n\`\`\`\n${rows(7)}\n\`\`\`\n${TAIL}`, /code block.*9 lines/);
  fails(`${HEAD}\n\n\`\`\`\n| ${'w'.repeat(60)} | 1 |\n\`\`\`\n${TAIL}`, /wider than 60/);
  // code that is not a table may be longer
  ok(`${HEAD}\n\n\`\`\`js\n${Array.from({ length: 12 }, (_, i) => `const a${i} = ${i};`).join('\n')}\n\`\`\`\n${TAIL}`);
});

test('an unclosed code block fails', () => {
  fails(`${HEAD}\n\n\`\`\`\nnot closed\n${TAIL}`, /unclosed code block/);
});

test('links into the zip fail; web links and inline code paths pass', () => {
  fails(`${HEAD}See [the patch](patches/01.patch).${TAIL}`, /link into the zip: patches\/01\.patch/);
  fails(`${HEAD}See [report](./BUG-REPORT.md).${TAIL}`, /link into the zip/);
  fails(`${HEAD}See [ref].\n\n[ref]: evidence/performance-comparison.md\n${TAIL}`, /link into the zip: evidence\/performance-comparison\.md/);
  ok(`${HEAD}See [the issue](https://example.com/issues/1) and \`patches/01.patch\`.${TAIL}`);
  ok(`${HEAD}See <https://example.com/x>.${TAIL}`);
});

test('images fail', () => {
  fails(`${HEAD}![img](a.png)${TAIL}`, /image/);
  fails(`${HEAD}![chart](https://example.com/a.png)${TAIL}`, /image/);
  ok(`${HEAD}\`![not an image](a.png)\`${TAIL}`);
});

test('leak terms fail, with the same options as check', () => {
  const opts = { terms: { terms: ['gizmo'], names: ['Zephyra Quill'], identity: [] } };
  fails(`${HEAD}A gizmo broke.${TAIL}`, /leak: .*:3: gizmo/, opts);
  fails(`${HEAD}Zephyra Quill saw it.${TAIL}`, /character-name/, opts);
  fails(`${HEAD}Seen from 192.168.1.20.${TAIL}`, /leak: /);
  ok(`${HEAD}A gizmo broke.${TAIL}`, { ...opts, allow: ['gizmo'] });
});

test('CRLF and a BOM are read like LF', () => {
  ok(`﻿${sized(1900)}`.replace(/\n/g, '\r\n'));
  fails(`${sized(1901)}`.replace(/\n/g, '\r\n'), /1901 characters/);
});

test('check-post: exit 0 on a good post, 2 with one line per problem, 64 on usage', () => {
  const d = tmp();
  const good = path.join(d, 'x.post.md');
  fs.writeFileSync(good, sized(1000));
  const r = run('check-post', good);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /post check passed/);
  const bad = path.join(d, 'bad.post.md');
  fs.writeFileSync(bad, `${sized(1901)}![i](a.png)\n`);
  const b = run('check-post', bad);
  assert.equal(b.status, 2);
  assert.ok(b.stdout.split('\n').filter((l) => l.startsWith('refusing:')).length >= 2, b.stdout);
  assert.equal(run('check-post').status, 64);
  assert.equal(run('check-post', path.join(d, 'missing.md')).status, 64);
  const bin = path.join(d, 'bin.post.md');
  fs.writeFileSync(bin, Buffer.from([0, 1, 2, 0xff, 0xfe, 0]));
  assert.equal(run('check-post', bin).status, 2);
});

test('check-post: --terms adds a terms file, --allow lifts a term', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'terms'), 'gizmo\n');
  const p = path.join(d, 'x.post.md');
  fs.writeFileSync(p, `${HEAD}A gizmo broke.${TAIL}`);
  const r = run('check-post', p, '--terms', path.join(d, 'terms'));
  assert.equal(r.status, 2);
  assert.match(r.stdout, /refusing: leak: x\.post\.md:3: gizmo/);
  assert.equal(run('check-post', p, '--terms', path.join(d, 'terms'), '--allow', 'gizmo').status, 0);
});

test('a closing fence may be followed by whitespace: a marker after it still splits the post', () => {
  const post = `${HEAD}\n\n\`\`\`\ncode\n\`\`\`   \n${TAIL}--- part 2/2 ---\n${sized(500)}`;
  ok(post);
  fails(`${HEAD}\n\n\`\`\`\ncode\n\`\`\`   \n${TAIL}--- part 2/3 ---\n${sized(500)}`, /2 parts/);
});

test('marker numbers have no leading zeros', () => {
  fails(`${sized(500)}--- part 02/2 ---\n${sized(500)}`, /line \d+: malformed part marker/);
  fails(`${sized(500)}--- part 2/02 ---\n${sized(500)}`, /malformed part marker/);
  fails(`${sized(500)}--- part 0/2 ---\n${sized(500)}`, /malformed part marker/);
});

test('~~~ fences are refused: Discord renders only backtick code blocks', () => {
  const table = '| Metric | Before | After |\n|---|---|---|\n| tick p50 | 12 ms | 4 ms |\n';
  fails(`${HEAD}\n\n~~~text\n${table}~~~\n${TAIL}`, /line 5: use ``` fences: Discord doesn't render ~~~/);
  // still a fence for splitting: a marker inside it is text, so only the fence problem is reported
  const p = checkPost(`${HEAD}\n\n~~~\n--- part 2/2 ---\n~~~\n${TAIL}`);
  assert.deepEqual(p.map((x) => x.replace(/^post: line \d+: /, '')), ["use ``` fences: Discord doesn't render ~~~"]);
});

test('a one-line ```code``` span does not open a code block', () => {
  ok(`${HEAD}\n\n\`\`\`x = 1\`\`\`\n${TAIL}`);
  ok(`${HEAD}\n\n\`\`\`js\nconst a = 1;\n\`\`\`\n${TAIL}`);
  fails(`${HEAD}\n\n\`\`\`js\nnot closed\n${TAIL}`, /unclosed code block/);
});

test('check-post: a post must be UTF-8 (a UTF-8 BOM is fine) and at most 64 KiB', () => {
  const d = tmp();
  const f = (name, bytes) => { const p = path.join(d, name); fs.writeFileSync(p, bytes); return p; };
  const text = sized(500);
  assert.equal(run('check-post', f('bom.md', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]))).status, 0);
  const le = run('check-post', f('le.md', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])));
  assert.equal(le.status, 2);
  assert.match(le.stdout, /refusing: le\.md: is UTF-16: save it as UTF-8/);
  const be = Buffer.from(text, 'utf16le').swap16();
  assert.match(run('check-post', f('be.md', Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).stdout, /be\.md: is UTF-16/);
  const latin = run('check-post', f('latin.md', Buffer.from(`${HEAD}caf\xe9${TAIL}`, 'latin1')));
  assert.equal(latin.status, 2);
  assert.match(latin.stdout, /refusing: latin\.md: not valid UTF-8: save it as UTF-8/);
  const big = run('check-post', f('big.md', Buffer.from(text + ' '.repeat(65537 - Buffer.byteLength(text)))));
  assert.equal(big.status, 2);
  assert.match(big.stdout, /refusing: big\.md: is 65537 bytes \(limit 65536, 64 KiB\)/);
  const edge = run('check-post', f('edge.md', Buffer.from(text + ' '.repeat(65536 - Buffer.byteLength(text)))));
  assert.equal(edge.status, 0, edge.stdout);
});

test('--post is a usage error on commands other than zip and check', () => {
  const d = tmp();
  const p = path.join(d, 'x.post.md');
  fs.writeFileSync(p, sized(500));
  const r = run('check-post', p, '--post', p);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /--post is only for zip and check/);
  assert.equal(run('manifest', d, '--post', p).status, 64);
  assert.equal(run('init', path.join(d, 'n'), '--area', 'a', '--version', 'v', '--post', p).status, 64);
  assert.ok(!fs.existsSync(path.join(d, 'n')));
});
