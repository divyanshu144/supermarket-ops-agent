# W3 retention correction results

This correction closes two issues found during the W6 independent review: generated files were not
using owner activity for expiry, and indexed invoice PDFs were not regenerated before their old
copies expired. A further review found that artifact expiry also needed to respect an in-flight
Telegram claim. The migration adds an artifact registry without backfilling or changing existing
rows. Historical files with no registry row still expire by filesystem modification time because
their owner and bill cannot be inferred safely.

The indexed-artifact worker now refreshes expiry on authenticated owner updates, protects stores
with active claims, regenerates an expiring indexed invoice from its finalized bill, and removes the
old PDF only after a replacement has been registered. Unexpected regeneration errors retain the old
PDF for a later retry. Store export contains only that store's artifact metadata; it omits file
contents and states that unindexed historical files cannot be mapped safely.

## Mutation record

Each guard below was deliberately weakened, the focused test was run against the disposable database,
and the production change was restored immediately after observing the expected failure.

| Guard weakened | Test that failed | Observed result |
| --- | --- | --- |
| Removed the indexed-artifact `lastActivityAt` cutoff | `src/retention/worker.test.ts` activity-vs-mtime test | Failed: expected one deletion, received two. |
| Bypassed invoice regeneration before expiry | `src/documents/invoice.test.ts` expired invoice test | Failed because no replacement invoice metadata was created. |
| Removed owner activity refresh from the authorized Telegram gate | `src/telegram/gate.test.ts` owner activity test | Failed: expected the activity refresh once, received zero calls. |
| Allowed the non-owner `/start` exception to refresh owner activity | `src/telegram/gate.test.ts` non-owner exception test | Failed because the activity helper was called. |
| Bypassed artifact registry insertion | `src/retention/worker.test.ts` artifact registration test | Failed because the generated artifact row was absent. |
| Removed the store predicate from exported artifact metadata | `src/repositories/privacy.test.ts` two-store export test | Failed: expected one artifact, received two. |
| Removed active-claim protection from indexed-artifact expiry | `src/retention/worker.test.ts` in-flight claim test | Failed: expected zero deletions, received one. |
| Changed the export manifest to describe the old no-index behavior | `src/repositories/privacy.test.ts` manifest test | Failed because the manifest did not disclose indexed metadata and historical unindexed files accurately. |

All mutations were restored. The exact session delete predicate is tested by the retention suite;
schema inspection confirmed `sessions.store_id` is the primary key, so a broader store predicate is
equivalent under the current schema and was not counted as a meaningful mutation.

## Review and verification

Fresh independent review after the active-claim fix found that export-manifest wording still described
the previous absence of an artifact index. The test was updated first and failed against the old
wording; the manifest was then corrected. A second fresh review confirmed that the export now
distinguishes indexed metadata from omitted file contents and historical unindexed files, and found
no remaining actionable findings.

No live model calls, probes, credentials, or `.env` contents were used. The required full gate and
commit result are recorded in `HANDOFF.md` after the final correction gate.
