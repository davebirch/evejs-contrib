#!/usr/bin/env node
'use strict';
// Writes the two sides of the performance scenario (made-up data): <scratch>/before-report.zip (with
// profiling/), <scratch>/after-report.zip (without), <scratch>/before-profiles and <scratch>/after-profiles
// (Close Watch .cpuprofile files; one before profile has "rotated out"). Usage: node make-perf-scenario.js <scratch>
const fs = require('node:fs');
const path = require('node:path');
const { makeErrorReport } = require('./make-error-report.js');

const FRAME_URL = 'file:///C:/Users/Sam/EveJS/server/src/space/tick.js';
const BEFORE_FROM = Date.parse('2026-11-18T16:00:00.000Z');
const AFTER_FROM = Date.parse('2026-11-18T18:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const stamp = (ms) => iso(ms).replace(/[:.]/g, '-');

function side(from, { name, startedBy, captures, recovered }) {
  const rows = [{ time: iso(from + 1000), event: 'closeWatchStarted', minutes: 59, startedBy }];
  const files = [];
  captures.forEach((durationMs, i) => {
    const atMs = from + (i + 1) * 420000;
    const profileFile = `logs/tick-profiles/${stamp(atMs)}-${durationMs}ms.cpuprofile`;
    files.push(profileFile);
    rows.push({
      time: iso(atMs + durationMs + 50), event: 'cpuCapture', atMs, durationMs, partial: false, tick: null,
      sampleCount: 2, sampledMs: 1, gcMs: 0, idleMs: 0, programMs: 0, selfFunctions: [], totalFunctions: [], stacks: [], profileFile,
    });
  });
  recovered.forEach(([status, ms], i) => {
    rows.push({ time: iso(from + 600000 + i * 300000), event: 'recovered', worstStatus: status, subsystemMs: { 'fleet.tick': ms, 'space.tick': ms / 2 } });
  });
  rows.push({ time: iso(from + 3541000), event: 'closeWatchEnded', reason: 'time up', stallCount: captures.length });
  rows.sort((a, b) => (a.time < b.time ? -1 : 1));
  // Log line carrying the planted character name, as in a real server-health log.
  return { health: `2026-11-18T${iso(from).slice(11, 19)}Z INF [Session 7 user=acct_zq(1001) char=${name}(90000001)] logged in\n` + jsonl(rows), files };
}

function main(scratch) {
  fs.mkdirSync(scratch, { recursive: true });
  const before = side(BEFORE_FROM, {
    name: 'Zephyra Quill',
    startedBy: 'Zephyra Quill',
    captures: [812, 1420, 2300, 3100],
    recovered: [['stalled', 900], ['stalled', 1500], ['degraded', 400]],
  });
  const after = side(AFTER_FROM, {
    name: 'Zephyra Quill',
    startedBy: 90000001,
    captures: [310],
    recovered: [['degraded', 150]],
  });
  // events.jsonl as upstream's pause profiler writes it: a `start` record (timeOriginUnixMs), `cpu-profile`
  // records naming each cpu-NNN.cpuprofile with its [startMonoMs, endMonoMs] segment, and `stall` records
  // whose [intervalStartMonoMs, intervalEndMonoMs] falls inside one segment (mono ms since the server started).
  // The made-up server started at BEFORE_FROM; segments are 20 minutes (upstream's default is one minute).
  const SEGMENT = 1200000;
  const stall = (startMs, lagMs) => {
    const gapMs = 1000 + lagMs;
    return { type: 'stall', utc: iso(BEFORE_FROM + startMs + gapMs), monoMs: startMs + gapMs, intervalStartMonoMs: startMs, intervalEndMonoMs: startMs + gapMs, gapMs, lagMs };
  };
  const events = jsonl([
    { type: 'start', utc: iso(BEFORE_FROM), monoMs: 0, schemaVersion: 1, timeOriginUnixMs: BEFORE_FROM, sampleMs: 1000, segmentMs: SEGMENT },
    stall(600000, 1200), stall(1500000, 2400), stall(2700000, 3100), stall(3000000, 800),
    ...[1, 2, 3].map((n) => ({ type: 'cpu-profile', utc: iso(BEFORE_FROM + n * SEGMENT), monoMs: n * SEGMENT + 20, file: `cpu-${String(n).padStart(3, '0')}.cpuprofile`, startMonoMs: (n - 1) * SEGMENT, endMonoMs: n * SEGMENT, v8StartUs: (n - 1) * SEGMENT * 1000, v8EndUs: n * SEGMENT * 1000 })),
  ]);
  makeErrorReport(path.join(scratch, 'before-report.zip'), {
    health: before.health, anchor: iso(BEFORE_FROM + 3542000), profile: true, events,
    cpuProfiles: 3,
    closeWatch: path.join(scratch, 'before-profiles'), closeWatchUrl: FRAME_URL,
  });
  makeErrorReport(path.join(scratch, 'after-report.zip'), {
    health: after.health, anchor: iso(AFTER_FROM + 3542000),
    closeWatch: path.join(scratch, 'after-profiles'), closeWatchUrl: FRAME_URL,
  });
  // The oldest before profile rotated out of the server's profile folder before collection.
  fs.rmSync(path.join(scratch, 'before-profiles', path.basename(before.files[0])));
}

if (require.main === module) {
  if (!process.argv[2]) { console.error('usage: node make-perf-scenario.js <scratch>'); process.exit(64); }
  main(process.argv[2]);
}

module.exports = { main };
