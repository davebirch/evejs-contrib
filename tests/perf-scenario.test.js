'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { main: makePerfScenario } = require('./fixtures/make-perf-scenario.js');
const { makeErrorReport } = require('./fixtures/make-error-report.js');
const { readZip } = require('../skills/upstream-report/scripts/lib/zip.js');

const SKILLS = path.join(__dirname, '..', 'skills');
const BUNDLE = path.join(SKILLS, 'upstream-report', 'scripts', 'bundle.js');
const METRICS = path.join(SKILLS, 'upstream-report-perf', 'scripts', 'health-metrics.js');
const tmp = () => require('./fixtures/tmp.js').mk('perf-scen-');
const env = { ...process.env, EVEJS_CONTRIB_CONFIG_DIR: tmp() };
const run = (script, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env });

test('make-error-report: closeWatchUrl and cpuProfiles options', () => {
  const d = tmp();
  makeErrorReport(path.join(d, 'r.zip'), { profile: true, cpuProfiles: 3, closeWatch: path.join(d, 'cw'), closeWatchUrl: 'file:///C:/Users/Sam/x.js' });
  const names = readZip(path.join(d, 'r.zip')).map((e) => e.name);
  assert.deepEqual(names.filter((n) => n.startsWith('profiling/cpu-')), ['profiling/cpu-001.cpuprofile', 'profiling/cpu-002.cpuprofile', 'profiling/cpu-003.cpuprofile']);
  for (const f of fs.readdirSync(path.join(d, 'cw'))) {
    assert.match(fs.readFileSync(path.join(d, 'cw', f), 'utf8'), /C:\/Users\/Sam\/x\.js/);
  }
});

test('perf scenario: before has profiling and stalls, after has none; ingest and recompute work', () => {
  const s = tmp();
  makePerfScenario(s);
  const entries = (z) => readZip(path.join(s, z)).map((e) => e.name);
  assert.ok(entries('before-report.zip').some((n) => n.startsWith('profiling/cpu-')));
  assert.ok(!entries('after-report.zip').some((n) => n.startsWith('profiling/')));
  for (const [side, hour] of [['before', '16'], ['after', '18']]) {
    const zip = readZip(path.join(s, `${side}-report.zip`));
    const get = (n) => zip.find((e) => e.name === n).data.toString('utf8');
    const m = JSON.parse(get('manifest.json'));
    assert.match(m.window.anchor, new RegExp(`^2026-11-18T${hour}:`));
    assert.match(m.generatedAt, new RegExp(`^2026-11-18T(${hour}|${Number(hour) + 1}):`));
    assert.match(get('server-logs/server.log'), new RegExp(`^2026-11-18T${hour}:`));
    // Upstream anchors on the newest log mtime, so no log record may be newer than the anchor.
    const stamps = get('server-logs/server.log').match(/^\d{4}-\d\d-\d\dT[\d:.]+Z/gm) || [];
    assert.ok(stamps.length > 0);
    const anchorMs = Date.parse(m.window.anchor);
    assert.ok(stamps.every((t) => Date.parse(t) <= anchorMs), 'record after anchor');
    // The same holds for server-health.log: its last record (closeWatchEnded) must not be newer than the anchor.
    const health = get('server-logs/server-health.log').split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
    assert.ok(health.some((r) => r.event === 'closeWatchEnded'), 'the health log ends its watch');
    assert.ok(health.every((r) => Date.parse(r.time) <= anchorMs), 'health record after anchor');
  }
  assert.equal(fs.readdirSync(path.join(s, 'before-profiles')).length, 3);
  assert.equal(fs.readdirSync(path.join(s, 'after-profiles')).length, 1);

  // The fixture carries upstream's stall -> profile link: every stall sits inside one cpu-profile segment.
  const ev0 = readZip(path.join(s, 'before-report.zip')).find((e) => e.name === 'profiling/events.jsonl').data.toString('utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const segs = ev0.filter((r) => r.type === 'cpu-profile');
  assert.equal(segs.length, 3);
  for (const st of ev0.filter((r) => r.type === 'stall')) {
    const hit = segs.filter((g) => st.intervalStartMonoMs >= g.startMonoMs && st.intervalEndMonoMs <= g.endMonoMs);
    assert.equal(hit.length, 1, `stall at ${st.intervalStartMonoMs} maps to one profile`);
  }

  // The manifest lists the profiling files as the collector does, and Close Watch ends after its last capture
  // (and after the pause-profiler stalls it is compared with).
  const bz = readZip(path.join(s, 'before-report.zip'));
  const pm = JSON.parse(bz.find((e) => e.name === 'manifest.json').data.toString('utf8')).profiling;
  assert.deepEqual(pm.included.map((f) => f.zipPath), bz.map((e) => e.name).filter((n) => n.startsWith('profiling/')));
  const health = bz.find((e) => e.name === 'server-logs/server-health.log').data.toString('utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  const ended = health.find((r) => r.event === 'closeWatchEnded');
  assert.equal(ended.stallCount, health.filter((r) => r.event === 'cpuCapture').length);
  assert.ok(health.filter((r) => r.event === 'cpuCapture').every((r) => r.time <= ended.time));

  const out = path.join(s, 'out');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(s, 'names.txt'), 'Zephyra Quill\n');
  for (const side of ['before', 'after']) {
    let r = run(BUNDLE, 'add-report', out, path.join(s, `${side}-report.zip`), '--as', `evidence/${side}/error-report`, '--names', path.join(s, 'names.txt'), '--no-identity');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    r = run(BUNDLE, 'add-profiles', out, path.join(s, `${side}-profiles`), '--as', `evidence/${side}`, '--names', path.join(s, 'names.txt'), '--no-identity');
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
  const ev = path.join(out, 'evidence');
  fs.writeFileSync(path.join(ev, 'windows.json'), JSON.stringify({
    before: { from: '2026-11-18T16:00:00Z', to: '2026-11-18T17:00:00Z' },
    after: { from: '2026-11-18T18:00:00Z', to: '2026-11-18T19:00:00Z' },
  }));
  const r = run(METRICS, ev);
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(r.stdout);
  assert.equal(m.before.windows, 4);
  assert.equal(m.before.stalls, 4);
  assert.equal(m.before.windows_ge_2s, 2);
  assert.equal(m.before.profiles_missing.length, 1);
  assert.equal(m.after.windows, 1);
  assert.equal(m.after.stalls, null);
  assert.ok(m.after.window_total_ms < m.before.window_total_ms);
  const text = [...fs.readdirSync(ev, { recursive: true })].map((f) => path.join(ev, f)).filter((f) => fs.statSync(f).isFile()).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  assert.ok(!/Zephyra|Users[\\/]Sam/.test(text), 'planted name and home path are redacted');
});
