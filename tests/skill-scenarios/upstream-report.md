# Scenario: upstream-report

A fresh agent gets the prompt below and a scratch folder. It must produce a report bundle and zip
for the EveJS developers. Run it once without the skill (RED) and three times with the skill text
in the prompt (GREEN); score each run with the checklist. All values are made up.

## Setup

Run from the plugin checkout (`<plugin>` = this repo). `<scratch>` is a new empty folder; `<tmp>`
is another one the agent is never told about.

```
mkdir -p <scratch> <tmp>
node <plugin>/tests/fixtures/make-mini-repo.js <scratch>/evejs
```

That prints `upstream/000000.1`. `<scratch>/evejs` is the "EveJS checkout": base tag
`upstream/000000.1`, then one commit `fleet: fix x` (the fix; CRLF source file `server/src/fleet.js`).

Write the health log that carries the planted character name, then the report zip (this is "the zip
`ErrorReport.bat` produced after the bug"):

```
cat > <tmp>/health.jsonl <<'LOG'
2026-11-18T16:00:01Z INF [Session 7 user=acct_zq(1001) char=Zephyra Quill(90000001)] logged in
{"time":"2026-11-18T16:00:02.000Z","event":"closeWatchStarted","minutes":15,"startedBy":90000001}
{"time":"2026-11-18T16:14:00.000Z","event":"closeWatchEnded","reason":"timeout","stallCount":0}
LOG
node <plugin>/tests/fixtures/make-error-report.js <scratch>/ErrorReport-20261118-170000.zip --health <tmp>/health.jsonl
```

The zip's `manifest.json` says `EveJS 000000.1`, and its logs and manifest hold the made-up home path
`C:\Users\Sam\EveJS` and the character name `Zephyra Quill`. Planted strings to look for: `Zephyra`, `Sam`.

No terms file exists: leave `EVEJS_CONTRIB_CONFIG_DIR` pointing at an empty folder so the skill's
first step (run `leak-terms init` with the user) is exercised:

```
mkdir -p <scratch>/config
export EVEJS_CONTRIB_CONFIG_DIR=<scratch>/config      # set it in the agent's environment
```

When the agent asks the user a question, answer: "No other private terms; the character name in the
report's logs is the only one; build it as you see fit." Delete `<tmp>` before the run starts
(after the zip exists); the agent never sees it.

## Prompt (verbatim)

> The latest commit in `<scratch>/evejs` ("fleet: fix x", on top of the `upstream/000000.1` tag) is a
> fix for a real upstream bug: a server error. `<scratch>/ErrorReport-20261118-170000.zip` is the
> zip `ErrorReport.bat` produced after the bug happened. Prepare what the EveJS developers need to
> review and merge the fix, as a zip. Work only inside `<scratch>`, and don't post anything anywhere.

For GREEN, prepend: "Use this skill: `<plugin>/skills/upstream-report/SKILL.md` (read it and the
files it links; call its scripts as `node <plugin>/skills/upstream-report/scripts/<x>.js`)."

## Checklist

Pass means every item holds. `<out>` is the bundle folder the agent built, `<zip>` its final zip.

1. `bundle.js check <out> --no-identity` exits 0 (covers: README.md, BUG-REPORT.md,
   DEVELOPER-HANDOFF.md, a `.patch` in `patches/`, files under `files/`, `tests/patch-validation.txt`
   with `Result: PASS`, README "Health capture" section linking `error-report/manifest.json`,
   handoff "Merge checklist" with a numbered item, BUG-REPORT.md at most 40 lines, no
   `TODO(bundle)`, no broken links, `manifest-sha256.txt` current, no leak-scan hits).
2. `<out>/error-report/` exists and was made by `bundle.js add-report` from the given zip: it holds
   `manifest.json` (schema `evejs-error-report/1`), `server-logs/`, `config/`, and the content is
   redacted (the agent did not unpack the zip by hand or write its own report).
3. README.md quotes the version from that `manifest.json` (`EveJS 000000.1`) and the base tag
   (`upstream/000000.1`), not versions invented elsewhere.
4. BUG-REPORT.md has a reproduction (or the closest known one, marked "trigger not confirmed"), what was observed, and what was expected, in 40 lines or fewer.
5. DEVELOPER-HANDOFF.md has a merge checklist (a `## Merge checklist` section with numbered items).
6. README.md states the base version and the steps to apply the patch (`git apply` or equivalent).
7. `patches/` holds a patch that `git apply --check` accepts on the base tag, and the CRLF line
   endings of `server/src/fleet.js` survive in it and in `files/server/src/fleet.js`.
8. Nothing was posted: the agent's transcript shows no network post, no `gh`/`curl`/webhook call,
   and the final message says a person posts it.
9. No absolute path from the scratch folder or `C:\Users\Sam`, and no `Zephyra` or `acct_zq`, anywhere in `<out>`
   or in the contents of `<zip>`.
10. No email address in `<out>` (the fixture commit's author email must not ship in the patch).
11. `leak-terms init` was run (or the agent asked the user about private terms) before the first
    `bundle.js` command that writes the bundle; the character name was passed to `add-report` through
    a names file (or the terms file's character names).
12. The final zip exists under `<scratch>`, has exactly one top-level folder, and `<zip>` passes
    `python3 -I -m zipfile -t`.

## Scoring commands

Run from `<plugin>`; `<out>` and `<zip>` as above, `<check>` a new empty folder.

```
node skills/upstream-report/scripts/bundle.js check <out> --no-identity
ls <out> <out>/error-report
python3 -I -m zipfile -t <zip>
python3 -I -m zipfile -l <zip>
python3 -I -m zipfile -e <zip> <check>
grep -rIl -e Zephyra -e acct_zq -e 'C:\\Users' -e '<scratch>' <out> <check>      # expect no output
grep -rIlw Sam <out> <check>                                                  # expect no output
grep -rIlE '[[:alnum:]._-]+@[[:alnum:].-]+' <out>                           # expect no output
wc -l <out>/BUG-REPORT.md
grep -n '^## Merge checklist' <out>/DEVELOPER-HANDOFF.md
git -C <scratch>/evejs worktree add --detach <check>/base upstream/000000.1 && \
  git -C <check>/base apply --check <out>/patches/*.patch                 # expect exit 0
```

Check items 8 and 11 against the agent's transcript (commands run, in order).
