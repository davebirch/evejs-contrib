# TODO(bundle): bug title, stating the symptom and its trigger

## Environment and reproduction

TODO(bundle): version, platform, Node.js version, workload and the steps that reproduce the bug. Describe system-level checks as bullets (setup, action, expected result); never attach harness or integration-test code.

## Observed behaviour

TODO(bundle): what happens, with the key numbers or log lines.

## Expected behaviour and the fix

TODO(bundle): what should happen and the fix in a few sentences, linking the [patch](patches/) and the [developer handoff](DEVELOPER-HANDOFF.md).

## Trade-offs and behaviour changes

TODO(bundle): a few bullets: what the patch deliberately changes or gives up beyond the fix (for example "a crash can lose up to ~1 s of progress; a clean shutdown loses nothing") and why that is acceptable. Write `None.` if there is nothing. `bundle.js check` refuses a report without this heading.

## Before/after

TODO(bundle): a small table of before and after numbers. Delete this section when there are no numbers.
