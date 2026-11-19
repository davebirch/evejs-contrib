#!/usr/bin/env node
'use strict';
// Before/after metrics over upstream's ingested error reports (reads output files only).
//   node health-metrics.js <evidenceDir> [--check] [--write <file>]
//   --write saves the JSON to <file> as UTF-8 (no shell redirection needed; PowerShell 5.1's ">" writes UTF-16).
// <evidenceDir> holds windows.json and, per side, <side>/error-report/ (and <side>/close-watch/).
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

const canon = (v) => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const show = (v) => (v === undefined ? '(missing)' : JSON.stringify(v));
function diffFields(prefix, expected, got, out) {
  const keys = new Set([...Object.keys(expected || {}), ...Object.keys(got || {})]);
  for (const k of keys) {
    const e = expected && expected[k];
    const g = got && got[k];
    if (JSON.stringify(canon(e)) !== JSON.stringify(canon(g)) || (e === undefined) !== (g === undefined)) {
      out.push(`${prefix}.${k}: expected ${show(e)}, got ${show(g)}`);
    }
  }
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
  const windows = readWindows(dir);
  const result = {};
  const refusals = [];
  for (const side of SIDES) {
    try { result[side] = summarise(dir, side, windows[side]); } catch (e) {
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
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Usage(`${file}: expected an object with before and after`);
  const diffs = [];
  for (const side of SIDES) diffFields(side, expected[side], result[side], diffs);
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
