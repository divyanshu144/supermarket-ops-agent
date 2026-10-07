# Task 3 mutation evidence

Date: 2026-10-07. Commands used `pnpm exec vitest run ...`; source was restored after every
mutant. The final restored focused suite is 3 files, 21 passed. DB-backed rows ran against the
dedicated disposable eval Postgres service; no shop database was used.

| Guard changed temporarily | Target | Mutant result | Restored result |
| --- | --- | --- | --- |
| Duplicate-ref issue disabled | `scenario.test.ts -t 'duplicate fixture IDs'` | Failed: `expected [Function] to throw an error` | 1 passed |
| Product-reference issue disabled | `scenario.test.ts -t 'unresolved product and customer'` | Failed: `expected [Function] to throw an error` | 1 passed |
| Tag enum widened to arbitrary strings | `scenario.test.ts -t 'unknown tags'` | Failed: unknown tag parse returned `success: true` | 1 passed |
| Safe integer refinement removed and integer-only validation substituted | `scenario.test.ts -t 'unsafe integer paise'` | Failed: unsafe integer parse returned `success: true` | 1 passed |
| Unit enum widened to arbitrary strings | `scenario.test.ts -t 'unit outside'` | Failed: illegal unit parse returned `success: true` | 1 passed |
| Nonempty expectation minimum removed | `scenario.test.ts -t 'nonempty step expectations'` | Failed: empty `byStep` returned `success: true` after isolating from missing-owner-step validation | 1 passed |
| Ledger-to-opening-balance comparison removed | `scenario.test.ts -t 'ledger that does not reconcile'` | Failed: inconsistent ledger parsed without throwing | 1 passed |
| Exact stock comparison disabled | `assertions.test.ts -t 'wrong stock quantity'` | Failed: expected `state.stock.atta` failure was absent | 1 passed |
| Missing-movement count check disabled | `assertions.test.ts -t 'wrong stock quantity'` | Failed: expected `state.movements.atta.receive.4` failure was absent | 1 passed |
| Movement count capped at one | `assertions.test.ts -t 'wrong stock quantity'` | Failed: duplicate movement was accepted | 1 passed |
| Bill line comparison disabled | `assertions.test.ts -t 'line tax'` | Failed: incorrect line-tax result passed | 1 passed |
| No-business-change comparison disabled | `assertions.test.ts -t 'refusals are no-ops'` | Failed: mutated stock was accepted | 1 passed |
| Sentinel comparison disabled | `assertions.test.ts -t 'refusals are no-ops'` | Failed: expected `sentinel.isolation` failure was absent | 1 passed |
| Ordered-call cursor ignored | `assertions.test.ts -t 'dependent tools'` | Failed: expected `tools.ordered` failure was absent | 1 passed |
| Forbidden-call guard disabled | `assertions.test.ts -t 'dependent tools'` | Failed: expected `tools.forbidden` failure was absent | 1 passed |
| Tool status comparison disabled | `assertions.test.ts -t 'tool result status'` | Failed: expected result-status failure was absent | 1 passed |
| Per-call refusal-code comparison disabled | `assertions.test.ts -t 'tool result status'` | Failed: expected refusal-code failure was absent | 1 passed |
| Candidate-evidence check disabled | `assertions.test.ts -t 'candidate lookup'` | Failed: expected `clarification.candidates` failure was absent | 1 passed |
| Question-shape check disabled | `assertions.test.ts -t 'candidate lookup'` | Failed: expected `clarification.shape` failure was absent | 1 passed |
| Fresh-read check after external change disabled | `assertions.test.ts -t 'fresh lookup'` | Failed: scenario incorrectly passed | 1 passed |
| IST boundary check disabled | `assertions.test.ts -t 'analytics evidence'` | Failed: cross-boundary scenario incorrectly passed | 1 passed |
| PDF signature check disabled | `assertions.test.ts -t 'real PDF signature'` | Failed: expected signature failure was absent | 1 passed |
| Artifact content check disabled | `assertions.test.ts -t 'real PDF signature'` | Failed: incorrect PDF content was accepted | 1 passed |
| Session-row deletion disabled | `EVAL_TEST_DATABASE_ADMIN_URL=<disposable> pnpm exec vitest run src/evals/seed.test.ts -t 'clears persisted conversation'` | Failed: one session remained where zero was expected | 1 passed against the dedicated DB |

I did not mutate every schema guard independently. The combined unknown-variant/strict-unknown-field
test was directly mutated through the tag enum only. The sentinel-identity refinement, duplicate
expectation IDs, missing owner-step expectation and cost/MRP seed refinement did not receive their
own mutation. The DB-backed tests did not separately mutate every snapshot query or each account,
ledger and preference comparison. Code review confirmed that `snapshotScenario` scopes each table
query to the supplied store ID, and `gradeState` compares account balances, optional ledger rows and
preference values. This is code-review evidence only; individual query/assertion mutations remain
unverified. Artifact body text and native PPTX chart counts are outside the current contract because
no PDF text extractor or PPTX chart fixture is available.

## Review-fix mutations (2026-10-07)

The following focused mutants were applied one at a time and restored before continuing. The
amendment's restored offline focused suite is 4 files, 26 passed, 2 skipped. The dedicated
Postgres focused suite is recorded below.

| Guard changed temporarily | Command | Mutant result |
| --- | --- | --- |
| Accept any call as candidate evidence | `pnpm exec vitest run src/evals/assertions.test.ts -t 'specific get_stock'` | Failed: empty/unrelated/malformed result lacked expected `clarification.candidates` failure; 1 failed, 8 skipped |
| Skip external-change reference validation | `pnpm exec vitest run src/evals/scenario.test.ts -t 'external changes with unknown'` | Failed: parser accepted unresolved reference; 1 failed, 11 skipped |
| Widen registered tool-name enum to arbitrary nonempty strings | `pnpm exec vitest run src/evals/scenario.test.ts -t 'expectation tool names'` | Failed: parser accepted `imaginary_tool`; 1 failed, 11 skipped |
| Skip generated-file signature validation | `pnpm exec vitest run src/evals/assertions.test.ts -t 'PDF signature'` | Failed: fabricated extracted text did not hide invalid PDF bytes; 1 failed, 8 skipped |
| Trust only fabricated `extractedText` instead of PDF bytes | `pnpm exec vitest run src/evals/assertions.test.ts -t 'PDF signature'` | Failed: wrong PDF bytes with claimed invoice text were accepted; 1 failed, 11 skipped |
| Disable PDF body-content assertion | `pnpm exec vitest run src/evals/assertions.test.ts -t 'PDF signature'` | Failed: incorrect invoice body was accepted; 1 failed, 11 skipped |
| Disable PPTX native-chart count assertion | `pnpm exec vitest run src/evals/assertions.test.ts -t 'real PPTX ZIP'` | Failed: wrong chart count was accepted; 1 failed, 11 skipped |
| Disable PPTX slide-text assertion | `pnpm exec vitest run src/evals/assertions.test.ts -t 'real PPTX ZIP'` | Failed: wrong deck content was accepted; 1 failed, 11 skipped |
| Disable exact stock grounding against the named entity and current quantity | `pnpm exec vitest run src/evals/assertions.test.ts -t 'exact current product'` | Failed: stale/wrong product result was accepted; 1 failed, 11 skipped |
| Disable exact customer grounding against the current balance | `pnpm exec vitest run src/evals/assertions.test.ts -t 'exact current customer'` | Failed: stale balance result was accepted; 1 failed, 11 skipped |
| Disable account balance comparison | `pnpm exec vitest run src/evals/assertions.test.ts -t 'persisted account balance'` | Failed: wrong persisted balance was accepted; 1 failed, 11 skipped |
| Disable ledger comparison | `pnpm exec vitest run src/evals/assertions.test.ts -t 'persisted account balance'` | Failed at the valid fixture assertion because the omitted guard no longer reconciled ledger; 1 failed, 11 skipped |
| Disable preference comparison | `pnpm exec vitest run src/evals/assertions.test.ts -t 'persisted account balance'` | Failed: wrong preference was accepted; 1 failed, 11 skipped |
| Omit persisted bill `total_paise` from snapshot query | `pnpm exec vitest run src/evals/seed.test.ts -t 'store-scoped row mapping'` | Failed: snapshot omitted the expected persisted aggregate total; 1 failed, 2 skipped |
| Omit independent line-tax recomputation | `pnpm exec vitest run src/evals/assertions.test.ts -t 'line tax'` | Failed: the valid fixture no longer matched its explicit computed line constants; 1 failed, 11 skipped |
| Omit bill-item GST rate from snapshot query | `pnpm exec vitest run src/evals/seed.test.ts -t 'store-scoped row mapping'` | Failed: snapshot lacked persisted `gst_rate_bps`; 1 failed, 2 skipped |
| Omit bill-item unit price from snapshot query | `pnpm exec vitest run src/evals/seed.test.ts -t 'store-scoped row mapping'` | Failed: snapshot lacked persisted `unit_price_paise`; 1 failed, 2 skipped |
| Omit account balance from snapshot query | `pnpm exec vitest run src/evals/seed.test.ts -t 'store-scoped row mapping'` | Failed: mapped balance became `NaN`; 1 failed, 2 skipped |
| Omit ledger amount from snapshot query | `pnpm exec vitest run src/evals/seed.test.ts -t 'store-scoped row mapping'` | Failed: mapped ledger amount became `NaN`; 1 failed, 2 skipped |
| Omit preference value from snapshot query | `pnpm exec vitest run src/evals/seed.test.ts -t 'store-scoped row mapping'` | Failed: preference snapshot was empty; 1 failed, 2 skipped |

Each source mutation above was restored. Restored outputs for the final projection and independent-tax
checks were respectively `1 passed, 2 skipped` and `1 passed, 11 skipped`. The remaining DB snapshot
assurance is bounded: the fake query client verifies selected columns and store filtering, while the
real dedicated-DB tests prove the snapshot maps current schema rows. Individual SQL-filter mutants
were not run for every table; store scoping is also verified by code review of each query's
`store_id` predicate or store-joined predicate.

The actual generated-file evidence is covered by `invoice.test.ts` and `deck.test.ts`: the invoice
test extracts generated PDF body text with `pdfjs-dist@6.3.289`; the deck test checks the actual
generated PPTX chart XML count and slide XML text. The report does not claim that line tax fields are
stored in the database; the DB stores bill-item inputs and bill aggregate totals only.

## Final review round (2026-10-07)

The fake `snapshotScenario` client now returns owner and foreign-store movement rows. It filters by
the query's bound store ID only when the SQL contains its store predicate. The restored focused
test passed (`pnpm exec vitest run src/evals/seed.test.ts -t 'keeps product unit'`: 1 passed,
2 skipped). Removing each predicate separately made the same test fail on the leaked row:

| Predicate mutated | Result |
| --- | --- |
| Primary `stock_movements WHERE store_id = $1` predicate | Failed: owner snapshot included `foreign-product` movement (1 failed, 2 skipped) |
| Sentinel `stock_movements WHERE store_id = $1` predicate | Failed: sentinel snapshot included primary-store movement (1 failed, 2 skipped) |

After restoring both predicates, the targeted test passed at 11:10:11: 1 passed, 2 skipped.

The generated invoice PDF text test also now requires `Sharma Kirana Store` and GSTIN
`27AAAAA0000A1Z5` from extracted PDF bytes, in addition to invoice number, customer, product,
and total. The full gate below reran this test against the explicitly configured disposable DB.
