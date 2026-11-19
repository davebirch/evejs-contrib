---
name: upstream-report-perf
description: Use when an EveJS fix is about server performance (slow or costly ticks, CPU, stalls, long pauses) and the upstream report needs before-and-after evidence, from the server's own tick telemetry, error reports and profiles, that reviewers can recompute.
---

# Upstream report: performance evidence

A performance fix is believed when runs of the same build and load, captured the same way, show the
difference and a reviewer can recompute it. This skill adds that evidence to the bundle that
`upstream-report` builds. **Do `upstream-report` first** (it is installed beside this skill; its scripts
are `node ../upstream-report/scripts/<x>.js` from this folder). Follow its steps for private terms, the
bundle skeleton, the patch, validation, the documents, sealing and the zip; this skill only replaces its
step 5 (the single error report) with the steps below. Post nothing, anywhere.

`<skill>` is this skill's folder, `<ur>` is `upstream-report`'s folder.

## 1. Classify the fix first

From what the patch changes, decide which kind of fix it is; it picks the headline:

- **Throughput**: each tick, call or loop does less work (fewer writes, cached lookups, less per entity).
  Headline: **tick health**, the whole tick and the changed subsystem, per load step.
- **Stalls**: a pause, blocking call or one long event goes away. Headline: **the stall table** (Close
  Watch windows, incidents, pause-profiler stalls).
- **Both**: lead with the one the fix is mainly for; the other comes second.

Write the choice and a one-line reason in the comparison. Stall tables are dominated by GC pauses that a
throughput fix doesn't touch: leading a throughput fix with them makes a real gain look like nothing.

## 2. Capture

From the user's own tree read `tools/ErrorReport/README.md`, `doc/PAUSE_PROFILING.md` and
`node tools/ErrorReport/collect-error-report.js --help`, and follow them over this text (upstream changes
the tool). Then:

- **Throughput fixes:** follow `references/tick-health.md`. Its default design: pristine release against
  that release plus only the fix, same machine, CPU pinning if available, nothing else running; short
  load steps (about 20 s each: an idle control, stepped load, one heavier step) repeated 3 to 5 times,
  alternating before and after; one long soak per side at the top load (about 5 minutes) for the tail.
  Record every run with `scripts/tick-sampler.js` (it reads upstream's own tick summaries and health
  samples) and note each step's start and end in UTC.
- **Stall fixes** (and the soak of a throughput fix, when it helps): the pause profiler when the evidence
  should be in upstream's own report format and for pauses outside ticks (login, jump, dock); Close
  Watch (`/health watch <minutes>` in game as staff) for per-stall detail by tick and subsystem. **Never
  two profilers on one server process**: a separate run per capture type.
- **Same conditions both sides, and a clean baseline:** compare the pristine upstream release with that
  release plus only this patch and its prerequisites (the patches it needs to apply), never a locally
  modified build on both sides. State it exactly in the report, as commits or patch names (for example
  `upstream X vs X + 0003 only`). Same load, same time of day where possible, dedicated CPU cores if the
  host allows, and the same collector, profiler flags and duration. Ask the user for what differed;
  never write a condition that wasn't given. Differences go in the comparison, they don't disqualify it.
- **One logs folder and one collector zip per error-report run.** Close Watch `.cpuprofile` files are not
  collected by the collector: copy each run's `tick-profiles` folder aside before the server rotates them.
  Note each run's start and end as UTC date-times.

If the user has fewer runs than this (one side, no repeats, no soak), use what there is and say what is
missing in the README, BUG-REPORT and comparison; never invent a run.

## 3. Add the evidence

Use `upstream-report` step 5's names file (every character in the logs, one per line) and hosts file
(the LAN host names to hide) for every command here.

1. **Error reports**, per side (`before` is the run without the fix):
   `node <ur>/scripts/bundle.js add-report <bundle> <zip> --as evidence/<side>/error-report --names <names file> --hosts <hosts file>`
   and, when profiles exist,
   `node <ur>/scripts/bundle.js add-profiles <bundle> <profiles folder> --as evidence/<side> --names <names file> --hosts <hosts file>`.
   Do not unpack a report by hand: the raw logs hold unredacted names and paths. If `check` later refuses
   a host name, add it to the hosts file and re-run `add-report` and `add-profiles` for both sides; never
   hand-edit the redacted evidence (the recompute and checksums depend on it). Then write
   `<bundle>/evidence/windows.json`:
   `{"before": {"from": "...Z", "to": "...Z"}, "after": {"from": "...Z", "to": "...Z"}}` (the error-report
   runs' windows; ISO date-times ending in `Z` or `+hh:mm`, never local time).
2. **Tick health**: copy each run's sampler file into `<bundle>/evidence/tick-health/` and write
   `tick-health/runs.json` (runs, sides, `kind` repeat or soak, steps with UTC times, the `subsystem`
   label) as `references/tick-health.md` shows.
3. Copy `<skill>/scripts/health-metrics.js` to `<bundle>/evidence/recompute.js` (a reviewer runs it from
   the bundle; never write your own script for numbers it computes). Run
   `node <bundle>/evidence/recompute.js <bundle>/evidence`, read the warnings (each `outlier:` line is an
   anomaly the write-up explains or lists), and save its output with
   `--write <bundle>/evidence/expected.json` (no shell redirection: PowerShell 5.1 would write UTF-16).
   Then `node <bundle>/evidence/recompute.js <bundle>/evidence --check` must exit 0. It runs on the
   redacted files; say so in the comparison. Re-run it after any change to the evidence.
4. Copy the files of `<skill>/assets/evidence-skeleton/` into `<bundle>/evidence/` (`profiles-index.md`
   only when a run kept profiles) and fill every `TODO(bundle)` following `references/evidence-shape.md`.

## 4. Write it up

`references/evidence-shape.md` has the full shape. The rules:

- **Headline from what the fix changes.** The first table holds the metrics the fix actually improves
  (for a throughput fix: whole-tick and subsystem p50, p99 and mean per load step; repeats as
  `median (min–max)`, the soak for the tail), with one line saying why. Everything else is second or
  left in `expected.json`.
- **Only measured rows.** Leave out a row a run didn't measure (no pause profiler: no stall rows), never
  print "not measured" or 0. Values verbatim from the recompute output; the label is the metric name,
  optionally glossed.
- **p50 and the tail, honestly.** Give both for every headline step, and say plainly when the tail
  doesn't improve (`p99 30.3 → 28.5 ms: the slowest ticks are GC pauses, as often on both sides`).
- **Explain anomalies** (a step worse after the fix, a spike in one run, a repeat unlike the others) from
  the data, or list them as open questions in the comparison and the handoff.
- **Only these runs' numbers.** Never quote a figure from an earlier or superseded measurement, a commit
  message or a draft.
- `BUG-REPORT.md`: replace its "Before/after" section with the "Testing methodology" and "Before/after"
  sections of `<skill>/assets/bug-report-sections.md` (short: the 40-line limit holds). The comparison
  has the full methodology.
- README Health capture: link each error report's `manifest.json` (`evidence/<side>/error-report/`),
  quote each report's version (with the base tag, for example `upstream/000000.1`) and window
  (`add-report` prints them), and link `evidence/performance-comparison.md`. Coverage: what each run did
  and didn't capture, including profiles listed in `profiles_missing`. With no error-report run at
  all, write `Health capture: not applicable: tick health only` and link the comparison.
- The patch: make it as `upstream-report` step 3 says, `git -C <checkout> diff --binary --output=<absolute
  path to bundle>/patches/0001-<name>.patch <base> <fix>`. `bundle.js` has no command for patches.
- Don't claim more than the runs show. If the runs differ in anything besides the fix, or the patch does
  not plainly touch what the metrics measure, say that in the comparison and the handoff's open
  questions instead of calling the change a speed-up.
- An instrumentation patch (extra logging or timing) is optional: ship it separately as
  `patches/<name>-optional.patch`, gated by an environment variable and off by default, never inside the
  fix patch. The README says which patches are optional.

## Finish

Back to `upstream-report` step 7: `manifest`, `check`, repeat until `check passed`, then `zip`. Run
`manifest` again after any edit, including to `expected.json`.
