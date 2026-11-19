'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeErrorReport } = require('./fixtures/make-error-report.js');

const BUNDLE = path.join(__dirname, '..', 'skills', 'upstream-report', 'scripts', 'bundle.js');
const CLI = path.join(__dirname, '..', 'skills', 'upstream-report-perf', 'scripts', 'health-metrics.js');
const tmp = () => require('./fixtures/tmp.js').mk('health-test-');
const CONFIG = tmp();
const env = { ...process.env, EVEJS_CONTRIB_CONFIG_DIR: CONFIG };
const bundle = (...args) => spawnSync(process.execPath, [BUNDLE, ...args, '--no-identity'], { encoding: 'utf8', env });
const metrics = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

const FROM = '2026-11-18T16:00:00.000Z';
const TO = '2026-11-18T17:00:00.000Z';
const T0 = Date.parse(FROM);
const iso = (ms) => new Date(ms).toISOString();
const WINDOWS = { before: { from: FROM, to: TO }, after: { from: FROM, to: TO } };

// Builds <dir>/evidence/<side>/ through the real bundle.js, as a contributor would.
// health: array of records; events: array of records, or null for no profiling/; profiles: file names to put in close-watch/.
function addSide(root, side, { health, events = null, profiles = [] }) {
  const d = tmp();
  const z = path.join(d, 'report.zip');
  const cw = path.join(d, 'cw');
  makeErrorReport(z, { health: jsonl(health), profile: events !== null, events: events ? jsonl(events) : null, closeWatch: cw });
  assert.equal(bundle('add-report', root, z, '--as', `evidence/${side}/error-report`).status, 0);
  fs.rmSync(cw, { recursive: true, force: true });
  if (profiles.length) {
    fs.mkdirSync(cw);
    for (const p of profiles) fs.writeFileSync(path.join(cw, p), '{"nodes":[],"samples":[],"timeDeltas":[]}');
    const r = bundle('add-profiles', root, cw, '--as', `evidence/${side}`);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
}
const writeJson = (root, name, v) => fs.writeFileSync(path.join(root, 'evidence', name), JSON.stringify(v));
const capture = (i, durationMs, extra = {}) => ({ time: iso(T0 + i * 1000 + 50), event: 'cpuCapture', atMs: T0 + i * 1000, durationMs, partial: false, profileFile: null, ...extra });

// 21 captures of 100..2100 ms: total 23100, nearest-rank p95 = sorted[19] = 2000, max 2100, two >= 2 s.
const ladder = () => Array.from({ length: 21 }, (_, i) => capture(i, (i + 1) * 100));

function fixture() {
  const root = tmp();
  addSide(root, 'before', {
    health: [
      { time: iso(T0), event: 'closeWatchStarted', minutes: 15, startedBy: 'Sam Rivers' },
      ...ladder(),
      { time: iso(T0 + 5000), event: 'started', worstStatus: 'warn', subsystemMs: { tick: 10 } },
      { time: iso(T0 + 6000), event: 'escalated', worstStatus: 'critical', subsystemMs: { tick: 99 } },
      { time: iso(T0 + 7000), event: 'recovered', worstStatus: 'critical', subsystemMs: { tick: 100.1, ai: 5 } },
      { time: iso(T0 + 8000), event: 'recovered', worstStatus: 'warn', subsystemMs: { tick: 50.2 } },
      { time: iso(T0 + 9000), event: 'recovered', worstStatus: 'critical', subsystemMs: {} },
      { time: iso(T0 - 1000), event: 'recovered', worstStatus: 'warn', subsystemMs: { tick: 7777 } },
      { time: iso(T0 + 3600000), event: 'recovered', worstStatus: 'warn', subsystemMs: { tick: 8888 } },
    ],
    events: [
      { type: 'meta', utc: iso(T0) },
      { type: 'stall', utc: iso(T0 + 3000), gapMs: 2500, lagMs: 1500 },
      { type: 'stall', utc: iso(T0 + 4000), gapMs: 3000, lagMs: 2000.25 },
      { type: 'stall', utc: iso(T0 + 5000), gapMs: 2000, lagMs: 1000 },
      { type: 'stall', utc: iso(T0 - 5), gapMs: 9000, lagMs: 8000 },
    ],
  });
  addSide(root, 'after', { health: [{ time: iso(T0), event: 'closeWatchStarted', minutes: 15, startedBy: 'Sam Rivers' }, { time: iso(T0 + 60000), event: 'closeWatchEnded', reason: 'timeout', stallCount: 0 }] });
  writeJson(root, 'windows.json', WINDOWS);
  return root;
}
const metricsOf = (root, ...extra) => {
  const r = metrics(path.join(root, 'evidence'), ...extra);
  return { r, out: r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null };
};

test('21 windows: hand-computed total, nearest-rank p95, max and count >= 2 s; incidents; stalls', () => {
  const { r, out } = metricsOf(fixture());
  assert.equal(r.status, 0, r.stderr);
  const b = out.before;
  assert.equal(b.windows, 21);
  assert.equal(b.window_total_ms, 23100);
  assert.equal(b.window_p95_ms, 2000);
  assert.equal(b.window_max_ms, 2100);
  assert.equal(b.windows_ge_2s, 2);
  assert.deepEqual(b.incidents_by_status, { critical: 2, warn: 1 });
  assert.equal(b.incident_subsystem_ms, 155.3);
  assert.equal(b.stalls, 3);
  assert.equal(b.stall_lag_total_ms, 4500.3);
  assert.equal(b.stall_lag_p95_ms, 2000.25);
  assert.equal(b.stall_lag_max_ms, 2000.25);
  assert.deepEqual(b.profiles, []);
  assert.deepEqual(b.profiles_missing, []);
});

test('an after-run with zero windows: windows 0, p95 null, stalls null without profiling/', () => {
  const { r, out } = metricsOf(fixture());
  assert.equal(r.status, 0, r.stderr);
  const a = out.after;
  assert.equal(a.windows, 0);
  assert.equal(a.window_total_ms, 0);
  assert.equal(a.window_p95_ms, null);
  assert.equal(a.window_max_ms, null);
  assert.equal(a.windows_ge_2s, 0);
  assert.deepEqual(a.incidents_by_status, {});
  assert.equal(a.incident_subsystem_ms, 0);
  for (const k of ['stalls', 'stall_lag_total_ms', 'stall_lag_p95_ms', 'stall_lag_max_ms']) assert.equal(a[k], null, k);
});

test('cpuCapture is timed by atMs, not time; [from, to) is half-open', () => {
  const root = tmp();
  addSide(root, 'before', {
    health: [
      // logged after the window ends, but the stall started inside it: counts
      { time: iso(T0 + 3600000 + 30000), event: 'cpuCapture', atMs: T0 + 3600000 - 1000, durationMs: 700, profileFile: null },
      // logged inside the window, but the stall started before it: doesn't
      { time: iso(T0 + 10), event: 'cpuCapture', atMs: T0 - 1000, durationMs: 5000, profileFile: null },
      // atMs exactly at `from` counts, exactly at `to` doesn't
      { time: iso(T0 + 20), event: 'cpuCapture', atMs: T0, durationMs: 300, profileFile: null },
      { time: iso(T0 + 30), event: 'cpuCapture', atMs: T0 + 3600000, durationMs: 9000, profileFile: null },
    ],
  });
  addSide(root, 'after', { health: [capture(0, 100)] });
  writeJson(root, 'windows.json', WINDOWS);
  const { r, out } = metricsOf(root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(out.before.windows, 2);
  assert.equal(out.before.window_total_ms, 1000);
  assert.equal(out.before.window_max_ms, 700);
});

test('profiles lists in-window profile files; profiles_missing those absent from close-watch/', () => {
  const root = tmp();
  const f = (n) => `logs/tick-profiles/${n}.cpuprofile`;
  addSide(root, 'before', {
    health: [
      capture(1, 900, { profileFile: f('b-present') }),
      capture(2, 950, { profileFile: f('a-gone') }),
      capture(3, 100),
      { ...capture(4, 800, { profileFile: f('out-of-window') }), atMs: T0 - 1 },
    ],
    profiles: ['b-present.cpuprofile'],
  });
  addSide(root, 'after', { health: [capture(1, 100)] });
  writeJson(root, 'windows.json', WINDOWS);
  const { r, out } = metricsOf(root);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(out.before.profiles, ['a-gone.cpuprofile', 'b-present.cpuprofile']);
  assert.deepEqual(out.before.profiles_missing, ['a-gone.cpuprofile']);
});

test('--check: passes on a matching expected.json, exits 1 naming the differing field', () => {
  const root = fixture();
  const { out } = metricsOf(root);
  writeJson(root, 'expected.json', out);
  const ok = metrics(path.join(root, 'evidence'), '--check');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  out.before.window_p95_ms = 1900;
  writeJson(root, 'expected.json', out);
  const bad = metrics(path.join(root, 'evidence'), '--check');
  assert.equal(bad.status, 1);
  assert.match(bad.stdout + bad.stderr, /before\.window_p95_ms/);
  assert.doesNotMatch(bad.stdout + bad.stderr, /before\.window_max_ms/);
});

test('--check without expected.json is refused (64)', () => {
  const root = fixture();
  assert.equal(metrics(path.join(root, 'evidence'), '--check').status, 64);
});

test('a side with neither server-health*.log nor profiling/events.jsonl exits 2', () => {
  const root = tmp();
  addSide(root, 'before', { health: [capture(1, 100)] });
  addSide(root, 'after', { health: [capture(1, 100)] });
  fs.rmSync(path.join(root, 'evidence/after/error-report/server-logs/server-health.log'));
  writeJson(root, 'windows.json', WINDOWS);
  const r = metrics(path.join(root, 'evidence'));
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /no health records: was Close Watch or the pause profiler running\?/);
  assert.match(r.stdout + r.stderr, /after/);
});

test('a side with only profiling/events.jsonl still computes (windows 0, stalls counted)', () => {
  const root = tmp();
  addSide(root, 'before', { health: [capture(1, 100)], events: [{ type: 'stall', utc: iso(T0 + 1), lagMs: 1200 }] });
  addSide(root, 'after', { health: [capture(1, 100)], events: [] });
  fs.rmSync(path.join(root, 'evidence/before/error-report/server-logs/server-health.log'));
  writeJson(root, 'windows.json', WINDOWS);
  const { r, out } = metricsOf(root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(out.before.windows, 0);
  assert.equal(out.before.stalls, 1);
  assert.equal(out.after.stalls, 0);
  assert.equal(out.after.stall_lag_p95_ms, null);
});

test('bad or missing windows.json is a usage error (64)', () => {
  const root = fixture();
  fs.unlinkSync(path.join(root, 'evidence/windows.json'));
  assert.equal(metrics(path.join(root, 'evidence')).status, 64);
  writeJson(root, 'windows.json', { before: { from: 'nonsense', to: TO }, after: { from: FROM, to: TO } });
  assert.equal(metrics(path.join(root, 'evidence')).status, 64);
  assert.equal(metrics().status, 64);
});

test('tolerates CRLF, a BOM and non-JSON lines in the health log', () => {
  const root = tmp();
  addSide(root, 'before', { health: [capture(1, 400)] });
  addSide(root, 'after', { health: [capture(1, 100)] });
  const p = path.join(root, 'evidence/before/error-report/server-logs/server-health.log');
  fs.writeFileSync(p, '\uFEFF' + 'plain text line\r\n' + fs.readFileSync(p, 'utf8').replace(/\n/g, '\r\n'));
  writeJson(root, 'windows.json', WINDOWS);
  const { r, out } = metricsOf(root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(out.before.windows, 1);
});

test('a stall is timed by its start, utc - gapMs: one straddling from is out, one starting at from is in', () => {
  const root = tmp();
  addSide(root, 'before', {
    health: [capture(1, 100)],
    events: [
      { type: 'stall', utc: iso(T0 + 500), gapMs: 1500, lagMs: 500 },
      { type: 'stall', utc: iso(T0 + 1500), gapMs: 1500, lagMs: 500.5 },
      { type: 'stall', utc: iso(T0 + 3600000 + 200), gapMs: 1500, lagMs: 700 },
    ],
  });
  addSide(root, 'after', { health: [capture(1, 100)] });
  writeJson(root, 'windows.json', WINDOWS);
  const { r, out } = metricsOf(root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(out.before.stalls, 2);
  assert.equal(out.before.stall_lag_total_ms, 1200.5);
});

test('windows.json times without Z or an offset are refused (64), whatever TZ; offsets work', () => {
  const root = fixture();
  const withTz = (tz) => spawnSync(process.execPath, [CLI, path.join(root, 'evidence')], { encoding: 'utf8', env: { ...env, TZ: tz } });
  writeJson(root, 'windows.json', { before: { from: '2026-11-18T16:00:00', to: '2026-11-18T17:00:00' }, after: WINDOWS.after });
  for (const tz of ['America/New_York', 'UTC']) {
    const r = withTz(tz);
    assert.equal(r.status, 64, tz);
    assert.match(r.stderr, /Z or \+hh:mm/);
  }
  const off = { from: '2026-11-18T18:00:00+02:00', to: '2026-11-18T19:00:00.000+02:00' };
  writeJson(root, 'windows.json', { before: off, after: WINDOWS.after });
  const a = withTz('America/New_York');
  const b = withTz('Asia/Tokyo');
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout, b.stdout);
  assert.equal(JSON.parse(a.stdout).before.windows, 21);
});

test('--check: non-object expected.json is 64; missing field shows (missing); key order does not matter', () => {
  const root = fixture();
  const ev = path.join(root, 'evidence');
  const { out } = metricsOf(root);
  fs.writeFileSync(path.join(ev, 'expected.json'), '[1]');
  assert.equal(metrics(ev, '--check').status, 64);
  fs.writeFileSync(path.join(ev, 'expected.json'), 'null');
  assert.equal(metrics(ev, '--check').status, 64);
  const gone = JSON.parse(JSON.stringify(out));
  delete gone.before.windows_ge_2s;
  writeJson(root, 'expected.json', gone);
  const bad = metrics(ev, '--check');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /before\.windows_ge_2s: expected \(missing\)/);
  assert.doesNotMatch(bad.stderr, /undefined/);
  const flipped = JSON.parse(JSON.stringify(out));
  flipped.before.incidents_by_status = { warn: 1, critical: 2 };
  writeJson(root, 'expected.json', flipped);
  const ok = metrics(ev, '--check');
  assert.equal(ok.status, 0, ok.stderr);
});

test('a missing error-report/ says to run add-report, not that Close Watch was off', () => {
  const root = fixture();
  fs.rmSync(path.join(root, 'evidence/after/error-report'), { recursive: true });
  const r = metrics(path.join(root, 'evidence'));
  assert.equal(r.status, 2);
  assert.match(r.stdout, /evidence\/after\/error-report not found: run add-report/);
  assert.doesNotMatch(r.stdout, /Close Watch/);
});

test('warns on a truncated server-health log and on cut JSONL lines', () => {
  const root = tmp();
  addSide(root, 'before', { health: [capture(1, 400)] });
  addSide(root, 'after', { health: [capture(1, 100)] });
  const mp = path.join(root, 'evidence/before/error-report/manifest.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  m.logs.included.push({ zipPath: 'server-logs/server-health.log', bytes: 10, includedBytes: 5, truncated: true });
  fs.writeFileSync(mp, JSON.stringify(m));
  const lp = path.join(root, 'evidence/before/error-report/server-logs/server-health.log');
  fs.appendFileSync(lp, '{"time":"2026-11-18T16:00:01.000Z","event":"cpuCap');
  writeJson(root, 'windows.json', WINDOWS);
  const r = metrics(path.join(root, 'evidence'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /warning: before: server-logs\/server-health\.log was truncated/);
  assert.match(r.stderr, /warning: before: dropped 1 unparseable/);
  assert.doesNotMatch(r.stderr, /after:/);
});

test('rotated server-health.<stamp>.log aggregates; a cpuCapture without durationMs lists its profile but not in stats', () => {
  const root = tmp();
  addSide(root, 'before', {
    health: [capture(1, 300), capture(3, 500, { profileFile: 'logs/tick-profiles/odd.cpuprofile', durationMs: undefined })],
    profiles: ['odd.cpuprofile'],
  });
  addSide(root, 'after', { health: [capture(1, 100)] });
  fs.writeFileSync(path.join(root, 'evidence/before/error-report/server-logs/server-health.2026-11-18_16.log'), jsonl([capture(2, 700)]));
  writeJson(root, 'windows.json', WINDOWS);
  const { r, out } = metricsOf(root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(out.before.windows, 2);
  assert.equal(out.before.window_total_ms, 1000);
  assert.deepEqual(out.before.profiles, ['odd.cpuprofile']);
  assert.deepEqual(out.before.profiles_missing, []);
});

test('--write saves the JSON as plain UTF-8 (no BOM) and --check then passes on it', () => {
  const root = fixture();
  const file = path.join(root, 'evidence', 'expected.json');
  const w = metrics(path.join(root, 'evidence'), '--write', file);
  assert.equal(w.status, 0, w.stderr);
  const bytes = fs.readFileSync(file);
  assert.notDeepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
  assert.notEqual(bytes[0], 0xef);
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), JSON.parse(w.stdout));
  assert.equal(metrics(path.join(root, 'evidence'), '--check').status, 0);
  assert.equal(metrics(path.join(root, 'evidence'), '--write').status, 64);
});
