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

## W5: owner-facing AI and privacy disclosure

Run on 2026-10-07, branch `responsible-ai`, disposable database target
`127.0.0.1:55439/rai_test`. Telegram tests use the mocked model and Telegram API; no live calls.

| Guard | Deliberate mutation | Test and observed result | Final state |
|---|---|---|---|
| Provider disclosure | Replaced Anthropic with a fictitious provider in `/privacy`. | `pnpm exec vitest run src/telegram/privacy.test.ts -t 'discloses AI providers' --reporter=dot` failed because the expected provider was absent. | Restored actual provider disclosure. |
| Accurate retention | Claimed generated files expire after 30 days before W3 implements cleanup. | The same privacy test failed because it requires the current “no automatic expiry” behavior. | Restored current-state wording; W3 will update it after implementation. |
| Required fallback | Replaced the fallback with an invented email. The first check used the exported constant as its expectation and therefore survived. The test was corrected to assert the exact approved phrase. | `pnpm exec vitest run src/telegram/privacy.test.ts -t 'discloses AI providers' --reporter=dot` then failed because “ask whoever gave you your invite” was absent. | Restored the exact approved fallback and fixed the test to use a literal. |
| Plain-text Telegram delivery | Added `parse_mode: 'HTML'` to `/privacy`. | `pnpm exec vitest run src/telegram/bot.access.test.ts -t 'serves /privacy' --reporter=dot` failed because `parse_mode` was present. | Restored plain-text sending. |
| Contact validation | Replaced the email/Telegram-handle validator with any string. | `pnpm exec vitest run src/config/env.test.ts -t 'malformed privacy contact' --reporter=dot` failed because malformed markup was accepted. | Restored strict validation. |
| Onboarding notice | Removed the AI-processing notice from `WELCOME`. | `pnpm exec vitest run src/telegram/privacy.test.ts -t 'onboarding' --reporter=dot` failed because the notice was absent. | Restored onboarding disclosure and `/privacy` link. |

All W5 mutations were restored. The initial focused suite passed 39 tests across three files; an
independent review then led to a copy change that removes any suggestion that export is already
available through a contact. The final gate is recorded in `HANDOFF.md`.

## W3: transcript and artifact retention

Run on 2026-10-07, branch `responsible-ai`, disposable database target
`127.0.0.1:55439/rai_test`. Voice and invoice tests use fake transport and local temporary files;
no model call was made.

| Guard | Deliberate mutation | Test and observed result | Final state |
|---|---|---|---|
| Claimed session protection | Removed the check that skips a session with a claimed Telegram update. | `pnpm exec vitest run src/retention/worker.test.ts -t 'in-flight Telegram claim'` failed: expected zero sessions deleted, got one. | Restored claimed-store check. |
| Claim/cleanup serialization | Removed the worker's store-row `FOR UPDATE` lock. | `pnpm exec vitest run src/retention/worker.test.ts -t 'serializes a pending update claim'` failed because the stale `claim-race-session` disappeared while another transaction held the store lock. | Restored explicit lock; the passing race test confirms claim completion precedes cleanup's claim check. |
| Exact retention boundary | Changed the inclusive cutoff comparison to strict `>`. | `pnpm exec vitest run src/retention/worker.test.ts -t 'last activity'` failed: the session exactly at the cutoff was deleted. | Restored `>=`; exact-boundary activity is retained. |
| Mapped-session/orphan distinction | Removed the `NOT EXISTS` mapping condition from orphan cleanup. | `pnpm exec vitest run src/retention/worker.test.ts -t 'in-flight Telegram claim'` failed because its transcript entry was deleted despite the session being protected. | Restored mapping exclusion. |
| Artifact expiry | Changed the expiry predicate to delete every regular file. | `pnpm exec vitest run src/retention/worker.test.ts -t 'expires old artifacts'` failed: two files were deleted instead of one and the recent PDF was gone. | Restored cutoff predicate. |
| Count-only logging | Added a private session ID to the cleanup log. | `pnpm exec vitest run src/retention/worker.test.ts -t 'logs counts only'` failed because output contained `private-session`. | Restored count-only fields. |
| Audio in-memory handling | Wrote the voice buffer to `voice.oga` in the isolated working directory. | `pnpm exec vitest run src/media/transcribe.test.ts -t 'writes no audio to disk'` failed because the file appeared. | Removed disk write; temporary directory was cleaned in test `finally`. |
| Telegram voice-handler memory boundary | Wrote downloaded bytes to `voice-handler.oga` in the handler's isolated working directory. | `pnpm exec vitest run src/telegram/bot.access.test.ts -t 'voice handler in memory'` failed because the file appeared. | Removed the handler write; full handler test remains with mocked Telegram download and Whisper call. |
| Telegram downloader memory boundary | Wrote fetched bytes to `voice-download.oga` in the downloader's isolated working directory. | `pnpm exec vitest run src/media/download.test.ts -t 'without persisting'` failed because the file appeared. | Removed downloader write; real downloader test mocks `fetch` and `getFile`. |
| Invoice regeneration | Made `generateInvoicePdf` return `bill_not_found` for a finalized bill. | `pnpm exec vitest run src/documents/invoice.test.ts -t 'regenerates an expired invoice'` failed because regeneration did not return `generated`. | Restored generation from persisted bill records. |
| Retention default | Changed the default from 30 to 31. | `pnpm exec vitest run src/config/env.test.ts -t 'documented defaults'` failed: expected 30, received 31. | Restored proposed default 30. |
| Owner-facing retention statement | Replaced the configured retention disclosure with “no automatic expiry”. | `pnpm exec vitest run src/telegram/privacy.test.ts -t 'current retention'` failed because it required “30 days without activity”. | Restored the configured duration in the privacy response. |
| Idempotent cleanup result | Made an empty follow-up sweep report one deleted transcript entry. | `pnpm exec vitest run src/retention/worker.test.ts -t 'idempotent'` failed: expected zero additional deletions, received one. | Restored the result count to actual deleted rows. |

All W3 mutations were restored. The repeated-sweep assertion checks that a second run reports zero
additional transcript deletions; the database row is absent after the first run. No output is
presented as a live-model result.

## W4: store export and customer pseudonymisation slice

Run on 2026-10-07, branch `responsible-ai`, disposable database target
`127.0.0.1:55439/rai_test`. No live model call or probe was made.

| Guard | Deliberate mutation | Test and observed result | Final state |
|---|---|---|---|
| Export owner binding | Removed the stored-owner equality check in `collectStoreExport`. | `pnpm exec vitest run src/repositories/privacy.test.ts -t 'denies a different Telegram user' --reporter=dot` failed because the other user received a ready export. | Restored stored-owner equality; legacy null-owner denial remains covered. |
| Export tenant isolation | Removed the store predicate from the product export query. | `pnpm exec vitest run src/repositories/privacy.test.ts -t 'only the authenticated store records' --reporter=dot` failed because the record count became 2 instead of 1. | Restored tenant predicate. |
| Transcript ownership | Removed the orphan-transcript fail-closed return. | `pnpm exec vitest run src/repositories/privacy.test.ts -t 'ownership cannot be assigned' --reporter=dot` failed because an incomplete export was returned as `ready`. | Restored orphan check. |
| Cross-store customer linkage | Added a test ledger row in store A referencing a store B bill. | `pnpm exec vitest run src/repositories/privacy.test.ts -t 'ledger link into another store' --reporter=dot` passes only when preview returns `cross_store_link`; the fixture also prevents execution from reaching mutation. | Test guards fail-closed behavior. |
| Confirmation owner binding | Removed the owner predicate from W1's pending-action claim. | `pnpm exec vitest run src/tools/privacy.test.ts -t 'requires the owner-bound' --reporter=dot` failed because the other user completed pseudonymisation. | Restored owner predicate; the targeted test passes after restore. |
| Direct identifier removal | Omitted `phone: null` from the account update. | `pnpm exec vitest run src/tools/privacy.test.ts -t 'requires the owner-bound' --reporter=dot` failed because the phone remained `9876543210`. | Restored phone clearing; the same test asserts names, notes, and payment references are cleared while balances and amounts remain. |
| Free-text note removal | Set the linked khata note to a non-empty value during pseudonymisation. | `pnpm exec vitest run src/tools/privacy.test.ts -t 'requires the owner-bound' --reporter=dot` failed because the note remained. | Restored clearing notes. |
| Payment-reference removal | Omitted `paymentRef: null` from the bill update. | `pnpm exec vitest run src/tools/privacy.test.ts -t 'requires the owner-bound' --reporter=dot` failed because `UPI-PRIVATE-REF` remained. | Restored clearing payment references. |
| Export file cleanup | Removed deletion from the delivery `finally` block. | `pnpm exec vitest run src/telegram/export-delivery.test.ts --reporter=dot` failed on both success and Telegram-send failure because the file remained. | Restored deletion in `finally`. |
| Transcript scope disclosure | Removed the sentence stating existing transcript mentions are not changed from the pseudonymisation preview. | `pnpm exec vitest run src/telegram/bot.access.test.ts -t 'previews customer pseudonymisation' --reporter=dot` failed because the limitation was missing. | Restored the disclosure in the confirmation preview. |
| Artifact serialization and permissions | Not mutated separately; exercised by a database-backed artifact test. | The test parses the generated JSON (including a bigint store ID) and asserts mode `0600`. | Passing W4 focused suite verifies the serialized artifact format. |

The independent W4 review found that generated invoice/deck files were omitted without being named
in the manifest. The manifest now explicitly records that omission because the artifact directory
has no store ownership index. The reviewer found no other blocker. All deliberate source mutations
above were restored before the W4 gate.

## W6: governance documentation

Run on 2026-10-07, branch `responsible-ai`. Tests are offline and contain no live-model metrics.
The consistency test was written first and initially failed because the six expected governance
documents did not exist.

| Guard | Deliberate mutation | Test and observed result | Final state |
|---|---|---|---|
| Erasure status accuracy | Changed the risk-register status for store erasure from `not done` to `implemented`. | `pnpm exec vitest run src/safety/docs.test.ts -t 'parse-mode handling' --reporter=dot` failed because the parsed status cell was `implemented`. | Restored `not done`. |
| Telegram parse-mode threat | Replaced the threat label `Telegram parse-mode interpretation` with a generic delivery label. | `pnpm exec vitest run src/safety/docs.test.ts -t 'parse-mode handling' --reporter=dot` failed because the required threat was absent. | Restored the explicit Telegram parse-mode threat and partial status. |
| Unsupported compliance claim | Added `This system is certified` to the system card. | `pnpm exec vitest run src/safety/docs.test.ts -t 'explicit status values' --reporter=dot` failed on the unsupported claim. | Removed the claim. |
| README document links | Changed the README system-card link to a nonexistent path. | `pnpm exec vitest run src/safety/docs.test.ts -t 'links to each' --reporter=dot` failed because the required path was missing. | Restored the valid link. |
| W3 artifact-export accuracy | Changed the inventory row back to saying `/export` omits all invoice/deck files because no tenant index exists. | The first attempt survived because the test matched a separate explanatory paragraph; I narrowed the assertion to the inventory's artifact row. A second run of `pnpm exec vitest run src/safety/docs.test.ts -t 'indexed artifact metadata' --reporter=dot` failed on that row as expected. | Restored the accurate row; the row-scoped test passes. |
| Threat-model artifact-export accuracy | Changed the threat model back to saying all invoice/deck files lack a store index and are omitted. | `pnpm exec vitest run src/safety/docs.test.ts -t 'indexed artifact metadata' --reporter=dot` failed on the threat-model assertion. | Restored the accurate indexed-metadata versus historical-file distinction. |

All four original W6 mutations and both artifact-export accuracy mutations were restored. The four
documentation consistency tests pass after restoration. The first inventory mutation exposed a weak
test assertion; the narrower row assertion killed the repeated mutation.
