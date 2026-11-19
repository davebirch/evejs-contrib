# Scenario: upstream-report-perf, a throughput fix

A fresh agent adds the performance evidence for a fix that makes each tick cheaper, and writes
BUG-REPORT's Before/after. The trap: the fix's Close Watch windows are major GC pauses it doesn't touch
(about the same on both sides), so a stall-led table looks like no improvement, while the tick samples
show the result: at the top step the whole-tick p50 falls from 16.12 to 9.26 ms (median of 3
repeats), but the soak's p99 barely moves (30.3 → 28.5 ms). The after side's idle step has two
anomalies: three ~30 ms `fighter` ticks in `r2` (they set the repeats' idle `tick_p99_ms` max of 31) and
one ~500 ms GC tick in `r3`. All values are made up. Run it once with the v0.1.0 skill (RED: `git archive v0.1.0 skills` into a
scratch folder and point `<plugin>` there) and three times with this one (GREEN); score each with the
checklist. RED with v0.1.0 (2026-11-19) failed items 1–7: no classification, a hand-written tick script, "not
measured" stall rows, no whole-tick or p99 numbers, no tail statement and the idle anomaly unmentioned.
GREEN (3 runs, same model) passed items 1–5, 7 and 8; item 6 only partly (one run blamed the idle p99
spread on `r3`'s GC tick, two missed `r2`'s ~30 ms ticks). A fourth run after an "outlier first" rule still
missed them, so `recompute.js` now warns about a repeat far from its others (`outlier:`); the fifth run
listed both idle anomalies and passed every item.

## Setup

```
bash <plugin>/tests/skill-scenarios/mkscen-tick.sh <scratch>
```

It writes (`tests/fixtures/make-tick-scenario.js`) `<scratch>/ticks/` (tick-sampler files of repeats
`r1`..`r3` per side, four 20 s steps each, and a 5-minute `soak` per side at `load-100`),
`soak-<side>-report.zip` with `soak-<side>-profiles/` (Close Watch during the soaks only), `steps.txt`
(every run's and step's UTC times), empty `names.txt` and `hosts.txt`, and a bundle started with
`bundle.js init` at `<scratch>/bundle`.

## Prompt (verbatim; replace `<plugin>` and `<scratch>`)

> Use this skill: `<plugin>/skills/upstream-report-perf/SKILL.md` (read it and the files it links; call the scripts of `<plugin>/skills/upstream-report/scripts/` as `node <plugin>/skills/upstream-report/scripts/<x>.js`).
>
> An EveJS contributor fixed a performance problem: the `fighter` section of each 10 Hz space tick does much less work per tick after the fix. The report bundle is started at `<scratch>/bundle` (`bundle.js init` done; the patch, README, handoff and the rest of BUG-REPORT are someone else's job).
>
> Evidence, all in `<scratch>`:
> - `ticks/`: the tick sampler's output for every run (one JSON line per space tick, plus one health sample per second). `r1`..`r3` are short repeats, each with four 20 s load steps, run alternately before and after; `soak-*` is one 5-minute run per side at the top load.
> - `soak-before-report.zip` and `soak-after-report.zip`: the collector zips of the two soaks (Close Watch was on during the soaks only), with Close Watch profiles in `soak-before-profiles/` and `soak-after-profiles/`.
> - `steps.txt`: the UTC times of every run and load step, as noted during the runs.
>
> Conditions: before is pristine upstream `000000.1`, after is `000000.1` plus this fix only; same machine, 8 pinned CPU cores, nothing else running; load from a bot harness (idle, then 25, 50 and 100 bots fighting). No pause profiler was used. The names file is `<scratch>/names.txt` and the hosts file `<scratch>/hosts.txt` (both empty: there are no characters or hosts in these logs). Set `EVEJS_CONTRIB_CONFIG_DIR=<scratch>/config` for every command.
>
> Your task: add the performance evidence to the bundle (everything under `evidence/` that the skill asks for) and write the "Before/after" section of `<scratch>/bundle/BUG-REPORT.md` (leave its other sections as they are). Do not run `manifest`, `check` or `zip`. Work only inside `<scratch>` (never modify `<plugin>`), and post nothing anywhere. Finish with a short summary of the headline result, as you would tell the developers.

## Checklist

1. `node <scratch>/bundle/evidence/recompute.js <scratch>/bundle/evidence --check` exits 0, the file is
   a copy of `skills/upstream-report-perf/scripts/health-metrics.js`, and `expected.json` has
   `tick_health` with `repeats` and the `soak` run (no hand-written script for the tick numbers).
2. The comparison classifies the fix as throughput, with a one-line reason for the headline metrics.
3. The first table in BUG-REPORT's Before/after (and the comparison's headline) is tick health: whole
   tick and `fighter` per load step, repeats as median with spread, values verbatim.
4. No row reads "not measured" (or 0 for something not measured) anywhere.
5. The tail is stated plainly: the soak's whole-tick p99 30.3 → 28.5 ms (barely moves), in BUG-REPORT
   and the comparison's opening.
6. The after idle anomalies (`r2`'s ~30 ms ticks, which give the idle `tick_p99_ms` max of 31; `r3`'s
   ~500 ms tick) are explained or listed as open questions.
7. BUG-REPORT has a short "Testing methodology" section; the comparison has the full one (builds,
   pinning, steps × 20 s, 3 alternating repeats, 5-minute soaks, Close Watch on the soaks only).
8. No number in the write-up that isn't in `expected.json` or the stall output (spot-check five).
