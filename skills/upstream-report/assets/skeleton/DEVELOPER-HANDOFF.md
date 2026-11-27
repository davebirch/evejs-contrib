# Developer handoff

Patch base: **<version>**. TODO(bundle): who this is for, how the fix was exercised and what the live evidence does and does not show. See the [test record](tests/verification-results.md).

## Reproduction and chronology

TODO(bundle): how to reproduce, and the stages of the investigation or the code states the evidence refers to.

## Cause

TODO(bundle): why the bug happens, in terms of functions and data flow.

## Changes

| Source path | Relevant functions and changes |
|-------------|--------------------------------|
| TODO(bundle): path | TODO(bundle): functions and what changed |
| TODO(bundle): `server/tests/<patch-name>/...` | TODO(bundle): the functional tests shipped in the patch |

## Trade-offs and behaviour changes

TODO(bundle): each thing the patch deliberately changes or gives up beyond the fix (a durability window, a timing change, anything a user, server operator or other code could notice), the reasoning, and why it is acceptable. Write `None.` if there is nothing.

## Correctness and recovery

TODO(bundle): invariants the change keeps, how restarts, replays and old data are handled, and any crash boundary that remains.

## Open questions

TODO(bundle): behaviour you could not confirm, stated as questions rather than guesses.

## Remaining work

TODO(bundle): related problems seen but not fixed here.

## Merge checklist

1. TODO(bundle): what a reviewer should confirm against current upstream before merging.
