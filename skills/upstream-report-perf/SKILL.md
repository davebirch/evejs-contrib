---
name: upstream-report-perf
description: Use when an EveJS fix is about server performance (stalls, slow ticks, CPU, long pauses) and the upstream report needs before-and-after evidence from the server's own error reports and profiles that reviewers can recompute.
---

# Upstream report: performance evidence

A performance fix is believed when two runs of the same build and load, captured the same way, show
the difference and a reviewer can recompute it. This skill adds that evidence to the bundle that
`upstream-report` builds. **Do `upstream-report` first** (it is installed beside this skill; its scripts
are `node ../upstream-report/scripts/<x>.js` from this folder). Follow its steps for private terms, the
bundle skeleton, the patch, validation, the documents, sealing and the zip; this skill only replaces its
step 5 (the single error report) with the steps below. Post nothing, anywhere.

`<skill>` is this skill's folder, `<ur>` is `upstream-report`'s folder.

## Capture, one run each side

From the user's own tree read `tools/ErrorReport/README.md`, `doc/PAUSE_PROFILING.md` and
`node tools/ErrorReport/collect-error-report.js --help`, and follow them over this text (upstream changes
the tool). Then, for each run:

- **Which capture:** the pause profiler when the evidence should be in upstream's own report format and
  for pauses outside ticks (login, jump, dock); Close Watch (`/health watch <minutes>` in game as staff)
  for per-stall detail by tick and subsystem. Either or both; never both profilers on one server process.
- **Same conditions both sides, and a clean baseline:** compare the pristine upstream release with that
  release plus only this patch and its prerequisites (the patches it needs to apply), never a locally
  modified build on both sides. State it exactly in the report, as commits or patch names (for example
  `upstream X vs X + 0003 only`). Same load, same time of day where
  possible, dedicated CPU cores if the host allows, and the same collector, profiler flags and duration.
  Ask the user for what differed; never write a condition that wasn't given. Differences go in the
  comparison, they don't disqualify it.
- **One logs folder and one collector zip per run.** Close Watch `.cpuprofile` files are not collected
  by the collector: copy each run's `tick-profiles` folder aside as that run's profiles folder, before
  the server rotates them.
- Note each run's start and end as UTC date-times (they go in `evidence/windows.json`).

If the user only has one side, say so in the README and BUG-REPORT; don't invent the other.

## Add the evidence

Use `upstream-report` step 5's names file (every character in the logs, one per line) and hosts file
(the LAN host names to hide) for every command here.

1. Per side (`before` is the run without the fix):
   `node <ur>/scripts/bundle.js add-report <bundle> <zip> --as evidence/<side>/error-report --names <names file> --hosts <hosts file>`
   and, when profiles exist,
   `node <ur>/scripts/bundle.js add-profiles <bundle> <profiles folder> --as evidence/<side> --names <names file> --hosts <hosts file>`.
   Do not unpack a report by hand: the raw logs hold unredacted names and paths. If `check` later refuses
   a host name, add it to the hosts file and re-run `add-report` and `add-profiles` for both sides; never
   hand-edit the redacted evidence (the recompute and checksums depend on it).
2. Write `<bundle>/evidence/windows.json`:
   `{"before": {"from": "...Z", "to": "...Z"}, "after": {"from": "...Z", "to": "...Z"}}` (ISO date-times
   ending in `Z` or `+hh:mm`, never local time).
3. Copy `<skill>/scripts/health-metrics.js` to `<bundle>/evidence/recompute.js` (a reviewer runs it from
   the bundle, so don't write your own). Run `node <bundle>/evidence/recompute.js <bundle>/evidence`, read
   the warnings, and save its output with `--write <bundle>/evidence/expected.json` (no shell
   redirection: PowerShell 5.1 would write UTF-16). Then
   `node <bundle>/evidence/recompute.js <bundle>/evidence --check` must exit 0. It runs on the redacted
   files; say so in the comparison. Re-run it after any change to the evidence.
4. Copy the files of `<skill>/assets/evidence-skeleton/` into `<bundle>/evidence/` and fill every
   `TODO(bundle)` following `references/evidence-shape.md`:
   - `performance-comparison.md`: conditions, the numbers, coverage notes.
   - `profiles-index.md`: each profile mapped to its record, and what rotated out.

## Make the documents agree with the numbers

- `BUG-REPORT.md` Before/after: a table that copies every row of the recompute
  output (every scalar metric it prints, including `window_total_ms` and each stall row;
  `profiles_missing` as a count). Values are verbatim, nothing rounded or estimated; the label is
  the recompute metric name, optionally followed by a plain-English gloss in
  parentheses. A metric a side did not measure (`stalls` is `null` without the pause
  profiler) reads "not measured", never 0.
- README Health capture: link both `evidence/before/error-report/manifest.json` and
  `evidence/after/error-report/manifest.json`, quote each report's version (with the base tag, for
  example `upstream/000000.1`) and window (`add-report` prints them), and link
  `evidence/performance-comparison.md`. Coverage: what each run did and didn't capture,
  including profiles listed in `profiles_missing`.
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
