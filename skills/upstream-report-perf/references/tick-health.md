# Tick health: capture and recompute

How to measure a fix that changes what each space tick costs, with upstream's own telemetry, so a
reviewer can recompute every number. Read `SKILL.md` first; this holds the detail.

## What upstream records

- **Per tick** (always on): the space runtime keeps its last 120 tick summaries in memory,
  `_recentTickSummaries` (in `server/src/space/runtime.js`). Each has `tickDurationMs` (the whole tick),
  `latenessMs` (how late it started against the 100 ms target) and `subsystemMs`, the tick profiler's
  per-part **self** times (`npc`, `fighter`, `scene.other`, `mv.entityLoop`, ...; a part with no time that
  tick is left out). This is what `/health` and the Server Health window show.
- **Per second** (always on): the server health monitor (`getServerHealthMonitor()`) samples event-loop
  delay (`eventLoopDelayMeanMs`, `eventLoopDelayP99Ms`, `eventLoopDelayMaxMs`), CPU % and memory, and keeps
  five minutes of them (`/health history` lists the latest).
- **Incidents** (`server-health.log`): only `started`, `escalated` and `recovered` records, plus Close
  Watch's `cpuCapture` records. Not every tick or sample, so the log alone can't give tick percentiles.
- **`EVEJS_TICK_PROFILE=1`**: a `[TickProfile]` line in the server log every 100 ticks with each part's
  **inclusive** mean ms per tick. Means only: no percentiles, and the labels nest differently from the
  self times above. Use it to cross-check, not as the evidence.

Nothing upstream writes every tick to disk, so the skill ships `scripts/tick-sampler.js`. It is loaded into
the server process with Node's `--require`, reads those two in-memory histories once a second and appends
them to a JSONL file. It never loads a module, patches a function or changes a setting: it finds the
modules the server already loaded. Its own cost (a few JSON lines a second) is the same on both sides.

```
EVEJS_TICK_SAMPLES=<absolute path>/r1-before.jsonl
NODE_OPTIONS=--require=<absolute path of the plugin>/skills/upstream-report-perf/scripts/tick-sampler.js
```

Set both in the environment that starts the server (PowerShell: `$env:NAME = '...'` before
`StartServer.bat`; Docker: the service's `environment:` with the sampler file mounted into the
container), one file per run. A path with spaces goes in double quotes inside `NODE_OPTIONS`
(`--require "C:\EveJS tools\tick-sampler.js"`). Without `EVEJS_TICK_SAMPLES` it does nothing. `NODE_OPTIONS` reaches every
Node process started from that shell; only the one running the space runtime writes ticks.

## Capture design (the default for a throughput fix)

1. **Clean comparison.** The pristine release against that release plus only the fix and its
   prerequisites, on the same machine, with CPU pinning if the host allows (for example
   `docker run --cpuset-cpus`) and nothing else running.
2. **Short load-step phases, repeated.** One run is an idle control step, then stepped load (say 25, 50
   and 100 of whatever the fix is about), with one step heavier than you expect in normal use; about
   20 s per step. Repeat 3 to 5 times, **alternating** before and after (before, after, before, ...), a
   fresh server start each time. Means and p50s settle within a step; repeats show the run-to-run spread.
3. **One long soak per side at the top load** (for example 5 minutes) for the tail: p99, max and how
   often big pauses come. A 45 s phase at 10 Hz is about 450 ticks, so its p99 rests on 4 or 5 ticks, and
   a major GC lands about once a minute; the soak is where a tail claim comes from.
4. **One CPU profiler per process.** Close Watch and the pause profiler are separate runs (the soak is a
   good place for Close Watch). The tick sampler is not a profiler and can run in every run.
5. **Note it all:** the tick rate (10 Hz unless changed), step lengths, repeats and their order, the load,
   the hardware, and every step's start and end in UTC as it happens.

If the user has fewer runs than this, use what they have and say what is missing; never invent a run.

## tick-health/runs.json

Copy each run's sampler file into `<bundle>/evidence/tick-health/` (no private data in it: numbers,
times and upstream's own part labels), then describe the runs:

```json
{
  "subsystem": "fighter",
  "runs": [
    { "run": "r1", "side": "before", "samples": "r1-before.jsonl",
      "steps": [ { "step": "idle", "from": "2026-11-18T20:00:00Z", "to": "2026-11-18T20:00:20Z" },
                 { "step": "load-100", "from": "2026-11-18T20:00:25Z", "to": "2026-11-18T20:00:45Z" } ] },
    { "run": "r1", "side": "after", "samples": "r1-after.jsonl", "steps": [ ... ] },
    { "run": "soak", "side": "before", "kind": "soak", "samples": "soak-before.jsonl",
      "steps": [ { "step": "load-100", "from": "...Z", "to": "...Z" } ] }
  ]
}
```

- `subsystem`: the tick-breakdown label the fix changes (omit it when the fix has no single part).
- `kind`: `repeat` (the default) or `soak`. Runs of kind `repeat` with the same step are summarised
  together; a soak never is.
- Step names must match across sides. Leave a few seconds out at each load change (`from`/`to` are
  half-open: `from` <= tick start < `to`). UTC with `Z` or an offset, never local time.

## What recompute.js prints (`tick_health`)

- `runs.<run>.<side>.<step>`: `ticks`; `tick_mean_ms`, `tick_p50_ms`, `tick_p95_ms`, `tick_p99_ms`,
  `tick_max_ms` (whole tick); `sub_*` the same for the subsystem (a tick without its label counts 0 ms);
  `late_p50_ms`, `late_p99_ms`, `late_max_ms` (tick lateness); `ticks_ge_100ms`, `ticks_ge_250ms` and
  their `_per_min` rates (250 ms is upstream's degraded threshold); `samples`, `loop_delay_mean_ms`,
  `loop_delay_max_ms`, `cpu_mean_pct` (from the per-second samples). Percentiles are nearest-rank.
- `repeats.<side>.<step>`: `runs` (how many) and, for each stat above, `{median, min, max}` across the
  repeats; only when a side has 2 or more repeats of that step.
- A repeat whose mean, p50 or p99 is over 1.5 times its repeats' median (and 1 ms or more above it)
  prints an `outlier:` warning naming the run, side, step and stat: explain it or list it as open.
- A key the data can't give (no samples, no lateness, no subsystem) is absent, never null.

Report the repeats' **median with its spread** (`9.3 (8.9–9.5)`) for means and p50s, and the soak for
p99, max and pause rates. A difference smaller than the spread is not a result.
