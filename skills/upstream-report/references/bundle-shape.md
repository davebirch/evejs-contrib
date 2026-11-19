# Bundle shape

Each document is plain Markdown. Examples are made up: replace them with your own facts. Keep the
wording plain and specific; numbers and log lines beat adjectives.

## BUG-REPORT.md (40 lines or fewer; the full report: the Discord post beside the zip is condensed from it)

- **Title** (one line): symptom and trigger. Example: `# Fleet size is off by one when a fleet is formed`
- **Environment and reproduction** (3-8 lines): version, platform, Node.js version, steps.
  Example: `EveJS 000000.1, Windows 11, Node v24.0.0. 1. Form a fleet of two pilots. 2. Open the fleet window.`
- **Observed behaviour** (2-6 lines): what happens, with the key numbers or log lines.
  Example: `The window shows 3 members; the server logs "fleetSize=3".`
- **Expected behaviour and the fix** (2-6 lines): what should happen, the fix in a few sentences, and
  links to `patches/` and `DEVELOPER-HANDOFF.md`.
- **Before/after** (optional table): delete the section when there are no numbers.

## DEVELOPER-HANDOFF.md

- **Opening**: patch base, who it is for, how the fix was exercised, what the evidence does and does not show.
- **Reproduction and chronology**: how to reproduce; which code states the evidence refers to.
- **Cause**: why it happens, in functions and data flow. Example: `fleetSize() adds 1 for the leader, but callers already count the leader.`
- **Changes**: one table row per file: source path, functions and what changed.
- **Correctness and recovery**: invariants kept; restarts, replays and old data; any crash boundary left.
- **Open questions**: behaviour you could not confirm, as questions. Example: `Does the live server count a pilot who is mid-jump as a member?`
- **Remaining work**: related problems seen but not fixed here.
- **Merge checklist** (last; numbered): what a reviewer confirms against current upstream before merging.
  Example: `1. Confirm fleetSize() in the current release still adds 1 for the leader.`

## README.md

- **Opening**: bundle contents, the base version and the evidence, in two sentences.
- **Start here**: each document with a one-line purpose.
- **Apply to a clean checkout**: the skeleton's commands, with the real patch name(s), order, and a link to
  `tests/patch-validation.txt`.
- **Backup before testing**: what to back up on a populated save and how to roll back, or one line saying
  nothing persistent is touched.
- **Health capture**: link `error-report/manifest.json` and quote the version and window from it
  (example: `Report from EveJS 000000.1, window 2026-11-18T10:59Z to 2026-11-18T16:59Z.`), or the single
  line `Health capture: not applicable: <reason>` (example: `the bug is wrong data in a table; no stall or error`).
- **Coverage**: what the evidence covers (runs, durations, workload) and known gaps.
- **Questions for upstream**: numbered, each answerable in a sentence.
- **Manifest**: link `manifest-sha256.txt`; say what was redacted.

## tests/verification-results.md

- **Patch validation**: base, that `git apply --check` and `git apply` passed per patch and every changed
  JavaScript file passed `node --check` (summarise `patch-validation.txt`).
- **Directed tests**: a table of scenario and result for each test run on the fix, or one line saying none were run.
