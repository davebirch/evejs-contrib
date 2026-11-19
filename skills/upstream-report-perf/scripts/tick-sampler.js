'use strict';
// Records the EveJS server's own per-tick health to a JSONL file, for health-metrics.js's tick-health
// section. It reads only what upstream already keeps in memory and changes nothing:
// - the space runtime's `_recentTickSummaries` (the last 120 tick summaries: tickDurationMs, latenessMs and
//   the per-subsystem self-time breakdown subsystemMs, as /health shows it);
// - the server health monitor's sample history (getSnapshot().history, one a second: event-loop delay
//   and CPU %), only while the monitor runs (upstream starts it at boot).
// Load it into the server process with Node's --require, set from outside the server:
//   EVEJS_TICK_SAMPLES=<absolute path of the .jsonl to write>
//   NODE_OPTIONS=--require=<absolute path of this file>
// Without EVEJS_TICK_SAMPLES it does nothing. Each second it finds those modules among the ones the server
// has already loaded (it never loads anything itself), appends the ticks and samples it has not written
// yet, and stops with the process. Lines:
//   {"kind":"start","utc":...,"sampler":1,"pid":...,"node":...}
//   {"kind":"tick","utc":<tick start>,"tickDurationMs","latenessMs","subsystemMs"}
//   {"kind":"sample","utc":<sample time>,"eventLoopDelayMeanMs","eventLoopDelayP99Ms","eventLoopDelayMaxMs","cpuPercent"}
// A tick's utc is its start on the wall clock (performance.timeOrigin + its monotonic start).
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');

const OUT = process.env.EVEJS_TICK_SAMPLES;
const POLL_MS = Number(process.env.EVEJS_TICK_SAMPLES_POLL_MS) || 1000;
const RUNTIME = /[\\/]server[\\/]src[\\/]space[\\/]runtime\.js$/;
const MONITOR = /[\\/]server[\\/]src[\\/]utils[\\/]serverHealthMonitor\.js$/;
const r2 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

function loaded(pattern) {
  for (const [file, mod] of Object.entries(require.cache)) {
    if (pattern.test(file) && mod && mod.loaded) return mod.exports;
  }
  return null;
}

function start() {
  let lastTick = -Infinity;
  let lastSample = -Infinity;
  const write = (lines) => {
    if (!lines.length) return;
    try { fs.appendFileSync(OUT, lines.join('\n') + '\n'); } catch (e) { /* never disturb the server */ }
  };
  write([JSON.stringify({ kind: 'start', utc: new Date().toISOString(), sampler: 1, pid: process.pid, node: process.version })]);
  const poll = () => {
    const lines = [];
    try {
      const runtime = loaded(RUNTIME);
      const recent = runtime && Array.isArray(runtime._recentTickSummaries) ? runtime._recentTickSummaries : [];
      for (const t of recent) {
        const at = Number(t && t.startedAtMonotonicMs);
        if (!Number.isFinite(at) || at <= lastTick) continue;
        lastTick = at;
        const subsystemMs = {};
        for (const [k, v] of Object.entries(t.subsystemMs || {})) if (r2(v) !== null) subsystemMs[k] = r2(v);
        lines.push(JSON.stringify({
          kind: 'tick', utc: new Date(performance.timeOrigin + at).toISOString(),
          tickDurationMs: r2(t.tickDurationMs), latenessMs: r2(t.latenessMs), subsystemMs,
        }));
      }
      const mod = loaded(MONITOR);
      const monitor = mod && typeof mod.getServerHealthMonitor === 'function' ? mod.getServerHealthMonitor() : null;
      const snap = monitor && typeof monitor.isRunning === 'function' && monitor.isRunning() ? monitor.getSnapshot() : null;
      const history = snap && Array.isArray(snap.history) ? snap.history : [];
      for (const s of history) {
        const at = Number(s && s.atMs);
        if (!Number.isFinite(at) || at <= lastSample) continue;
        lastSample = at;
        lines.push(JSON.stringify({
          kind: 'sample', utc: new Date(at).toISOString(), eventLoopDelayMeanMs: s.eventLoopDelayMeanMs,
          eventLoopDelayP99Ms: s.eventLoopDelayP99Ms, eventLoopDelayMaxMs: s.eventLoopDelayMaxMs, cpuPercent: s.cpuPercent,
        }));
      }
    } catch (e) { /* never disturb the server */ }
    write(lines);
  };
  const timer = setInterval(poll, POLL_MS);
  timer.unref();
  process.on('exit', poll);
}

if (OUT) start();
