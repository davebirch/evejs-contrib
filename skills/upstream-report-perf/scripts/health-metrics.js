#!/usr/bin/env node
'use strict';
// Before/after metrics over upstream's ingested error reports and tick samples (reads output files only).
//   node health-metrics.js <evidenceDir> [--check] [--write <file>]
//   --write saves the JSON to <file> as UTF-8 (no shell redirection needed; PowerShell 5.1's ">" writes UTF-16).
// <evidenceDir> holds either or both of:
// - windows.json and, per side, <side>/error-report/ (and <side>/close-watch/): the stall metrics, as
//   "before" and "after";
// - tick-health/runs.json and the tick sampler files it names: per-tick health per run and load step, as
//   "tick_health" (the tick-health section below).
// Timing: cpuCapture by its atMs (the capture start; the record is logged after the window ends, falling
// back to `time`), stalls in events.jsonl by their start, utc - gapMs (consistent with atMs), the rest by
// `time`. windows.json from/to must be full ISO date-times with Z or +hh:mm (never local time).
// A cpuCapture without a numeric durationMs still lists its profileFile but isn't in the window stats.
// Warns on stderr when a server-health log was truncated by the collector or has cut JSONL lines.
// Exit 0 ok, 1 --check differs, 2 refused, 64 usage.
const fs = require('node:fs');
const path = require('node:path');

const SIDES = ['before', 'after'];

class Usage extends Error {}
class Refused extends Error {}

const round1 = (x) => Math.round(x * 10) / 10;
const sum = (xs) => round1(xs.reduce((a, b) => a + b, 0));
const p95 = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1] : null);
const max = (xs) => (xs.length ? Math.max(...xs) : null);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function readJsonl(file, dropped) {
  const out = [];
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { out.push(JSON.parse(t)); } catch (e) { if (dropped) dropped.count++; }
  }
  return out;
}

function readWindows(dir) {
  const file = path.join(dir, 'windows.json');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { throw new Usage(`cannot read ${file}: ${e.message}`); }
  const out = {};
  for (const side of SIDES) {
    const w = raw && raw[side];
    const zoned = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v);
    if (w && (!zoned(w.from) || !zoned(w.to))) throw new Usage(`windows.json: "${side}" from/to must be ISO date-times ending in Z or +hh:mm`);
    const from = w && Date.parse(w.from);
    const to = w && Date.parse(w.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Usage(`windows.json: "${side}" needs ISO "from" before "to"`);
    out[side] = { from, to };
  }
  return out;
}

function summarise(dir, side, win) {
  const base = path.join(dir, side);
  if (!fs.existsSync(path.join(base, 'error-report'))) {
    throw new Refused(`evidence/${side}/error-report not found: run add-report`);
  }
  const logs = path.join(base, 'error-report', 'server-logs');
  const healthFiles = fs.existsSync(logs)
    ? fs.readdirSync(logs).filter((n) => /^server-health.*\.log$/.test(n)).sort().map((n) => path.join(logs, n))
    : [];
  const eventsFile = path.join(base, 'error-report', 'profiling', 'events.jsonl');
  const hasEvents = fs.existsSync(eventsFile);
  if (!healthFiles.length && !hasEvents) {
    throw new Refused(`${side}: no health records: was Close Watch or the pause profiler running?`);
  }
  const within = (ms) => Number.isFinite(ms) && ms >= win.from && ms < win.to;

  const warnings = [];
  try {
    const m = JSON.parse(fs.readFileSync(path.join(base, 'error-report', 'manifest.json'), 'utf8').replace(/^\ufeff/, ''));
    for (const f of (m.logs && m.logs.included) || []) {
      if (f && f.truncated && /(^|\/)server-health[^/]*\.log$/.test(String(f.zipPath))) warnings.push(`${side}: ${f.zipPath} was truncated by the collector; early records may be missing`);
    }
  } catch (e) { /* no readable manifest: nothing to warn about */ }

  const captures = [];
  const recovered = [];
  const dropped = { count: 0 };
  for (const f of healthFiles) {
    for (const r of readJsonl(f, dropped)) {
      if (r.event === 'cpuCapture') {
        // Logged after its window ends, so time it by atMs (fall back to the log time).
        if (within(isNum(r.atMs) ? r.atMs : Date.parse(r.time))) captures.push(r);
      } else if (r.event === 'recovered' && within(Date.parse(r.time))) {
        recovered.push(r);
      }
    }
  }
  if (dropped.count) warnings.push(`${side}: dropped ${dropped.count} unparseable JSON line(s) in server-health logs (cut off?)`);
  const durations = captures.map((r) => r.durationMs).filter(isNum);
  const byStatus = {};
  let subsystem = 0;
  for (const r of recovered) {
    const status = r.worstStatus || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
    for (const v of Object.values(r.subsystemMs || {})) if (isNum(v)) subsystem += v;
  }
  const profileNames = [...new Set(captures.filter((r) => typeof r.profileFile === 'string' && r.profileFile).map((r) => path.posix.basename(r.profileFile.replace(/\\/g, '/'))))].sort();
  const cwDir = path.join(base, 'close-watch');
  const have = fs.existsSync(cwDir) ? new Set(fs.readdirSync(cwDir)) : new Set();

  let stalls = null;
  let lags = null;
  if (hasEvents) {
    const evDropped = { count: 0 };
    lags = readJsonl(eventsFile, evDropped)
      .filter((r) => r.type === 'stall' && isNum(r.lagMs) && within(Date.parse(r.utc) - (isNum(r.gapMs) ? r.gapMs : 0)))
      .map((r) => r.lagMs);
    if (evDropped.count) warnings.push(`${side}: dropped ${evDropped.count} unparseable JSON line(s) in profiling/events.jsonl (cut off?)`);
    stalls = lags.length;
  }
  for (const w of warnings) console.error(`warning: ${w}`);
  return {
    windows: durations.length,
    window_total_ms: sum(durations),
    window_p95_ms: p95(durations),
    window_max_ms: max(durations),
    windows_ge_2s: durations.filter((d) => d >= 2000).length,
    incidents_by_status: Object.fromEntries(Object.entries(byStatus).sort(([a], [b]) => (a < b ? -1 : 1))),
    incident_subsystem_ms: round1(subsystem),
    stalls,
    stall_lag_total_ms: lags && sum(lags),
    stall_lag_p95_ms: lags && p95(lags),
    stall_lag_max_ms: lags && max(lags),
    profiles: profileNames,
    profiles_missing: profileNames.filter((n) => !have.has(n)),
  };
}

// ---- Tick health ---------------------------------------------------------------------------------------
// tick-health/runs.json: {"subsystem": "<tick breakdown label>" (optional), "runs": [{"run": "r1",
// "side": "before", "kind": "repeat" | "soak" (default "repeat"), "samples": "<file in tick-health/>",
// "steps": [{"step": "idle", "from": "<ISO Z>", "to": "<ISO Z>"}, ...]}, ...]}.
// A samples file is JSONL as tick-sampler.js writes it: {"kind":"tick","utc",tickDurationMs,latenessMs,
// subsystemMs} per space tick (upstream's own tick summary fields) and {"kind":"sample","utc",
// eventLoopDelayMeanMs,eventLoopDelayMaxMs,cpuPercent} per health sample (upstream's monitor fields).
// A record belongs to a step when from <= utc < to. Per run, side and step: whole tick and subsystem
// mean/p50/p95/p99/max (nearest rank; a tick without the subsystem's label counts 0 ms, as upstream
// leaves zero labels out), lateness, ticks of 100 ms or more and 250 ms or more (and per minute), event
// loop delay and CPU from the samples. Keys a run did not measure are left out, never null. Across the
// repeats of a side (kind "repeat", 2 or more runs with that step): each stat's median, min and max.
const round2 = (x) => Math.round(x * 100) / 100;
const nearest = (sorted, q) => sorted[Math.ceil(sorted.length * q) - 1];
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function dist(prefix, xs, out) {
  const s = [...xs].sort((a, b) => a - b);
  out[`${prefix}_mean_ms`] = round2(mean(s));
  out[`${prefix}_p50_ms`] = round2(nearest(s, 0.5));
  out[`${prefix}_p95_ms`] = round2(nearest(s, 0.95));
  out[`${prefix}_p99_ms`] = round2(nearest(s, 0.99));
  out[`${prefix}_max_ms`] = round2(s[s.length - 1]);
}
const zonedIso = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v);

function readRuns(thDir) {
  const file = path.join(thDir, 'runs.json');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { throw new Usage(`cannot read ${file}: ${e.message}`); }
  const bad = (m) => { throw new Usage(`tick-health/runs.json: ${m}`); };
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.runs) || !raw.runs.length) bad('needs a non-empty "runs" list');
  if (raw.subsystem !== undefined && (typeof raw.subsystem !== 'string' || !raw.subsystem)) bad('"subsystem" must be a tick breakdown label');
  const seen = new Set();
  const runs = raw.runs.map((r, i) => {
    const at = `runs[${i}]`;
    if (!r || typeof r.run !== 'string' || !/^[\w.-]+$/.test(r.run)) bad(`${at}: "run" must be a name of letters, digits, . _ or -`);
    if (!SIDES.includes(r.side)) bad(`${at}: "side" must be "before" or "after"`);
    const kind = r.kind === undefined ? 'repeat' : r.kind;
    if (kind !== 'repeat' && kind !== 'soak') bad(`${at}: "kind" must be "repeat" or "soak"`);
    if (seen.has(`${r.run}/${r.side}`)) bad(`${at}: run "${r.run}" has two "${r.side}" entries`);
    seen.add(`${r.run}/${r.side}`);
    if (typeof r.samples !== 'string' || !r.samples || path.isAbsolute(r.samples) || r.samples.split(/[\\/]/).includes('..')) bad(`${at}: "samples" must be a file name inside tick-health/`);
    if (!Array.isArray(r.steps) || !r.steps.length) bad(`${at}: needs a non-empty "steps" list`);
    const names = new Set();
    const steps = r.steps.map((s, j) => {
      if (!s || typeof s.step !== 'string' || !s.step) bad(`${at}.steps[${j}]: needs a "step" name`);
      if (names.has(s.step)) bad(`${at}: step "${s.step}" appears twice`);
      names.add(s.step);
      if (!zonedIso(s.from) || !zonedIso(s.to)) bad(`${at}.steps[${j}]: from/to must be ISO date-times ending in Z or +hh:mm`);
      const from = Date.parse(s.from);
      const to = Date.parse(s.to);
      if (!(to > from)) bad(`${at}.steps[${j}]: "from" must be before "to"`);
      return { step: s.step, from, to };
    });
    return { run: r.run, side: r.side, kind, samples: r.samples, steps };
  });
  return { subsystem: raw.subsystem || null, runs };
}

function stepStats(ticks, samples, step, subsystem) {
  const out = { ticks: ticks.length };
  dist('tick', ticks.map((t) => t.tickDurationMs), out);
  if (subsystem) {
    dist('sub', ticks.map((t) => (t.subsystemMs && isNum(t.subsystemMs[subsystem]) ? t.subsystemMs[subsystem] : 0)), out);
  }
  const late = ticks.map((t) => t.latenessMs).filter(isNum);
  if (late.length === ticks.length) {
    const s = [...late].sort((a, b) => a - b);
    out.late_p50_ms = round2(nearest(s, 0.5));
    out.late_p99_ms = round2(nearest(s, 0.99));
    out.late_max_ms = round2(s[s.length - 1]);
  }
  const minutes = (step.to - step.from) / 60000;
  for (const limit of [100, 250]) {
    const n = ticks.filter((t) => t.tickDurationMs >= limit).length;
    out[`ticks_ge_${limit}ms`] = n;
    out[`ticks_ge_${limit}ms_per_min`] = round2(n / minutes);
  }
  const loopMean = samples.map((r) => r.eventLoopDelayMeanMs).filter(isNum);
  const loopMax = samples.map((r) => r.eventLoopDelayMaxMs).filter(isNum);
  const cpu = samples.map((r) => r.cpuPercent).filter(isNum);
  if (samples.length) out.samples = samples.length;
  if (loopMean.length) out.loop_delay_mean_ms = round2(mean(loopMean));
  if (loopMax.length) out.loop_delay_max_ms = round2(Math.max(...loopMax));
  if (cpu.length) out.cpu_mean_pct = round2(mean(cpu));
  return out;
}

function tickHealth(thDir) {
  const { subsystem, runs } = readRuns(thDir);
  const warnings = [];
  const result = { subsystem: subsystem || undefined, runs: {}, repeats: {} };
  if (!subsystem) delete result.subsystem;
  let subsystemSeen = false;
  for (const r of runs) {
    const file = path.join(thDir, r.samples);
    if (!fs.existsSync(file)) throw new Refused(`tick-health/${r.samples} not found (run "${r.run}", ${r.side})`);
    const dropped = { count: 0 };
    const recs = readJsonl(file, dropped);
    if (dropped.count) warnings.push(`tick-health/${r.samples}: dropped ${dropped.count} unparseable JSON line(s) (cut off?)`);
    const ticks = recs.filter((x) => x.kind === 'tick' && isNum(x.tickDurationMs) && Number.isFinite(Date.parse(x.utc)));
    const samples = recs.filter((x) => x.kind === 'sample' && Number.isFinite(Date.parse(x.utc)));
    if (subsystem && ticks.some((t) => t.subsystemMs && isNum(t.subsystemMs[subsystem]))) subsystemSeen = true;
    const run = (result.runs[r.run] = result.runs[r.run] || {});
    if (r.kind === 'soak') run.kind = 'soak';
    run[r.side] = {};
    for (const step of r.steps) {
      const inStep = (x) => { const t = Date.parse(x.utc); return t >= step.from && t < step.to; };
      const st = ticks.filter(inStep);
      if (!st.length) throw new Refused(`run "${r.run}" ${r.side} step "${step.step}": no ticks between its from and to (check the UTC times and the samples file)`);
      run[r.side][step.step] = stepStats(st, samples.filter(inStep), step, subsystem);
    }
  }
  if (subsystem && !subsystemSeen) warnings.push(`no tick has the subsystem label "${subsystem}": check the spelling against the tick breakdown (sub_* are all 0)`);
  for (const [name, run] of Object.entries(result.runs)) {
    for (const side of SIDES) if (!run[side]) warnings.push(`run "${name}" has no ${side} side`);
  }
  // Across repeats: per side and step, each stat's median and spread.
  for (const side of SIDES) {
    const bySide = Object.values(result.runs).filter((run) => run.kind !== 'soak' && run[side]).map((run) => run[side]);
    const steps = [...new Set(bySide.flatMap((s) => Object.keys(s)))];
    for (const step of steps) {
      const reps = bySide.map((s) => s[step]).filter(Boolean);
      if (reps.length < 2) continue;
      const agg = { runs: reps.length };
      for (const key of Object.keys(reps[0])) {
        if (key === 'ticks' || key === 'samples') continue;
        const vs = reps.map((x) => x[key]);
        if (!vs.every(isNum)) continue;
        agg[key] = { median: round2(median(vs)), min: Math.min(...vs), max: Math.max(...vs) };
      }
      (result.repeats[side] = result.repeats[side] || {})[step] = agg;
    }
  }
  if (!Object.keys(result.repeats).length) delete result.repeats;
  return { result, warnings };
}

const canon = (v) => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const show = (v) => (v === undefined ? '(missing)' : JSON.stringify(v));
// Leaf by leaf, so a difference names its full path (tick_health.runs.r1.before.idle.tick_p99_ms).
function diffFields(prefix, expected, got, out) {
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(expected) || !isObj(got)) {
    if (JSON.stringify(canon(expected)) !== JSON.stringify(canon(got)) || (expected === undefined) !== (got === undefined)) {
      out.push(`${prefix}: expected ${show(expected)}, got ${show(got)}`);
    }
    return;
  }
  for (const k of new Set([...Object.keys(expected), ...Object.keys(got)])) diffFields(`${prefix}.${k}`, expected[k], got[k], out);
}

function main(argv) {
  const USAGE = 'usage: node health-metrics.js <evidenceDir> [--check] [--write <file>]';
  const pos = [];
  let check = false;
  let writeTo = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') check = true;
    else if (a === '--write') {
      if (i + 1 >= argv.length) throw new Usage('--write needs a file');
      writeTo = argv[++i];
    } else if (a.startsWith('--')) throw new Usage(USAGE);
    else pos.push(a);
  }
  if (pos.length !== 1) throw new Usage(USAGE);
  const dir = pos[0];
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Usage(`no such folder: ${dir}`);
  const hasWindows = fs.existsSync(path.join(dir, 'windows.json'));
  const runsFile = path.join(dir, 'tick-health', 'runs.json');
  const hasTicks = fs.existsSync(runsFile);
  if (!hasWindows && !hasTicks) throw new Usage(`${dir}: needs windows.json (stall metrics) or tick-health/runs.json (tick health)`);
  const result = {};
  const refusals = [];
  if (hasWindows) {
    const windows = readWindows(dir);
    for (const side of SIDES) {
      try { result[side] = summarise(dir, side, windows[side]); } catch (e) {
        if (!(e instanceof Refused)) throw e;
        refusals.push(e.message);
      }
    }
  }
  if (hasTicks) {
    try {
      const th = tickHealth(path.join(dir, 'tick-health'));
      for (const w of th.warnings) console.error(`warning: ${w}`);
      result.tick_health = th.result;
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      refusals.push(e.message);
    }
  }
  if (refusals.length) {
    for (const m of refusals) console.log(`refusing: ${m}`);
    return 2;
  }
  const json = JSON.stringify(result, null, 2);
  console.log(json);
  if (writeTo) fs.writeFileSync(writeTo, json + '\n');
  if (!check) return 0;
  const file = path.join(dir, 'expected.json');
  let expected;
  try { expected = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { throw new Usage(`cannot read ${file}: ${e.message}`); }
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Usage(`${file}: expected an object with before and after, or tick_health`);
  const diffs = [];
  for (const key of new Set([...Object.keys(expected), ...Object.keys(result)])) diffFields(key, expected[key], result[key], diffs);
  if (diffs.length) {
    for (const d of diffs) console.error(`differs: ${d}`);
    return 1;
  }
  console.error('check: matches expected.json');
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof Usage)) throw e;
  console.error(e.message);
  process.exitCode = 64;
}
