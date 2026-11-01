# Implementation plan: Langfuse Cloud tracing

**Status: Approved for implementation**
**Approval:** User approved Phase 1 before implementation.

## Phase 1 — Langfuse checkpoint

- [x] Add a small trace boundary and testable in-memory/no-op exporter; keep exporter failures
  isolated from Telegram replies and DB writes.
- [x] Inspect exact SDK lifecycle and usage evidence in runtime/cache/turn path; construct one
  trace per turn and attach model attempts, token/cost data, tool observations, retries, cache
  outcome and final result.
- [x] Use keyed HMAC pseudonyms, content-off defaults, and existing redaction for explicit content
  capture.
- [x] Reconcile traced cost with `recordUsage` including cache embedding cost; add equality tests.
- [x] Add local read-only usage report querying the existing database tables; document query range
  and live-user sample count without exposing IDs.
- [x] Update all five privacy/safety documents and `/privacy` in the same commit that introduces
  Langfuse export; add placeholders to `.env.example` only.
- [x] Update the Langfuse privacy disclosures in the data inventory, `/privacy`, system card,
  risk register and threat model in the same commit as the implementation.
- [x] Update `.env.example` with placeholders only and refresh `HANDOFF.md`.
- [x] Run formatting, lint, typecheck and full tests using the repository's disposable-database
  runner (`pnpm test:safe`): 567 passed, 19 skipped. Review the diff.
- [ ] Commit this Phase 1 checkpoint before starting Phase 2.

No live Claude calls, production data/config, Railway settings, or deployment were used. Report
only measurements produced by commands actually run.
