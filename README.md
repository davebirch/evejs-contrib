# evejs-contrib

Tooling for EveJS contributors: a Claude Code plugin (with Codex-compatible
skill copies) that helps you build bug-report bundles to send upstream: the
report, the patch, the tests and a developer handoff.

This repository contains no EveJS code. EveJS itself is AGPL-3.0-only, and any
patches you send for it stay under that licence. This plugin is MIT (see
`LICENSE`).

## Install

### Claude Code, from GitHub

This repository is its own plugin marketplace:

```
claude plugin marketplace add davebirch/evejs-contrib
claude plugin install evejs-contrib@evejs-contrib
```

Update later with `claude plugin marketplace update evejs-contrib` and
`claude plugin update evejs-contrib@evejs-contrib`, then restart Claude Code (or `/reload-plugins`).

To try a checkout for one session without installing:

```
claude --plugin-dir ./evejs-contrib
```

### Codex (from the release zip)

Download `evejs-contrib-<version>.zip` from the GitHub release and unzip it. Copy
`evejs-contrib/.agents/skills/*` into your EveJS checkout's `.agents/skills/`, or into
`~/.agents/skills/`. The zip holds both layouts: `skills/` for Claude Code and `.agents/skills/` for Codex
(byte-identical copies).

## What you get

Two files, side by side:

- `<name>.zip`: the bundle, one top folder holding the report (`BUG-REPORT.md`), the patch, the changed
  files, a developer handoff and upstream's own error report (redacted), with checksums.
  Functional tests ship inside the patch (`server/tests/<patch-name>/`). Your own "is this patch still
  needed" checks stay in your tree and are never submitted (`bundle.js` refuses a `tests/patches/`
  folder, so name a fix anything but `patches`). System-level checks are described as bullets (setup,
  action, expected result), never shipped as harness code. `BUG-REPORT.md` must have a "Trade-offs
  and behaviour changes" section (`None.` when nothing); `bundle.js check` refuses a bundle without it.
- `<name>.post.md`: a condensed post to paste into the EveJS Discord with the zip attached: one message of
  at most 1,900 characters (Discord's limit is 2,000), with no links into the zip, no images and no tables
  (except a small one in a code block), saved as UTF-8 and at most 64 KiB.
  `bundle.js check-post` checks it, and `bundle.js zip <dir> <name>.zip --post <post>` writes it beside the
  zip; both use the same leak scan as the bundle.

The skills prepare both; a person posts them.

## Leak terms

The leak scan always checks home paths, IP addresses (all but loopback, unspecified and
documentation ones), LAN host names, emails, obvious secrets, character names in the server's
log lines and your own git/login/host identity. `bundle.js add-report` redacts the same things
(addresses become `<ip-N>`), decides what is text by content (UTF-16 included) and refuses a file
it can't read as text unless you pass `--allow-binary <name>`. `check` and `zip` take
`--names`, `--hosts`, `--allow <label or term>` and `--allow-binary <name>`. For anything else you would
rather not share (names, hosts, project words), run

```
node skills/upstream-report/scripts/leak-terms.js init --logs <your logs folder>
```

It lists candidates (including character names found in the logs) and writes nothing until
you confirm them with `--add`, `--character` and `--yes`. The file lives outside the plugin, at
`~/.config/evejs-contrib/leak-terms` (`%APPDATA%\evejs-contrib\leak-terms` on Windows), so
updates never touch it and it never enters git. Change it later with `leak-terms.js edit`
(or `show` for a summary; `--help` lists the options). `init` only proposes: it writes
nothing until you re-run it with `--yes` and the confirmed list. Your own identity terms are
kept under an `[identity]` section, so a single `Signed: <name>` line stays allowed.
`skills/upstream-report/leak-terms.local.example` documents the file format.

`--terms <file>` on `leak-scan.js`, `bundle.js` and `redact.js` adds another terms file to
yours (repeat it for several); `--no-user-terms` leaves your own file out for that run.

## Requirements

- Node >= 22
- git

## Development

From a git checkout (the zip leaves these files out), run the tests:

```
npm test
```

From a git checkout, build the distributable zip (written to `dist/`):

```
npm run build
```

## Contributing

Open a pull request against `main`. Squash-merge uses the **PR title** as the commit message, and release-please
reads it to choose the next version, so the title must follow conventional commits (a workflow checks it):

- `feat: ...` a new feature (minor bump)
- `fix: ...` a bug fix (patch bump)
- `docs:`, `chore:`, `test:`, `refactor:`, `ci:`, `perf:`, `build:`, `revert:` no release on their own
- a `!` after the type (`feat!: ...`) marks a breaking change (while the version is below 1.0 it bumps the minor)

Never edit the version by hand: it lives only in `.claude-plugin/plugin.json` and `package.json`, and
release-please keeps them equal.

## Releasing

Releases happen by merging the release PR. On every push to `main`, release-please opens or updates a PR that
bumps both versions and writes `CHANGELOG.md`. Merging it tags `v<version>`, creates the GitHub release and
attaches the zip (built by `scripts/build-zip.js`, both layouts). Pull requests opened with the default
`GITHUB_TOKEN` do not start the test workflow, and only exist if the repository setting "Allow GitHub Actions to
create and approve pull requests" is on; a `RELEASE_PLEASE_TOKEN` repository secret (contents, issues and pull
requests write) avoids both. Use squash merges only, so the checked PR title becomes the commit message.

Users pick up a release with:

```
claude plugin update evejs-contrib@evejs-contrib
```

Before merging a release PR you can run the local checks (a leak scan of the whole tracked tree, strict plugin
validation and a headless smoke test); it never bumps, tags, pushes or publishes:

```
npm run release-check -- [--terms <file>] [--skip-smoke] [--skip-validate]
```

If `claude` cannot be found or run it refuses (exit 2) unless you pass `--skip-validate`.

`node scripts/build-zip.js [--out <dir>] [--terms <file>]` builds the zip alone into `dist/`. The CI workflow in
`.github/workflows/test.yml` runs `npm test` on Linux, Windows and macOS with Node 22 and 24.
