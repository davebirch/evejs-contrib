# EveJS <area> fix

This review bundle targets **<version>**. TODO(bundle): the base tag it applies to (for example `upstream/000000.1`), then one or two sentences on what the bundle contains and the evidence behind it.

## Start here

TODO(bundle): list the bundle's documents with a one-line purpose each: [Bug report](BUG-REPORT.md), [Developer handoff](DEVELOPER-HANDOFF.md), [Verification results](tests/verification-results.md), and any other evidence file.

## Apply to a clean checkout

From the EveJS source root, replace `/path/to/bundle` with the path to this extracted directory:

```sh
git apply --check /path/to/bundle/patches/<patch-file>.patch
git apply /path/to/bundle/patches/<patch-file>.patch
```

If `git apply --check` reports a context mismatch, try `git apply --3way` instead.

For checkouts whose line endings differ from the release (for example a CRLF working tree), add `--ignore-space-change` to both commands. Git may leave mixed line endings in that case.

TODO(bundle): name each patch, say which are optional and in what order they apply, and link the [validation transcript](tests/patch-validation.txt).

## Backup before testing

TODO(bundle): what to back up before testing the fix on a populated save, and how to roll back. If nothing persistent is touched, say so in one line.

## Health capture

TODO(bundle): link upstream's error report (`error-report/manifest.json`, or `evidence/before/error-report/manifest.json` and `evidence/after/error-report/manifest.json`) and quote the version and window from its manifest. If a report does not apply, replace this section's body with one line: `Health capture: not applicable: <reason>`.

## Coverage

TODO(bundle): what the evidence covers and what it does not (runs, durations, workload, known gaps).

## Questions for upstream

TODO(bundle): numbered questions the author could not settle without upstream's knowledge, each one answerable in a sentence.

## Manifest

[SHA-256 manifest](manifest-sha256.txt) covers every file in this bundle except itself. TODO(bundle): note any files that keep original bytes on purpose (for example raw profiles) and what was redacted.
