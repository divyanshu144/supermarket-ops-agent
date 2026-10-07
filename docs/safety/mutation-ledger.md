# Mutation ledger

This ledger records source mutations run locally against the disposable test database. A mutation
is recorded as killed only when its targeted test failed for the expected guard and the source was
then restored. It does not claim production or legal compliance.

## W1: owner-bound confirmation

Run on 2026-10-07, branch `responsible-ai`, disposable database target
`127.0.0.1:55439/rai_test`. No model call was made.

| Guard | Deliberate mutation | Test and observed result | Final state |
|---|---|---|---|
| Telegram store owner gate | Removed the comparison between the stored owner ID and the update sender. | `pnpm exec vitest run src/telegram/gate.test.ts --reporter=dot` failed both middleware tests: `next` was called for the stranger. | Restored owner comparison; targeted tests pass in W1 focused suite. |
| Callback owner binding | Removed the owner predicate from the atomic pending-action claim. | `pnpm exec vitest run src/repositories/confirmations.test.ts -t 'another store' --reporter=dot` failed because another user claimed the pending row. | Restored predicate. The first attempt was masked by a fixed timestamp already outside the 10-minute lifetime; the fixture now uses the injected current time and a separate +11-minute expiry assertion. |
| Below-cost model bypass | Passed the model-provided `allow_below_cost` value through to `finalizeBill`. | `pnpm exec vitest run src/tools/confirmed-actions.test.ts -t 'model-supplied allow_below_cost' --reporter=dot` failed for `true`: the tool finalized instead of returning `awaiting_confirmation`. Omitted and `false` variants stayed pending. | Restored unconditional `allowBelowCost: false`; the three input variants pass. |
| Below-cost refusal snapshot binding | Made `proposeConfirmation` ignore the fingerprint returned by the locked refusal and reread the bill instead. | `pnpm exec vitest run src/tools/confirmed-actions.test.ts -t 'exact below-cost refusal snapshot' --reporter=dot` failed because the pending row held the newer edited fingerprint, not the refusal snapshot. The regression test also failed before the production fix was applied. | Restored explicit fingerprint forwarding; the pending row keeps the original hash and confirmation rejects the changed bill as stale. |

All four mutations were restored before the final W1 gate. W1 focused tests passed (84 tests across
9 files). The full gate passed with 477 tests and 13 skipped across 52 files. `HANDOFF.md` records
the verification result and independent-review status.

## W2: validated preference data

Run on 2026-10-07, branch `responsible-ai`, disposable database target
`127.0.0.1:55439/rai_test`. Agent tests use the mocked SDK; no model call was made.

| Guard | Deliberate mutation | Test and observed result | Final state |
|---|---|---|---|
| Key allow-list | Removed the supported-key check from `parsePreference`. | `pnpm exec vitest run src/agent/runtime.test.ts -t 'validated preference data' --reporter=dot` failed when an unknown key indexed no schema. | Restored the allow-list. |
| Payment-mode enum | Replaced the payment enum with an arbitrary string schema. | `pnpm exec vitest run src/tools/preferences.test.ts -t 'invalid payment modes' --reporter=dot` failed because hostile text returned `saved`. | Restored the enum. |
| GSTIN format | Removed the GSTIN regex. | `pnpm exec vitest run src/tools/preferences.test.ts -t 'malformed GSTINs' --reporter=dot` failed because malformed text returned `saved`. | Restored the regex. |
| Per-store brand catalogue | Removed the catalogue lookup before saving preferred brand. | `pnpm exec vitest run src/tools/preferences.test.ts -t 'brand present' --reporter=dot` failed because an unknown brand returned `saved`. The passing test also rejects a brand present only in another store. | Restored the store-scoped lookup. |
| Prompt data boundary | Replaced the filtered preference object with the raw input object during prompt rendering. | `pnpm exec vitest run src/agent/runtime.test.ts -t 'validated preference data' --reporter=dot` failed because the hostile `shop_name` value appeared in the system prompt. | Restored allow-listed bounded JSON rendering. |
| Count-only invalid-row warning | Added invalid preference key/value pairs to the warning. | `pnpm exec vitest run src/tools/preferences.test.ts -t 'invalid legacy rows' --reporter=dot` failed because the warning contained the hostile value. An earlier attempted mutation serialized complete rows and failed sooner on BigInt serialization; that was discarded as an invalid mutation. | Restored count-only warning. |
| Normalized upsert | Changed the conflict update to persist the raw input instead of the parsed value. | `pnpm exec vitest run src/tools/preferences.test.ts -t 'normalized catalogue brand' --reporter=dot` failed because the stored brand retained surrounding spaces. | Restored persistence of the parsed normalized value. |

All W2 mutations were restored. Initial W2 focused tests passed (37 tests across 2 files); the
normalized-upsert regression adds one more test. Final W2 gate output is recorded in `HANDOFF.md`.
