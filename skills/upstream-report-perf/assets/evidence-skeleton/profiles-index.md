# Profiles index

Which profile belongs to which record. Profiles keep their original bytes apart from redaction.

## Close Watch profiles

One row per `cpuCapture` record in each side's `server-health.log` that falls inside its window.

| Side   | Profile file (in `<side>/close-watch/`) | Capture start (UTC) | Duration (ms) | Present |
|--------|-----------------------------------------|---------------------|---------------|---------|
| TODO(bundle): before or after | TODO(bundle) | TODO(bundle) | TODO(bundle) | TODO(bundle): yes or rotated out |

## Pause-profiler profiles

One row per `cpu-NNN.cpuprofile` in `<side>/error-report/profiling/`, with the stalls in `events.jsonl` it covers:
the `cpu-profile` record names the file and its `startMonoMs`..`endMonoMs`; a `stall` whose
`intervalStartMonoMs`..`intervalEndMonoMs` overlaps that range belongs to it (small gaps between segments mean
a stall can touch two profiles, or none; give a stall in a gap a row marked "no profile covers it").

| Side   | Profile                      | Stalls covered (UTC start, lag ms) |
|--------|------------------------------|------------------------------------|
| TODO(bundle): side | TODO(bundle): cpu-NNN.cpuprofile | TODO(bundle) |

TODO(bundle): delete this section if no run used the pause profiler.

## Rotated out

TODO(bundle): the profiles named in `profiles_missing` of the recompute output (they were deleted by the
server's rotation before collection), or "none".
