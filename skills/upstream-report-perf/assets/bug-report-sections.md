## Trade-offs and behaviour changes

TODO(bundle): a few bullets: what the patch deliberately changes or gives up beyond the fix (for example
"a crash can lose up to ~1 s of progress; a clean shutdown loses nothing") and why that is acceptable.
Write `None.` if there is nothing. `bundle.js check` refuses a report without this heading.

## Testing methodology

TODO(bundle): two to four lines: pristine release vs release + this fix only, machine and CPU pinning,
load steps × length, repeats (alternating), the soak, profilers; full detail in
[the comparison](evidence/performance-comparison.md).

## Before/after

TODO(bundle): one line: what the headline table shows and why (it is what the fix changes).

| Metric                           | Before       | After        |
|----------------------------------|--------------|--------------|
| TODO(bundle): e.g. `tick_p50_ms` | TODO(bundle) | TODO(bundle) |

TODO(bundle): one sentence on the tail (p99 or max), saying plainly if it doesn't improve.
