'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { main: makeTickScenario } = require('./fixtures/make-tick-scenario.js');

const SCRIPTS = path.join(__dirname, '..', 'skills', 'upstream-report-perf', 'scripts');
const CLI = path.join(SCRIPTS, 'health-metrics.js');
const SAMPLER = path.join(SCRIPTS, 'tick-sampler.js');
const tmp = () => require('./fixtures/tmp.js').mk('tick-test-');
const metrics = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.parse('2026-11-18T20:00:00.000Z');

// An evidence dir with only tick-health/: files maps a samples name to its records.
function evidence(runs, files, subsystem = 'fighter') {
  const ev = tmp();
  fs.mkdirSync(path.join(ev, 'tick-health'));
  fs.writeFileSync(path.join(ev, 'tick-health', 'runs.json'), JSON.stringify(subsystem ? { subsystem, runs } : { runs }));
  for (const [name, rows] of Object.entries(files)) fs.writeFileSync(path.join(ev, 'tick-health', name), jsonl(rows));
  return ev;
}
// Ticks 100 ms apart from `from`, with the given durations and fighter times.
const ticks = (from, durations, sub = [], late = null) => durations.map((d, i) => {
  const r = { kind: 'tick', utc: iso(from + i * 100), tickDurationMs: d, subsystemMs: { 'scene.other': 0.5 } };
  if (sub[i] !== undefined) r.subsystemMs.fighter = sub[i];
  if (late) r.latenessMs = late[i];
  return r;
});
const step = (name, from, ms) => ({ step: name, from: iso(from), to: iso(from + ms) });
const run = (name, side, samples, steps, kind) => ({ run: name, side, samples, steps, ...(kind ? { kind } : {}) });
const out = (ev) => {
  const r = metrics(ev);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout);
};

test('per step: hand-computed nearest-rank stats, subsystem missing counts 0, lateness, pause counts', () => {
  // 10 ticks: 1..9 ms and one 300 ms pause; fighter on 8 of them.
  const d = [1, 2, 3, 4, 5, 6, 7, 8, 9, 300];
  const f = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 250];
  const late = [0, 0, 0, 0, 1, 1, 1, 2, 2, 200];
  const ev = evidence([run('r1', 'before', 'a.jsonl', [step('s', T0, 1000)])], { 'a.jsonl': ticks(T0, d, f, late) });
  const s = out(ev).tick_health.runs.r1.before.s;
  assert.equal(s.ticks, 10);
  assert.equal(s.tick_mean_ms, 34.5);
  assert.equal(s.tick_p50_ms, 5);
  assert.equal(s.tick_p95_ms, 300);
  assert.equal(s.tick_p99_ms, 300);
  assert.equal(s.tick_max_ms, 300);
  // fighter: [0.5,1,1.5,2,2.5,3,3.5,250,0,0] -> sorted 0,0,0.5,...; mean 264/10
  assert.equal(s.sub_mean_ms, 26.4);
  assert.equal(s.sub_p50_ms, 1.5);
  assert.equal(s.sub_max_ms, 250);
  assert.equal(s.late_p50_ms, 1);
  assert.equal(s.late_max_ms, 200);
  assert.equal(s.ticks_ge_100ms, 1);
  assert.equal(s.ticks_ge_250ms, 1);
  assert.equal(s.ticks_ge_250ms_per_min, 60);
});

test('unmeasured keys are left out, not null: no lateness, no samples, no subsystem', () => {
  const ev = evidence([run('r1', 'before', 'a.jsonl', [step('s', T0, 1000)])], { 'a.jsonl': ticks(T0, [1, 2, 3]) }, null);
  const th = out(ev).tick_health;
  const s = th.runs.r1.before.s;
  assert.equal(th.subsystem, undefined);
  for (const k of ['sub_mean_ms', 'late_p99_ms', 'samples', 'loop_delay_mean_ms', 'cpu_mean_pct']) assert.ok(!(k in s), k);
  assert.ok(!JSON.stringify(th).includes('null'));
});

test('health samples give loop delay and CPU per step; [from, to) is half-open', () => {
  const rows = [...ticks(T0, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
    { kind: 'sample', utc: iso(T0 + 500), eventLoopDelayMeanMs: 10, eventLoopDelayMaxMs: 20, cpuPercent: 4 },
    { kind: 'sample', utc: iso(T0 + 900), eventLoopDelayMeanMs: 12, eventLoopDelayMaxMs: 40, cpuPercent: 6 },
    { kind: 'sample', utc: iso(T0 + 1000), eventLoopDelayMeanMs: 99, eventLoopDelayMaxMs: 999, cpuPercent: 99 }];
  const s = out(evidence([run('r1', 'after', 'a.jsonl', [step('s', T0, 1000)])], { 'a.jsonl': rows })).tick_health.runs.r1.after.s;
  assert.equal(s.ticks, 10);
  assert.equal(s.samples, 2);
  assert.equal(s.loop_delay_mean_ms, 11);
  assert.equal(s.loop_delay_max_ms, 40);
  assert.equal(s.cpu_mean_pct, 5);
});

test('repeats: median and spread per side and step; a soak is kept out of them', () => {
  const files = {};
  const runs = [];
  const p50s = { before: [10, 12, 11], after: [5, 7] };
  for (const side of ['before', 'after']) {
    p50s[side].forEach((v, i) => {
      const name = `r${i + 1}-${side}.jsonl`;
      files[name] = ticks(T0, [v, v, v]);
      runs.push(run(`r${i + 1}`, side, name, [step('load', T0, 300)]));
    });
    files[`soak-${side}.jsonl`] = ticks(T0, [100, 100, 100]);
    runs.push(run('soak', side, `soak-${side}.jsonl`, [step('load', T0, 300)], 'soak'));
  }
  const th = out(evidence(runs, files)).tick_health;
  assert.deepEqual(th.repeats.before.load.tick_p50_ms, { median: 11, min: 10, max: 12 });
  assert.deepEqual(th.repeats.after.load.tick_p50_ms, { median: 6, min: 5, max: 7 });
  assert.equal(th.repeats.before.load.runs, 3);
  assert.equal(th.runs.soak.kind, 'soak');
  assert.equal(th.runs.soak.before.load.tick_p99_ms, 100);
});

test('one run per side gives no repeats key', () => {
  const ev = evidence([run('r1', 'before', 'a.jsonl', [step('s', T0, 300)]), run('r1', 'after', 'a.jsonl', [step('s', T0, 300)])], { 'a.jsonl': ticks(T0, [1, 2, 3]) });
  assert.ok(!('repeats' in out(ev).tick_health));
});

test('a step with no ticks is refused (2) naming run, side and step; a missing samples file too', () => {
  let r = metrics(evidence([run('r1', 'before', 'a.jsonl', [step('s', T0 + 3600000, 1000)])], { 'a.jsonl': ticks(T0, [1]) }));
  assert.equal(r.status, 2);
  assert.match(r.stdout, /run "r1" before step "s": no ticks/);
  r = metrics(evidence([run('r1', 'before', 'gone.jsonl', [step('s', T0, 1000)])], {}));
  assert.equal(r.status, 2);
  assert.match(r.stdout, /gone\.jsonl not found/);
});

test('bad runs.json is a usage error (64)', () => {
  const bad = [
    { runs: [] },
    { runs: [run('r1', 'middle', 'a.jsonl', [step('s', T0, 100)])] },
    { runs: [run('r1', 'before', '../a.jsonl', [step('s', T0, 100)])] },
    { runs: [run('r1', 'before', 'a.jsonl', [{ step: 's', from: '2026-11-18T20:00:00', to: '2026-11-18T20:01:00' }])] },
    { runs: [run('r1', 'before', 'a.jsonl', [step('s', T0, 100)], 'long')] },
    { runs: [run('r1', 'before', 'a.jsonl', [step('s', T0, 100)]), run('r1', 'before', 'a.jsonl', [step('s', T0, 100)])] },
  ];
  for (const b of bad) {
    const ev = evidence(b.runs, { 'a.jsonl': ticks(T0, [1]) });
    fs.writeFileSync(path.join(ev, 'tick-health', 'runs.json'), JSON.stringify(b));
    assert.equal(metrics(ev).status, 64, JSON.stringify(b));
  }
});

test('neither windows.json nor tick-health/runs.json is a usage error (64)', () => {
  const r = metrics(tmp());
  assert.equal(r.status, 64);
  assert.match(r.stderr, /windows\.json .* or tick-health\/runs\.json/);
});

test('warns on a subsystem label no tick has, and on a run with one side only', () => {
  const ev = evidence([run('r1', 'before', 'a.jsonl', [step('s', T0, 300)])], { 'a.jsonl': ticks(T0, [1, 2, 3]) }, 'fightr');
  const r = metrics(ev);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /no tick has the subsystem label "fightr"/);
  assert.match(r.stderr, /run "r1" has no after side/);
});

test('--check names the differing tick-health leaf; --write then --check passes', () => {
  const ev = evidence([run('r1', 'before', 'a.jsonl', [step('s', T0, 300)])], { 'a.jsonl': ticks(T0, [1, 2, 3]) });
  assert.equal(metrics(ev, '--write', path.join(ev, 'expected.json')).status, 0);
  assert.equal(metrics(ev, '--check').status, 0);
  const e = JSON.parse(fs.readFileSync(path.join(ev, 'expected.json'), 'utf8'));
  e.tick_health.runs.r1.before.s.tick_p99_ms = 2.5;
  fs.writeFileSync(path.join(ev, 'expected.json'), JSON.stringify(e));
  const r = metrics(ev, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tick_health\.runs\.r1\.before\.s\.tick_p99_ms: expected 2\.5, got 3/);
});

test('the throughput scenario: p50 falls a lot at the top step, the soak p99 barely moves', () => {
  const s = tmp();
  makeTickScenario(s);
  const ev = tmp();
  fs.mkdirSync(path.join(ev, 'tick-health'));
  const runs = [];
  let cur = null;
  for (const line of fs.readFileSync(path.join(s, 'steps.txt'), 'utf8').split('\n')) {
    let m = /^(r\d|soak) (before|after):/.exec(line);
    if (m) {
      cur = run(m[1], m[2], `${m[1]}-${m[2]}.jsonl`, [], m[1] === 'soak' ? 'soak' : undefined);
      runs.push(cur);
      fs.copyFileSync(path.join(s, 'ticks', cur.samples), path.join(ev, 'tick-health', cur.samples));
      continue;
    }
    m = /^\s+(\S+): (\S+) to (\S+)/.exec(line);
    if (m && cur) cur.steps.push({ step: m[1], from: m[2], to: m[3] });
  }
  fs.writeFileSync(path.join(ev, 'tick-health', 'runs.json'), JSON.stringify({ subsystem: 'fighter', runs }));
  const th = out(ev).tick_health;
  assert.equal(th.repeats.before['load-100'].runs, 3);
  assert.ok(th.repeats.after['load-100'].tick_p50_ms.median < th.repeats.before['load-100'].tick_p50_ms.median * 0.65);
  const soak = th.runs.soak;
  assert.equal(soak.before['load-100'].ticks, 3000);
  assert.ok(soak.after['load-100'].tick_p99_ms > soak.before['load-100'].tick_p99_ms * 0.9);
  assert.equal(soak.before['load-100'].ticks_ge_250ms, soak.after['load-100'].ticks_ge_250ms);
  // the after repeats' idle step has one run with ~30 ms ticks
  assert.ok(th.repeats.after.idle.tick_p99_ms.max > 30);
});

test('tick-sampler: does nothing without EVEJS_TICK_SAMPLES; with it, writes ticks and samples once each', () => {
  const d = tmp();
  const src = path.join(d, 'server', 'src');
  fs.mkdirSync(path.join(src, 'space'), { recursive: true });
  fs.mkdirSync(path.join(src, 'utils'), { recursive: true });
  // Fake upstream modules with the same exported shape.
  fs.writeFileSync(path.join(src, 'space', 'runtime.js'), `
    const { performance } = require('node:perf_hooks');
    const r = { _recentTickSummaries: [] };
    let n = 0;
    setInterval(() => {
      r._recentTickSummaries.push({ startedAtMonotonicMs: performance.now(), tickDurationMs: 1.234 + n, latenessMs: 0.5, subsystemMs: { fighter: 0.75, x: 'bad' } });
      if (r._recentTickSummaries.length > 120) r._recentTickSummaries.shift();
      n++;
    }, 20).unref();
    module.exports = r;`);
  fs.writeFileSync(path.join(src, 'utils', 'serverHealthMonitor.js'), `
    const history = [];
    setInterval(() => history.push({ atMs: Date.now(), eventLoopDelayMeanMs: 10.1, eventLoopDelayP99Ms: 10.2, eventLoopDelayMaxMs: 11, cpuPercent: 3.3 }), 50).unref();
    const m = { isRunning: () => true, getSnapshot: () => ({ history: history.slice() }) };
    module.exports = { getServerHealthMonitor: () => m };`);
  const main = path.join(d, 'main.js');
  fs.writeFileSync(main, `require('./server/src/space/runtime.js'); require('./server/src/utils/serverHealthMonitor.js'); setTimeout(() => {}, 700);`);
  const outFile = path.join(d, 'out.jsonl');
  const env = { ...process.env, EVEJS_TICK_SAMPLES_POLL_MS: '100' };
  delete env.EVEJS_TICK_SAMPLES;
  let r = spawnSync(process.execPath, ['--require', SAMPLER, main], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(outFile));
  r = spawnSync(process.execPath, ['--require', SAMPLER, main], { encoding: 'utf8', env: { ...env, EVEJS_TICK_SAMPLES: outFile } });
  assert.equal(r.status, 0, r.stderr);
  const rows = fs.readFileSync(outFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows[0].kind, 'start');
  const t = rows.filter((x) => x.kind === 'tick');
  const smp = rows.filter((x) => x.kind === 'sample');
  assert.ok(t.length >= 10, `ticks ${t.length}`);
  assert.ok(smp.length >= 5, `samples ${smp.length}`);
  assert.equal(new Set(t.map((x) => x.utc)).size, t.length, 'no tick written twice');
  assert.equal(new Set(smp.map((x) => x.utc)).size, smp.length, 'no sample written twice');
  assert.equal(t[0].tickDurationMs, 1.23);
  assert.deepEqual(t[0].subsystemMs, { fighter: 0.75 });
  assert.ok(Math.abs(Date.parse(t[0].utc) - Date.now()) < 60000);
  assert.equal(smp[0].cpuPercent, 3.3);
});
