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

## Releasing

For maintainers, from a git checkout (the zip does not include `scripts/`). From a clean `main`:

```
node scripts/plugin-release.js [--patch|--minor|--major] [--owner <owner>] [--remote <name>] [--terms <file>] [--skip-smoke] [--skip-validate] [--dry-run]
```

The owner defaults to the one in `package.json`'s `repository`; `--owner` overrides it, and `--remote`
defaults to `origin`. In order, each step refusing (exit 2) with a reason:

1. a dirty tree, a branch other than `main`, a remote that already has the tag or has commits this checkout
   lacks;
2. `claude plugin validate --strict .`, then a headless smoke test (`claude --plugin-dir . -p ...`) that must
   name every skill (`--skip-smoke` skips the smoke test). If `claude` cannot be found or run (on Windows
   `claude.cmd` is looked up on PATH) the release refuses, `--dry-run` included, unless you pass
   `--skip-validate`, which skips both checks (and, if `claude` is missing, the local install update);
3. `npm test`;
4. bump `.claude-plugin/plugin.json` (patch by default), commit `release: v<x>` and tag `v<x>`;
5. build the zip from a clone of that tag, so uncommitted files cannot get in (`scripts/build-zip.js`: leak scan,
   no symlinks, both layouts);
6. `git push --atomic` of the branch and the tag (if it fails, the message lists what is left locally and how to
   undo or retry), then `gh release create v<x> <zip> --repo <owner>/evejs-contrib`;
7. update the local install (`claude plugin marketplace update`, `claude plugin update`) and print a restart notice.

`--dry-run` runs the read-only checks, then prints every command that would change anything and changes nothing
(it only reads the remote, with `git ls-remote`; no fetch).
A failure before the push (a leak in the build, say) undoes the release commit and tag.

`node scripts/build-zip.js [--out <dir>] [--terms <file>]` builds the zip alone into `dist/`. The CI workflow in
`.github/workflows/test.yml` runs `npm test` on Linux, Windows and macOS with Node 22 and 24.
