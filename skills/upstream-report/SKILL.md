---
name: upstream-report
description: Use when an EveJS bug has been fixed as a patch and the fix needs to go to the upstream developers with a report.
---

# Upstream report

Build a review bundle the EveJS developers can read, apply and merge without asking you anything:
upstream's own error report, your fix beside it, a short bug report, a developer handoff and the
test results. You prepare the bundle, its zip and a short Discord post to go with it; a person posts them.

`<skill>` below is this skill's folder. Scripts are plain Node, no install: `node <skill>/scripts/<x>.js`.
`bundle.js` exits 0 ok, 2 refused (it lists every reason and writes nothing, except that `validate`
keeps its transcript), 64 usage; `leak-scan.js` exits 2 when it finds a hit.

## The bundle, in order

1. `README.md`: what it is, the base version, how to apply the patch, health capture, coverage, questions.
2. `BUG-REPORT.md`: at most 40 lines; the full report. Environment and reproduction, observed, expected.
3. `DEVELOPER-HANDOFF.md`: cause, changes by file, open questions, ends with a numbered merge checklist.
4. `patches/`: the fix as `.patch` file(s) against the base release.
5. `files/<repo path>`: each changed file in full, as it is after the fix.
6. `tests/`: `patch-validation.txt` (written by `validate`) and `verification-results.md`.
7. `error-report/`: upstream's report, ingested and redacted (details: `references/error-report.md`).
   A content or data bug has none: the README says `Health capture: not applicable: <reason>`.
8. `manifest-sha256.txt`: checksums, written last.

Each document's sections, lengths and an example per section: `references/bundle-shape.md`.
Beside the zip, never inside it: `<zip name minus .zip>.post.md`, the condensed post (step 7).

## Steps

1. **Private terms.** If there is no terms file, run
   `node <skill>/scripts/leak-terms.js init --logs <report zip or logs folder>` with the user. It reads the
   report `.zip` directly, in memory. Never unpack the report by hand: the unpacked logs are raw and
   unredacted, and nothing needs them. With no logs (a content or data bug has no error report), run
   `init` without `--logs`; it still proposes the identity terms. `init` is a proposal: it writes nothing
   until you re-run it with `--yes` and the confirmed list. It proposes candidates (your git identity,
   login, host name, LAN-style names, account logins and character names found in the logs). Pass every
   identity term it proposes (git name and email, login, host) as `--add <term>` unless the user asks you
   to drop one: they protect the user, and `init --yes` writes only what is passed. It files those under
   an `[identity]` section, so the one `Signed: <handle>` line is still allowed when the handle matches
   the login. Ask the user to confirm or drop the log-found names and "anything else you'd rather not
   share?", then pass their answers as well (`--add`, `--remove`, `--character`, `--yes`). Account logins
   are `--add` terms, character names `--character`. It writes a file outside the plugin folder. Every later
   run: `leak-terms.js show --logs <report zip>` and offer any new character names. Without a report
   or logs, ask the user for the names. `leak-terms.js --help` lists the options.
   Every scan and redaction reads that file. `--terms <file>` on `check`, `zip`, `add-report`,
   `redact.js` or `leak-scan.js` **adds** another terms file (it may be given more than once) and never
   replaces the
   user's own; `--no-user-terms` leaves the user's file out for a run.
2. **Start the bundle.** `node <skill>/scripts/bundle.js init <bundle> --area <area> --version <version>`.
   `<version>` is the EveJS release the patch is based on. This writes the skeleton: every `TODO(bundle)`
   must be replaced before `check` passes.
3. **Add the fix.** Make the patch from the checkout with
   `git -C <checkout> diff --binary --output=<absolute path to bundle>/patches/0001-<name>.patch <base> <fix>`
   (a relative `--output` lands inside the checkout, so always pass an absolute path; not `format-patch`:
   it embeds the author's email, which the scan refuses; `--output` lets git write
   the file itself, so no shell redirection re-encodes it or changes line endings). Write any other
   artefact the same way, never with `>`. Copy each changed file to `<bundle>/files/<path in the repo>`.
4. **Validate.** `node <skill>/scripts/bundle.js validate <bundle> --repo <checkout> --base <base tag or commit>`
   applies the patches to a clean copy of the base and syntax-checks the changed JavaScript. It writes
   `tests/patch-validation.txt`; it must say `Result: PASS`.
5. **Add the error report** (runtime and performance bugs; follow `references/error-report.md` to get the
   zip). Put the characters in the logs, one name per line, in a names file, and the host names to hide
   (the LAN names you kept in step 1, and any host `check` refused) in a hosts file, then:
   `node <skill>/scripts/bundle.js add-report <bundle> <ErrorReport zip> --names <names file> --hosts <hosts file>`.
   It redacts home paths, IP addresses (`<ip-N>`; loopback and documentation addresses stay), character
   names (the ones you listed, and any it finds in the server's log lines), account logins
   (`user=<login>(<id>)` becomes `user=<account-N>(<id>)`) and the hosts you listed before anything is
   checksummed, and prints the report's versions and window: quote those in the README, with the base tag
   (for example `upstream/000000.1`) beside the version. Text is recognised by its content, not its file
   name (UTF-16 included). A file it can't read as text makes it refuse and name the file; pass
   `--allow-binary <name>` only for a file that is meant to ship as it is. It also refuses when a name or
   host you gave survives anywhere in the output. If `check` later refuses a host name, add it to the
   hosts file and re-run `add-report` (never hand-edit the redacted report). Paste no log excerpts that did
   not come from the bundle.
6. **Write the documents.** Replace every `TODO(bundle)` following `references/bundle-shape.md`. Take
   versions, platform and Node version from the report's `manifest.json`, not from memory.
   - `BUG-REPORT.md` always has its "Environment and reproduction" section. If the exact trigger isn't established, give the
     closest reproduction known (what was running, the command or feature exercised, the log lines) and
     mark it "trigger not confirmed"; never leave it out or invent steps.
   - If the evidence doesn't link the logged error to the fix, say so in `BUG-REPORT.md` and list it under
     the handoff's open questions; don't claim a cause the evidence doesn't show.
7. **Write the Discord post** in a file outside the bundle folder (for example `<bundle>-post.md`),
   from BUG-REPORT.md, saved as UTF-8 (write it with your file tool, never with a PowerShell `>`). It is the message a person pastes into the EveJS Discord with the zip attached.
   Discord shows tables as raw pipes, caps a message at 2,000 characters and can't open links into a zip:
   - **In:** the title as a bold line; what's wrong and its impact in 2–3 sentences; the fix in one
     sentence; the headline evidence (one log line, or for performance the 2–4 key before/after
     figures); last, "Full report, patch, tests and evidence in the attached zip."
   - **Out:** tables (except a small one in a code block: at most 8 lines of 60 characters), links into
     the zip (name a file as `code` instead), images, `~~~` fences (Discord renders only ``` ones).
   - **One message:** at most 1,900 characters. Only if the essentials can't fit, split it with a line
     that is exactly `--- part 2/2 ---`, keep each part within 1,900, and tell the user why.
   - Check it with `node <skill>/scripts/bundle.js check-post <post>` (same leak terms and options as
     `check`) until it prints `post check passed`. An example (made up):

     ````markdown
     **Fleet: inviting into wing 2 lands the pilot in wing 1**

     Inviting a pilot into any wing but the first puts them in wing 1, so fleets with two or more wings
     collapse into one. Seen on EveJS 000000.1 with every invite; the server logs
     `TypeError: Cannot read properties of undefined (reading 'squads')` each time.

     **Fix:** `FleetService.invite` looked the wing up by list position instead of by its ID; the patch
     uses the ID (one function, no data change).

     Full report, patch, tests and evidence in the attached zip.
     ````
8. **Seal.** `node <skill>/scripts/bundle.js manifest <bundle>`, then
   `node <skill>/scripts/bundle.js check <bundle>`: it lists every problem (missing parts, leftovers,
   broken links, stale checksums, leak-scan hits, binary files it couldn't scan). Fix them, run `manifest`
   again after any edit, and repeat until it prints `check passed`. Upstream's own code in `files/` (or a
   log) can contain a word from your terms file; after reading the hit, re-run `check` and `zip` with
   `--allow <the term or the hit's label>`. Never allow a hit you haven't read.
9. **Zip.** `node <skill>/scripts/bundle.js zip <bundle> <out>.zip --post <post>` re-runs `check` and
   `check-post`, writes one top folder, and copies the post beside the zip as `<out>.post.md`. As a last
   look: `node <skill>/scripts/leak-scan.js <out>.zip <out>.post.md`.
   An interrupted zip may leave `<name>.<number>.old` files beside the output: they are safe to delete.
10. **Hand over.** Tell the user the zip path and that `<out>.post.md` is the text to post, with the zip
    attached (BUG-REPORT.md inside it is the full report). If the post has two parts, say why. You
    prepare; a person posts it. Post nothing, anywhere.

## Edits after sealing

Any change to a bundle file invalidates `manifest-sha256.txt`: run `manifest`, `check`, `zip --post` again.
If the change alters what the post says (a figure, the fix), update the post first.
