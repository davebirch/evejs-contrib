# Evidence shape

Two files in `evidence/` of the bundle, copied from `assets/evidence-skeleton/`, and two sections of
`BUG-REPORT.md` from `assets/bug-report-sections.md`. Examples are made up: use your own facts, and keep
the numbers identical to the recompute output.

Layout after ingesting the runs (a part is there only when the runs measured it):

```
evidence/windows.json          the UTC windows of the error-report runs (stall metrics)
evidence/tick-health/          runs.json and each run's tick-sampler file (tick health)
evidence/recompute.js          copy of health-metrics.js
evidence/expected.json         its output, saved after ingesting
evidence/performance-comparison.md
evidence/profiles-index.md     only when there are profiles
evidence/before/error-report/  upstream's report, extracted and redacted (manifest.json, server-logs/, profiling/)
evidence/before/close-watch/   Close Watch .cpuprofile files (when there are any)
evidence/after/...             the same for the run with the fix
```

## Kind of fix and the headline

Classify the fix before writing anything, from what the patch changes:

- **Throughput** (each tick, call or loop does less work): the headline is **tick health**, the whole tick
  and the changed subsystem per load step.
- **Stalls** (a pause, blocking call or long single event goes away): the headline is the **stall table**
  (Close Watch windows, incidents, pause-profiler stalls).
- **Both**: lead with the one the fix is mainly for, the other second.

Pick the headline table's rows from what the fix changes and say why in one line, for example
`Headline: the fix removes per-tick work in the fighter section, so whole-tick and fighter times per load
step.` The other table follows, shorter, or is left out when it says nothing about the fix (a stall table
of GC windows the fix doesn't touch can go in the comparison only, with one line saying so).

**Rows a run didn't measure are left out**, never printed as "not measured" or 0: no pause profiler means
no stall rows; no samples means no loop-delay rows. If only one side measured something, leave the row
out of the table and say so in the coverage notes.

## Honesty rules

- Give the **p50 and the tail** (p99 or max) for every headline step; a mean alone hides both.
- **Say plainly when the tail doesn't improve**, in the opening and in BUG-REPORT: `p99 barely moves
  (30.3 → 28.5 ms): the slow ticks are GC pauses the fix doesn't touch.` Never leave an unflattering
  number out of the table.
- **Explain every anomaly** (a step worse after the fix, a spike in one run type, a run unlike its
  repeats) from the data, or list it as an open question in the comparison and the handoff. Never call
  it noise without saying what you checked.
- **Only numbers from these runs' recompute output.** Never quote a number from an earlier or superseded
  measurement (a previous capture, a commit message, a draft), even when it looks better.
- Repeats: quote the median with its spread (`9.3 (8.9–9.5)`); a difference inside the spread is not
  a result.

## performance-comparison.md

- **Opening** (2–3 sentences): the symptom, the headline result with its p50 and its tail, and what the
  numbers don't show. Example: `The fighter section of each tick costs 11.7 ms with 100 bots fighting. With
  the fix the whole tick's p50 falls from 16.2 to 9.3 ms (median of 3 repeats), but the soak's p99 barely
  moves (30.3 → 28.5 ms): the slowest ticks are major GC pauses, as often on both sides.`
- **Kind of fix**: throughput, stalls or both, and the one-line headline justification.
- **Testing methodology**: the capture design actually used (see `references/tick-health.md`): builds
  compared, machine and CPU pinning, what else ran, tick rate, steps and their length, repeats and their
  order, soak length and load, which runs had which profiler, the collector and its flags.
- **Conditions**: table of build (stated exactly: the pristine release against that release plus only this
  patch and its prerequisites, as commits or patch names, for example `upstream X` against
  `upstream X + 0003 only`), load and workload, date and time (UTC), dedicated CPU cores, collector and
  profiler flags, capture duration, one column per side. Then every difference besides the fix, and what it
  could do to the numbers.
- **Headline table, then the other table**, each copied from the recompute output (values verbatim; the
  label the recompute metric name, optionally glossed):
  - Tick health from `tick_health`: per step, before and after, `tick_p50_ms`, `tick_p99_ms`,
    `tick_mean_ms`, `sub_p50_ms`, `sub_p99_ms` (and `cpu_mean_pct` when the fix is about CPU). From
    `repeats` give `median (min–max)`; from a soak give the value and add `tick_max_ms` and
    `ticks_ge_250ms_per_min`. With one run per side, give that run's values.
  - Stalls from `before`/`after`: `windows`, `window_total_ms`, `window_p95_ms`, `window_max_ms`,
    `windows_ge_2s`, `incidents_by_status`, `incident_subsystem_ms`, and `stalls`, `stall_lag_total_ms`,
    `stall_lag_p95_ms`, `stall_lag_max_ms` only when both sides used the pause profiler;
    `profiles_missing` as a count.
  Every other number of `expected.json` stays there; a reviewer finds it with the recompute.
- **Anomalies and open questions**: each anomaly, its explanation or that it is open.
- **Recompute**: the command, `node recompute.js . --check`, and that exit 0 means a match.
- **Coverage notes**: what was and wasn't measured (and so left out of the tables); run lengths;
  profiles that rotated out; that the reports were redacted before checksumming, so the recompute runs
  on redacted files.

## profiles-index.md

Only when a run kept profiles; otherwise don't copy it.

- **Close Watch profiles**: one row per `cpuCapture` in the window: side, profile file, capture start (UTC),
  duration, present or rotated out. Example: `before | 2026-11-18T10-02-00-000Z-950ms.cpuprofile | 10:02:00 | 950 | rotated out`
- **Other profiles in `close-watch/`** (segment profiles a harness kept, with no `cpuCapture` record): one
  row each with its file, the step or time span it covers, and how it was made.
- **Pause-profiler profiles**: one row per `profiling/cpu-NNN.cpuprofile`: the stalls (start, lag) from
  `events.jsonl` that it covers. Upstream records the link: each `cpu-profile` record in `events.jsonl` names
  its `file` with the segment `startMonoMs`..`endMonoMs` (ms since the server started), and each `stall`
  record has `intervalStartMonoMs`..`intervalEndMonoMs` on the same clock. A stall belongs to every profile whose
  segment overlaps its interval (upstream's `doc/PAUSE_PROFILING.md`, "Reading a pause"; there are small gaps
  between segments, so a stall can touch two profiles, or sit in a gap: give it a row marked
  "no profile covers it"). Write
  "not recorded" only for a profile with no `cpu-profile` record. Delete the section when no run used the pause profiler.
- **Rotated out**: the `profiles_missing` list, or `none`.

## BUG-REPORT.md

Replace its `## Before/after` section with the two sections of `assets/bug-report-sections.md`:

- **Testing methodology** (2–4 lines): builds, machine, steps × length, repeats (alternating), soak,
  profilers; link `evidence/performance-comparison.md` for the rest.
- **Before/after**: the headline justification line, then the headline table (the top step and one
  lighter step are usually enough; the rest stay in the comparison), then the tail sentence. The other
  table follows only if it says something about the fix and the 40-line limit allows. Example rows:
  `| tick_p50_ms (whole tick, median of 3) | 16.12 (15.26–16.54) | 9.26 (8.92–9.46) |` and
  `| tick_p99_ms (soak, 3000 ticks) | 30.3 | 28.5 |`.

## Also in the bundle

- README Health capture links each error report's manifest and `evidence/performance-comparison.md`.
- An optional instrumentation patch: `patches/<name>-optional.patch`, env-gated, off by default.
