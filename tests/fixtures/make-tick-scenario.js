#!/usr/bin/env node
'use strict';
// Writes the throughput scenario (made-up data shaped like a real per-tick fix): a fix that makes the
// `fighter` section of each space tick cheaper. The capture follows the recommended design: three short
// repeats per side, alternating before and after (20 s load steps: idle, load-25, load-50, load-100), then
// one 5-minute soak per side at load-100 with Close Watch on. Close Watch's windows are major GC pauses
// the fix does not touch (about the same on both sides); the tick numbers show the result: the whole-tick
// p50 falls a lot while the soak's p99 barely moves. One after repeat's idle step has three ~30 ms ticks
// (an anomaly to explain or list).
//   <scratch>/soak-before-report.zip, soak-after-report.zip   collector zips of the soaks (Close Watch only)
//   <scratch>/soak-before-profiles/, soak-after-profiles/     their Close Watch .cpuprofile files
//   <scratch>/ticks/<run>-<side>.jsonl                        tick-sampler output (r1..r3 and soak)
//   <scratch>/steps.txt                                       the runs' and steps' UTC times, as noted
// Usage: node make-tick-scenario.js <scratch>
const fs = require('node:fs');
const path = require('node:path');
const { makeErrorReport } = require('./make-error-report.js');

const iso = (ms) => new Date(ms).toISOString();
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const stamp = (ms) => iso(ms).replace(/[:.]/g, '-');
const r2 = (x) => Math.round(x * 100) / 100;
const FRAME_URL = 'file:///C:/Users/Sam/EveJS/server/src/space/tick.js';

// Deterministic PRNG (mulberry32), so the fixture is the same on every machine.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// n ascending values whose quantiles follow the knots [min, p50, p95, p99, top] (piecewise linear).
function fromKnots(n, knots) {
  const qs = [0, 0.5, 0.95, 0.99, 1];
  const out = [];
  for (let i = 0; i < n; i++) {
    const q = n === 1 ? 0.5 : i / (n - 1);
    let k = 0;
    while (k < qs.length - 2 && q > qs[k + 1]) k++;
    const f = (q - qs[k]) / (qs[k + 1] - qs[k]);
    out.push(r2(knots[k] + f * (knots[k + 1] - knots[k])));
  }
  return out;
}

// Per step: tick and fighter knots (comonotonic, so tick quantiles hold) and CPU %.
const STEPS = {
  before: {
    idle: { tick: [0.8, 1.5, 2.6, 4.1, 4.7], sub: [0, 0.22, 0.4, 0.42, 0.53], cpu: 4.1 },
    'load-25': { tick: [4.1, 6.3, 9.8, 15.66, 18], sub: [2.1, 3.81, 5.85, 9.23, 10.5], cpu: 9.2 },
    'load-50': { tick: [6.9, 9.34, 14.2, 21.88, 25], sub: [4.0, 6.23, 9.76, 11.66, 13], cpu: 14.3 },
    'load-100': { tick: [12.0, 16.2, 22.0, 30.3, 36], sub: [8.0, 11.75, 15.75, 21.47, 25], cpu: 21.4 },
  },
  after: {
    idle: { tick: [0.8, 1.6, 2.8, 4.2, 4.9], sub: [0, 0.25, 0.4, 0.45, 0.55], cpu: 4.3 },
    'load-25': { tick: [2.9, 4.3, 7.0, 11.0, 13], sub: [0.6, 1.41, 3.1, 5.25, 6], cpu: 7.0 },
    'load-50': { tick: [3.9, 5.6, 9.9, 17.0, 20], sub: [1.1, 2.26, 5.2, 9.49, 11], cpu: 9.4 },
    'load-100': { tick: [6.0, 9.3, 16.0, 28.5, 34], sub: [2.0, 4.16, 8.66, 18.27, 22], cpu: 14.2 },
  },
};
const STEP_ORDER = ['idle', 'load-25', 'load-50', 'load-100'];
const GAP_MS = 5000;

// One step's ticks; spikes are [tickMs, fighterMs] pairs that replace the largest ticks (major GC).
function stepRows(side, step, from, n, rand, { scale = 1, spikes = [], idleBlips = 0 } = {}) {
  const s = STEPS[side][step];
  const sub = fromKnots(n, s.sub.map((v) => v * scale));
  const tick = fromKnots(n, s.tick.map((v) => v * scale));
  spikes.forEach(([t, f], i) => { tick[n - 1 - i] = t; sub[n - 1 - i] = f; });
  for (let i = 0; i < idleBlips; i++) { tick[n - 1 - spikes.length - i] = r2(31 + i * 2.1); sub[n - 1 - spikes.length - i] = r2(29.5 + i * 2.1); }
  const order = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const rows = [];
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const k = order[i];
    const at = from + i * 100;
    const other = Math.max(0, tick[k] - sub[k]);
    const subsystemMs = { 'scene.other': r2(other * 0.6), 'mv.entityLoop': r2(other * 0.4) };
    if (sub[k] > 0) subsystemMs.fighter = sub[k];
    rows.push({ kind: 'tick', utc: iso(at), tickDurationMs: tick[k], latenessMs: r2((prev > 100 ? prev - 100 : 0) + rand() * 1.5), subsystemMs });
    prev = tick[k];
    if (i % 10 === 9) {
      const worst = Math.max(...order.slice(i - 9, i + 1).map((x) => tick[x]));
      rows.push({ kind: 'sample', utc: iso(at + 50), eventLoopDelayMeanMs: 10.4, eventLoopDelayP99Ms: Math.max(10.5, Math.round(worst * 10) / 10), eventLoopDelayMaxMs: Math.max(10.6, Math.round(worst * 10) / 10), cpuPercent: Math.round((s.cpu * scale + (rand() - 0.5)) * 10) / 10 });
    }
  }
  return rows;
}

// A repeat: the four 20 s steps. About one major GC lands per 80 s run, in a step that varies.
function repeatRun(side, from, rand, i) {
  const rows = [{ kind: 'start', utc: iso(from - 3000), sampler: 1 }];
  const steps = [];
  let t = from;
  const scale = 1 + (rand() - 0.5) * 0.12;
  const gcStep = STEP_ORDER[(i + (side === 'after' ? 2 : 1)) % 4];
  for (const step of STEP_ORDER) {
    const spikes = step === gcStep ? [[r2(380 + rand() * 120), r2(step === 'idle' ? 0.4 : 300 + rand() * 80)]] : [];
    rows.push(...stepRows(side, step, t, 200, rand, { scale, spikes, idleBlips: side === 'after' && i === 1 && step === 'idle' ? 3 : 0 }));
    steps.push({ step, from: iso(t), to: iso(t + 20000) });
    t += 20000 + GAP_MS;
  }
  return { rows, steps, to: t };
}

// The soak: 5 minutes at load-100, a major GC about once a minute.
function soakRun(side, from, rand) {
  const gc = side === 'before' ? [[439.57, 414.7], [462.1, 401.3], [418.8, 12.9], [505.2, 470.4], [377.4, 20.1]] : [[480.32, 400.17], [451.6, 15.2], [396.9, 388.4], [512.8, 30.6], [402.2, 377.9]];
  const rows = [{ kind: 'start', utc: iso(from - 3000), sampler: 1 }, ...stepRows(side, 'load-100', from, 3000, rand, { spikes: gc })];
  return { rows, steps: [{ step: 'load-100', from: iso(from), to: iso(from + 300000) }], to: from + 300000 };
}

// Close Watch over the soak: its windows are the major GC pauses, about the same on both sides.
function soakHealth(side, from, to) {
  const windows = side === 'before' ? [399, 583.2, 521, 444, 358, 222.2] : [318, 396, 512.5, 491, 160.2];
  const rows = [{ time: iso(from - 2000), event: 'closeWatchStarted', minutes: 6, startedBy: 90000001 }];
  windows.forEach((durationMs, i) => {
    const atMs = from + 30000 + i * 45000;
    rows.push({
      time: iso(atMs + durationMs + 50), event: 'cpuCapture', atMs, durationMs, partial: false, tick: null,
      sampleCount: 2, sampledMs: 1, gcMs: Math.round(durationMs * 0.92), idleMs: 0, programMs: 0, selfFunctions: [], totalFunctions: [], stacks: [],
      profileFile: `logs/tick-profiles/${stamp(atMs)}-${Math.round(durationMs)}ms.cpuprofile`,
    });
    rows.push({ time: iso(atMs + 1500), event: 'recovered', worstStatus: 'degraded', subsystemMs: { fighter: Math.round(durationMs * 0.6), 'scene.other': Math.round(durationMs * 0.3) } });
  });
  rows.push({ time: iso(to + 1000), event: 'closeWatchEnded', reason: 'time up', stallCount: windows.length });
  rows.sort((a, b) => (a.time < b.time ? -1 : 1));
  return jsonl(rows);
}

function main(scratch) {
  fs.mkdirSync(path.join(scratch, 'ticks'), { recursive: true });
  const rand = rng(20261118);
  const notes = ['Each repeat is one server start; the tick sampler ran in every run. Repeats alternate before and after.'];
  let t = Date.parse('2026-11-18T20:00:00.000Z');
  for (let i = 0; i < 3; i++) {
    for (const side of ['before', 'after']) {
      const run = repeatRun(side, t, rand, i);
      fs.writeFileSync(path.join(scratch, 'ticks', `r${i + 1}-${side}.jsonl`), jsonl(run.rows));
      notes.push(`r${i + 1} ${side}:`, ...run.steps.map((s) => `  ${s.step}: ${s.from} to ${s.to}`));
      t = run.to + 60000;
    }
  }
  notes.push('Soaks: load-100 for 5 minutes, Close Watch on (separate server starts).');
  for (const side of ['before', 'after']) {
    const run = soakRun(side, t, rand);
    fs.writeFileSync(path.join(scratch, 'ticks', `soak-${side}.jsonl`), jsonl(run.rows));
    makeErrorReport(path.join(scratch, `soak-${side}-report.zip`), {
      health: soakHealth(side, t, run.to), anchor: iso(run.to + 30000),
      closeWatch: path.join(scratch, `soak-${side}-profiles`), closeWatchUrl: FRAME_URL,
    });
    notes.push(`soak ${side}: Close Watch window ${iso(t - 5000)} to ${iso(run.to + 5000)}`, ...run.steps.map((s) => `  ${s.step}: ${s.from} to ${s.to}`));
    t = run.to + 120000;
  }
  fs.writeFileSync(path.join(scratch, 'steps.txt'), notes.join('\n') + '\n');
}

if (require.main === module) {
  if (!process.argv[2]) { console.error('usage: node make-tick-scenario.js <scratch>'); process.exit(64); }
  main(process.argv[2]);
}

module.exports = { main, fromKnots };
