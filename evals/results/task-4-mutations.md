# Task 4 replay mutation evidence

Date: 2026-10-07. Each mutant was applied independently and restored. No credentials or unredacted
database error serialization are included. The final restored Task 4 test passed 3/3, and the full
gate passed 47/47 files and 456/456 tests against the isolated eval database.

| Guard changed temporarily | Target | Mutant result | Restored evidence |
| --- | --- | --- | --- |
| Removed duplicate recording-step ID refinement | `replay.test.ts -t 'rejects duplicate step IDs'` | Failed: duplicate recording parsed instead of throwing `duplicate step id` | The final full gate passed after restoration |
| Skipped unknown registered-tool rejection | `replay.test.ts -t 'rejects duplicate step IDs'` | Failed: replay resolved with zero calls instead of rejecting `Unknown registered store tool: shell` | The final full gate passed after restoration |
| Skipped registered-tool Zod input parsing | `replay.test.ts -t 'rejects duplicate step IDs'` | Failed: handler accepted `{ unexpected: true }`; test expected `Unrecognized key` and also asserted handler was never called | The final full gate passed after restoration |
| Used recorded symbolic reference literally instead of resolving prior handler result | `replay.test.ts -t 'resolves symbolic IDs'` | Failed: handler returned `bill_not_found` instead of `draft` | The final full gate passed after restoration |
| Omitted handler-result comparison with recorded expectation | `replay.test.ts -t 'resolves symbolic IDs'` | Failed: a recorded `finalized` success resolved when the actual handler returned `draft` | The final full gate passed after restoration |
| Replaced real handler output with a fabricated `{}` result | `replay.test.ts -t 'resolves symbolic IDs'` | Failed: expected real `bill_id` was absent | The final full gate passed after restoration |
| Added an SDK `query()` call during replay | `replay.test.ts -t 'rejects duplicate step IDs'` | Failed: mocked provider trap raised `Provider/model calls are forbidden during replay.` | The final full gate passed after restoration |

The isolation amendment adds these separately mutation-checked guards. Each mutant was restored
before the next one; the final focused target test passed 1/1 at 13:01:40 UTC.

| Guard changed temporarily | Target | Mutant result | Restored evidence |
| --- | --- | --- | --- |
| Removed sandbox ownership registry check | `replay.test.ts -t 'rejects duplicate step IDs'` | Failed: unowned sandbox reached property access instead of rejecting with `Unowned` | Restored ownership check; focused check passes |
| Removed process database target validation | `replay.test.ts -t 'rechecks the target'` | Failed: process database drift was accepted and both handlers ran | Restored process comparison |
| Removed pool database target validation | `replay.test.ts -t 'rechecks the target'` | Failed: pool drift was accepted and both handlers ran | Restored pool comparison |
| Removed the per-step target re-check | `replay.test.ts -t 'rechecks the target'` | Failed: drift before step two was accepted | Restored per-step check |
| Removed host comparison | `replay.test.ts -t 'rechecks the target'` | Failed: host mismatch did not throw | Restored host comparison |
| Removed port comparison | `replay.test.ts -t 'rechecks the target'` | Failed: port mismatch did not throw | Restored port comparison |
| Removed database comparison | `replay.test.ts -t 'rechecks the target'` | Failed: database drift was accepted and both handlers ran | Restored database comparison |
| Removed user comparison | `replay.test.ts -t 'rechecks the target'` | Failed: user mismatch did not throw | Restored user comparison |
| Leaked `error.message` from worker failure serialization | `replay.test.ts -t 'redacts a sandbox connection'` | Failed: fake password sentinel appeared in serialized failure | Restored generic safe failure serialization |

The individual mutation commands were `pnpm exec vitest run src/evals/replay.test.ts -t 'rejects duplicate step IDs'`,
`pnpm exec vitest run src/evals/replay.test.ts -t 'resolves symbolic IDs'`,
`pnpm exec vitest run src/evals/replay.test.ts -t 'rechecks the target'`, and
`pnpm exec vitest run src/evals/replay.test.ts -t 'redacts a sandbox connection'`. The real
failed-connection test also asserts the actual worker password does not occur in the safe error.
Mutant output was observed directly; this ledger records the failing assertion rather than every
Vitest stack. The exact final all-tests and full-gate output belong in the Task 4 report and
checkpoint in `HANDOFF.md`.

The ownership-manifest recheck was separately removed from the replay loop. The ownership-drift
test failed because both handler calls ran after the first handler changed the manifest. Restoring
the check made the test pass. A fresh independent review on 2026-10-07 passed the amended design.
The CI-shaped run (`EVAL_TEST_DATABASE_ADMIN_URL` unset) produced 5 passed and 2 skipped; the
dedicated local DB run produced 7 passed. No model was used.
