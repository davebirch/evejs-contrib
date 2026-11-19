# Performance comparison

TODO(bundle): two sentences: the symptom measured, and what the numbers below show (and don't show).

## Conditions

| Condition                    | Before                                         | After                                                                    |
|------------------------------|------------------------------------------------|--------------------------------------------------------------------------|
| Build                        | TODO(bundle): the pristine release, e.g. `X`   | TODO(bundle): `X` + this patch only (+ its prerequisites, named exactly) |
| Load and workload            | TODO(bundle)                                   | TODO(bundle)                                                             |
| Date and time (UTC)          | TODO(bundle)                                   | TODO(bundle)                                                             |
| Dedicated CPU cores          | TODO(bundle): yes, no or unknown               | TODO(bundle)                                                             |
| Collector and profiler flags | TODO(bundle)                                   | TODO(bundle)                                                             |
| Capture duration             | TODO(bundle)                                   | TODO(bundle)                                                             |

TODO(bundle): name every way the two runs differ besides the fix, and what that could do to the numbers.

## Numbers

Output of `node recompute.js .` run in this folder (see [expected.json](expected.json)).
One row per scalar metric of the output, values verbatim (the label is the metric name as
printed, optionally followed by a plain-English gloss in parentheses); `profiles_missing` as a
count.

| Metric                      | Before         | After          | Meaning |
|-----------------------------|----------------|----------------|---------|
| TODO(bundle): `windows`     | TODO(bundle)   | TODO(bundle)   | TODO(bundle) |

## Recompute

From this folder: `node recompute.js . --check` (exit 0 means the numbers above match `expected.json`).
It reads `windows.json` and each side's `error-report/` and `close-watch/`, and nothing else.

## Coverage notes

TODO(bundle): what was measured and what was not (a side without the pause profiler has no stall counts),
how long each run was, which profiles had rotated out ([profiles-index.md](profiles-index.md)), and that
the reports were redacted before checksumming, so the recompute runs on redacted files.
