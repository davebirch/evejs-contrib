# Evidence shape

Two files in `evidence/` of the bundle, copied from `assets/evidence-skeleton/`. Examples are made up:
use your own facts, and keep the numbers identical to the recompute output.

Layout after ingesting both runs:

```
evidence/windows.json          the two UTC windows
evidence/recompute.js          copy of health-metrics.js
evidence/expected.json         its output, saved after ingesting
evidence/performance-comparison.md
evidence/profiles-index.md
evidence/before/error-report/  upstream's report, extracted and redacted (manifest.json, server-logs/, profiling/)
evidence/before/close-watch/   Close Watch .cpuprofile files (when there are any)
evidence/after/...             the same for the run with the fix
```

## performance-comparison.md

- **Opening** (2 sentences): the symptom measured and what the numbers show and don't.
  Example: `Server stalls over 2 s on a busy system. The fix cuts the Close Watch windows over 2 s from 5 to 2 in a one-hour window; the runs differ in time of day, and stalls are not compared because only one side used the pause profiler.`
- **Conditions**: table of build (stated exactly: the pristine release against that release plus only this
  patch and its prerequisites, as commits or patch names, for example `upstream X` against
  `upstream X + 0003 only`), load and workload, date and time (UTC), dedicated CPU cores, collector and
  profiler flags, capture duration, one column per side. Then every difference besides the fix, and what it
  could do to the numbers. Example: `Before used the pause profiler and after used only Close Watch, so stalls are not measured after.`
- **Numbers**: every scalar row of the recompute output as a table (metric, before, after, meaning), verbatim;
  `profiles_missing` as a count.
  Metrics from `recompute.js`:
  - `windows`, `window_total_ms`, `window_p95_ms`, `window_max_ms`, `windows_ge_2s`: Close Watch capture windows.
  - `incidents_by_status`, `incident_subsystem_ms`: recovered incidents by worst status; subsystem time in them.
  - `stalls`, `stall_lag_total_ms`, `stall_lag_p95_ms`, `stall_lag_max_ms`: pause-profiler stalls (`null`
    when the side has no `profiling/events.jsonl`; write "not measured").
  - `profiles`, `profiles_missing`: Close Watch profile names and those absent from `close-watch/`.
- **Recompute**: the command, `node recompute.js . --check`, and that exit 0 means a match.
- **Coverage notes**: what was and wasn't measured; run lengths; profiles that rotated out; that the
  reports were redacted before checksumming, so the recompute runs on redacted files.

## profiles-index.md

- **Close Watch profiles**: one row per `cpuCapture` in the window: side, profile file, capture start (UTC),
  duration, present or rotated out. Example: `before | 2026-11-18T10-02-00-000Z-950ms.cpuprofile | 10:02:00 | 950 | rotated out`
- **Pause-profiler profiles**: one row per `profiling/cpu-NNN.cpuprofile`: the stalls (start, lag) from
  `events.jsonl` that it covers. Upstream records the link: each `cpu-profile` record in `events.jsonl` names
  its `file` with the segment `startMonoMs`..`endMonoMs` (ms since the server started), and each `stall`
  record has `intervalStartMonoMs`..`intervalEndMonoMs` on the same clock. A stall belongs to every profile whose
  segment overlaps its interval (upstream's `doc/PAUSE_PROFILING.md`, "Reading a pause"; there are small gaps
  between segments, so a stall can touch two profiles, or sit in a gap: give it a row marked
  "no profile covers it"). Write
  "not recorded" only for a profile with no `cpu-profile` record. Delete the section when no run used the pause profiler.
- **Rotated out**: the `profiles_missing` list, or `none`.

## Also in the bundle

- BUG-REPORT.md's Before/after table copies the same Numbers rows: values verbatim, the label the
  recompute metric name, optionally followed by a plain-English gloss in parentheses. Example row:
  `| windows_ge_2s (Close Watch windows >= 2 s) | 5 | 2 |`.
- README Health capture links both manifests and `evidence/performance-comparison.md`.
- An optional instrumentation patch: `patches/<name>-optional.patch`, env-gated, off by default.
