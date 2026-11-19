# Performance comparison

TODO(bundle): two or three sentences: the symptom, the headline result with its p50 and its tail (say
plainly if the tail doesn't improve), and what the numbers don't show.

## Kind of fix

TODO(bundle): throughput, stalls or both, then one line: which metrics the headline table shows and why
(they are what the fix changes).

## Testing methodology

TODO(bundle): the capture design used: builds compared, machine and CPU pinning, what else ran, tick
rate, load steps and their length, repeats and their order (alternating before and after), the soak's
length and load, which runs had which profiler (never two on one process), the collector and its flags.

## Conditions

| Condition                    | Before                                         | After                                                                    |
|------------------------------|------------------------------------------------|--------------------------------------------------------------------------|
| Build                        | TODO(bundle): the pristine release, e.g. `X`   | TODO(bundle): `X` + this patch only (+ its prerequisites, named exactly) |
| Load and workload            | TODO(bundle)                                   | TODO(bundle)                                                             |
| Date and time (UTC)          | TODO(bundle)                                   | TODO(bundle)                                                             |
| Dedicated CPU cores          | TODO(bundle): yes, no or unknown               | TODO(bundle)                                                             |
| Collector and profiler flags | TODO(bundle)                                   | TODO(bundle)                                                             |
| Capture duration             | TODO(bundle)                                   | TODO(bundle)                                                             |

TODO(bundle): name every way the runs differ besides the fix, and what that could do to the numbers.

## Headline: TODO(bundle): tick health or stalls

Values verbatim from `node recompute.js .` (see [expected.json](expected.json)); the label is the
metric name, optionally glossed. Only rows the runs measured. Repeats as `median (min–max)`.

| Metric                                | Step         | Before       | After        |
|---------------------------------------|--------------|--------------|--------------|
| TODO(bundle): e.g. `tick_p50_ms`      | TODO(bundle) | TODO(bundle) | TODO(bundle) |

## TODO(bundle): the other table (stalls or tick health), or delete this section

TODO(bundle): one line on why it comes second, then its rows, or delete the section when it says
nothing about the fix (say so in the coverage notes).

| Metric                     | Before       | After        |
|----------------------------|--------------|--------------|
| TODO(bundle): `windows`    | TODO(bundle) | TODO(bundle) |

## Anomalies and open questions

TODO(bundle): each anomaly (a step worse after the fix, a spike in one run type, a run unlike its
repeats) with its explanation from the data, or listed as open; "none" if there are none.

## Recompute

From this folder: `node recompute.js . --check` (exit 0 means the numbers above match `expected.json`).
It reads `windows.json` with each side's `error-report/` and `close-watch/`, and `tick-health/`, and
nothing else.

## Coverage notes

TODO(bundle): what was measured and what was not (and so is left out of the tables), how long each run
was, which profiles had rotated out ([profiles-index.md](profiles-index.md), if any), and that the
reports were redacted before checksumming, so the recompute runs on redacted files.
