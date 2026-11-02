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
  runner (`pnpm test:safe`) at commit `1ebae8e`: 562 passed, 19 skipped. Review the diff.
- [x] Commit the Phase 1 checkpoint before starting Phase 2: `1ebae8e`.

## Phase 2 — hosted open-weight voice helper

- [x] Implement a configurable hosted OpenAI-compatible adapter with typed triage, confidence
  threshold, timeout and fail-to-original behavior; add no third-party dependency.
- [x] Limit it to voice-transcript cleanup. Claude remains the only model that chooses tools or
  answers store questions. Preserve and delimit the original transcript and cleanup suggestion.
- [x] Keep it off by default. Verify off-path equivalence, tool-less request surface, malformed
  output, timeouts, confidence threshold, preservation and transcript injection fallback.
- [x] Add 30 mocked action/injection contract cases and a 45-case hosted-provider evaluation
  harness.
- [ ] Run the provider evaluation. No endpoint/key/model configuration is available; hosted
  quality, confusion matrix and latency are therefore not measured. The feature stays disabled.
- [x] Update architecture memory, privacy disclosures, `HANDOFF.md` and `.env.example` for the
  hosted-only design chosen by the user.
- [x] Run the full safe suite after the helper and evaluation harness: `pnpm test`, 570 passed,
  19 skipped; formatting, lint and typecheck pass.
- [x] Commit Phase 2 after final review.

No live Claude calls, production data/config, Railway settings, or deployment were used. Report
only measurements produced by commands actually run. `TIERING_ENABLED` remains false by default.
