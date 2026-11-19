# evejs-contrib

Skills and scripts for reporting EveJS bugs upstream (`skills/upstream-report`, `skills/upstream-report-perf`). This repository is public: keep everything generic.

- **Nothing private, ever:** no host names, home paths, private IP addresses, people's names, game character names or anything specific to one person's setup. Users keep their own terms in their personal leak-terms file (see README "Leak terms"), never in the repo.
- **Leak-scan before every push** (`npm run release-check -- --skip-smoke` scans the whole tracked tree), and check the diff by eye.
- **Pull requests only** against `main`, squash-merged. The PR title is the commit message and must be a conventional commit (`feat:`, `fix:`, `docs:`, ...); a workflow checks it.
- **Never bump the version by hand,** in a PR or anywhere else. release-please owns `.claude-plugin/plugin.json`, `package.json` and `CHANGELOG.md`. A release happens only by merging its release PR, after `npm run release-check`.
- **Never push tags,** and never push to `main` directly.
- **Run `npm test` before committing.** CI runs the tests on Linux, macOS and Windows with Node 22 and 24, so keep paths, line endings and shell use portable.
- **A change to a skill's behaviour** updates its `SKILL.md`, the matching scenario in `tests/skill-scenarios/`, and the README if users see it.
