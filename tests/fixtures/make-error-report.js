#!/usr/bin/env node
'use strict';
// Writes a made-up zip in the layout of upstream's error report (output format only; no upstream
// code is copied). Usage:
//   node make-error-report.js <out.zip> [--schema <s>] [--health <jsonl>] [--profile] [--events <jsonl>] [--close-watch <dir>] [--close-watch-url <url>] [--cpu-profiles <n>] [--anchor <iso>]
const fs = require('node:fs');
const path = require('node:path');
const { writeZip } = require('../../skills/upstream-report/scripts/lib/zip.js');

const PROFILE_FILES = [
  'logs/tick-profiles/2026-11-18T16-21-04-232Z-812ms.cpuprofile',
  'logs/tick-profiles/2026-11-18T16-24-10-500Z-1420ms.cpuprofile',
];

// Record shapes follow what upstream's Close Watch writes: every record has a `time`, `startedBy` is
// a numeric character ID, and a cpuCapture carries the tick match and window summary.
const iso = (ms) => new Date(ms).toISOString();
const captureRecord = (atMs, durationMs, profileFile) => ({
  time: iso(atMs + 50),
  event: 'cpuCapture',
  atMs,
  durationMs,
  partial: false,
  tick: null,
  sampleCount: 2,
  sampledMs: 1,
  gcMs: 0,
  idleMs: 0,
  programMs: 0,
  selfFunctions: [],
  totalFunctions: [],
  stacks: [],
  profileFile,
});
const DEFAULT_HEALTH = [
  { time: iso(1763482800000), event: 'closeWatchStarted', minutes: 15, startedBy: 90000001 },
  captureRecord(1763482864232, 812, PROFILE_FILES[0]),
  captureRecord(1763483050500, 1420, PROFILE_FILES[1]),
  { time: iso(1763483700000), event: 'closeWatchEnded', reason: 'timeout', stallCount: 2 },
].map((r) => JSON.stringify(r)).join('\n') + '\n';

function cpuProfile(url) {
  return JSON.stringify({
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1 }, children: [2] },
      { id: 2, callFrame: { functionName: 'tick', url, lineNumber: 10, columnNumber: 4 } },
    ],
    startTime: 0,
    endTime: 1000,
    samples: [2, 2],
    timeDeltas: [500, 500],
  });
}

function healthProfileFiles(health) {
  const out = [];
  for (const line of health.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const r = JSON.parse(line);
      if (r.event === 'cpuCapture' && r.profileFile) out.push(r.profileFile);
    } catch (e) { /* not JSON */ }
  }
  return out;
}

function makeErrorReport(outZip, { schema = 'evejs-error-report/1', health = DEFAULT_HEALTH, profile = false, events = null, closeWatch = null, closeWatchUrl = null, cpuProfiles = 1, anchor = '2026-11-18T16:59:00.000Z', extra = [] } = {}) {
  const anchorMs = Date.parse(anchor);
  const manifest = {
    schema,
    generatedAt: iso(anchorMs + 60000),
    versions: { evejsVersion: 'EveJS 000000.1', configSchemaVersion: 1, packageJsonVersion: '0.0.1' },
    git: null,
    system: { node: 'v24.0.0', platform: 'win32', osRelease: '10.0.0', arch: 'x64', cpuModel: 'Made-up CPU', cpuCount: 8, totalMemMb: 16384, freeMemMb: 8000, diskFreeMb: 100000, inContainer: false },
    window: { hours: 6, anchor: iso(anchorMs), from: iso(anchorMs - 6 * 3600000) },
    logs: {
      dir: 'C:\\Users\\Sam\\EveJS\\logs',
      exists: true,
      totalFilesInDir: 2,
      included: [{ zipPath: 'server-logs/server.log', bytes: 120, includedBytes: 120, truncated: false }],
      skipped: [],
    },
    config: { included: ['config/server.json'], clientConfigIncluded: false },
    errorSummary: { errCount: 1, wrnCount: 0, fatalCount: 0, lastErrors: [] },
    note: null,
    profiling: null,
  };
  const text = (name, s) => ({ name, data: Buffer.from(s, 'utf8') });
  const entries = [
    text('manifest.json', JSON.stringify(manifest, null, 2)),
    text('server-logs/server.log', `${iso(anchorMs - 59 * 60000).slice(0, 19)}Z INF server started\n${iso(anchorMs - 59 * 60000 + 5000).slice(0, 19)}Z ERR example failure at C:\\Users\\Sam\\EveJS\\server\\src\\x.js\n`),
    text('server-logs/server-health.log', health),
    text('config/server.json', JSON.stringify({ port: 26000 }, null, 2)),
  ];
  if (profile) {
    entries.push(text('profiling/events.jsonl', events || '{"event":"pause","ms":900}\n'));
    for (let n = 1; n <= cpuProfiles; n++) {
      entries.push(text(`profiling/cpu-${String(n).padStart(3, '0')}.cpuprofile`, cpuProfile('file:///C:/Users/Sam/EveJS/server/src/x.js')));
    }
    // As the collector writes it: dir, then one {zipPath, bytes, truncated} per collected file.
    const included = entries.filter((e) => e.name.startsWith('profiling/')).map((e) => ({ zipPath: e.name, bytes: e.data.length, truncated: false }));
    manifest.profiling = { dir: 'C:\\Users\\Sam\\EveJS\\logs\\pause-profiles\\run1', included, totalBytes: included.reduce((n, f) => n + f.bytes, 0) };
    entries[0] = text('manifest.json', JSON.stringify(manifest, null, 2));
  }
  entries.push(...extra); // [{ name, data: Buffer }]
  writeZip(entries, outZip);
  if (closeWatch) {
    fs.mkdirSync(closeWatch, { recursive: true });
    healthProfileFiles(health).forEach((f, i) => {
      const url = closeWatchUrl || (i === 0 ? 'file:///home/sam/evejs/server/src/space/tick.js' : 'file:///opt/evejs/server/src/space/tick.js');
      fs.writeFileSync(path.join(closeWatch, path.basename(f)), cpuProfile(url));
    });
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opts = {};
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--schema') opts.schema = argv[++i];
    else if (a === '--health') opts.health = fs.readFileSync(argv[++i], 'utf8');
    else if (a === '--profile') opts.profile = true;
    else if (a === '--events') opts.events = fs.readFileSync(argv[++i], 'utf8');
    else if (a === '--close-watch') opts.closeWatch = argv[++i];
    else if (a === '--close-watch-url') opts.closeWatchUrl = argv[++i];
    else if (a === '--cpu-profiles') opts.cpuProfiles = Number(argv[++i]);
    else if (a === '--anchor') opts.anchor = argv[++i];
    else if (!out) out = a;
    else { console.error(`unexpected argument: ${a}`); process.exit(64); }
  }
  if (!out) { console.error('usage: node make-error-report.js <out.zip> [--schema <s>] [--health <jsonl>] [--profile] [--events <jsonl>] [--close-watch <dir>] [--close-watch-url <url>] [--cpu-profiles <n>] [--anchor <iso>]'); process.exit(64); }
  makeErrorReport(out, opts);
}

module.exports = { makeErrorReport };
