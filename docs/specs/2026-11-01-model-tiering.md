# Hosted model tiering and Langfuse tracing

**Status: Approved for implementation**
**Branch:** `feat/langfuse-tier0-from-semantic-evals`

## Goal

Add production observability and evaluate a hosted open-weight model for tightly bounded helper
work, while keeping Claude Agent SDK as the only model that chooses or invokes SuperOps tools.
All model inference is hosted; Ollama and local model serving are out of scope. Both phases remain
opt-in where applicable, and no live Anthropic calls are made during implementation or evaluation.

## Current behavior

Telegram turns enter through `src/telegram/turn.ts`, which resolves store context, applies access,
rate and spend controls, calls `runCachedAgent`, records estimated turn cost in the daily `usage`
table, persists the session, and replies. The semantic cache wraps `runAgent`; the agent runtime
calls Claude Agent SDK `query()` and exposes tool-attempt, usage, retry and outcome evidence.
Voice audio is sent to OpenAI for transcription and the transcript uses the same turn path.
Tool observations are available through `src/tools/observe.ts` and already use the shared redactor.

## Phase 1: Langfuse Cloud

- Add optional Langfuse Cloud tracing configured by `LANGFUSE_PUBLIC_KEY`,
  `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL`. Without complete configuration, tracing is a
  no-op.
- Emit one pseudonymous trace per Telegram turn. Include model attempt/generation data, input,
  output and cache tokens, cost, latency, tool names/duration/outcome/confirmation status, retry
  data, semantic-cache result, and final outcome.
- Keep trace delivery fail-open and off the reply path: enqueue bounded metadata, never await
  network export in `handleTurn`, and bound shutdown flush. Export failures are logged without
  containing user content or secrets.
- Do not export message text, arguments or results by default. If
  `LANGFUSE_CAPTURE_CONTENT=true`, apply the existing privacy redactor before export. The operator
  must configure Langfuse retention; the app cannot enforce the 30-day deletion policy in a
  third-party service.
- Pseudonymize store identifiers using keyed HMAC; never send raw Telegram chat/store IDs or names.
- Ensure a turn's trace cost equals the micro-USD amount recorded in `usage` (including semantic
  embedding cost) and cover the equality in tests.
- Add a read-only local-DB usage report for daily request count, tool-error rate, idempotent replay
  count, semantic-cache hit rate, and cost per turn. Label observed sample size; current production
  deployment has one live user. Do not print the store ID.
- Update the data inventory, `/privacy`, system card, risk register and threat model in the same
  implementation commit as the new Langfuse data flow.

## Phase 2: hosted open-weight helper

- The primary agent remains Claude Agent SDK. It alone receives the existing SuperOps tool server,
  chooses tools, and handles all store facts and actions. The open model receives no tools and has
  no database access.
- Add an optional hosted provider adapter using an OpenAI-compatible API and environment-provided
  endpoint, key and model. Provider/model are configurable; no model identifier is hardcoded in
  business logic. Prefer a provider/model with documented structured output; verify actual API
  behavior with mocked contract tests and a separately runnable, explicitly opt-in connectivity
  probe only if credentials are provided.
- Limit the first helper experiment to voice-transcript cleanup. That task exists in
  `src/media/transcribe.ts`; the helper receives only the transcript, must preserve names,
  quantities, units, product terms, amounts and negation, and cannot replace the original. The
  hosted model returns a typed triage decision (`safe_to_normalize`, confidence, and optional
  candidate); low-confidence, ambiguous, empty, malformed, or tool-error cases keep the original.
  Keep the original transcription alongside any candidate so Claude can still interpret the
  source. Do not add stock/balance answer generation or session summarization unless code and
  labelled eval evidence justify a later spec.
- Keep the helper disabled by default (`TIERING_ENABLED=false`). Disabled means the existing voice
  and text behavior is unchanged. On missing configuration, timeout, invalid output or uncertain
  preservation, use the original transcript. Claude still handles the resulting user turn.
- The helper cannot receive any SuperOps tools, tool arguments/results, database access, or
  confirmation surface. Claude remains the only tool selector. Add explicit negative tests showing
  the helper cannot reach each mutating capability; evaluate tool-abuse text in transcripts as
  untrusted content that must remain data.
- Treat sending transcript text to another hosted provider as a new third-party data flow. Require
  provider terms/configuration review, no-training/retention controls where available, and disclose
  the provider and data category in the same privacy documents as Phase 1. Do not claim provider
  retention matches app-side 30-day retention.
- Keep labelled synthetic voice/transcript cases derived from existing billing/inventory evals
  and mock provider decisions in unit tests. Include paraphrases, misleading instruction text, and
  transcript examples requesting tool actions. Measure exact preservation of critical fields,
  correction usefulness, fallback rate and latency. Report the triage confusion matrix and the
  number of ambiguous or action-seeking inputs incorrectly labelled safe; that count must be zero.
  Report confusion/error categories and sample size for a real provider run; mocked contract tests
  are not model-quality evidence. Keep the flag off if any critical field is
  silently changed or if the hosted provider is not configured; make no Claude cost-saving claim.
- Record the conditional decision in `docs/DESIGN.md` and `tasks/agent_memory.md` as
  “tested, flag default off”. Railway has no local GPU requirement because inference is hosted.

## Security and privacy boundaries

The helper output is untrusted model output. It is an advisory candidate, never an instruction.
Both original and candidate remain delimited as data when supplied to Claude. No helper tool
surface is registered. Never send customer records, tool results or database snapshots to the
helper. Provider errors and traces must not include transcript content by default.

## Success measures

Phase 1: automated tests demonstrate one trace per turn, fail-open behavior, no raw identifiers,
content-off default, redaction when enabled, and exact cost reconciliation. The local report prints
measured database values with its time range and sample size.

Phase 2: offline labelled evaluation reports critical-field preservation, correction/fallback
rates and latency. No quality or savings claim without a measured run. If provider credentials are
unavailable, adapter and mocked tests can be completed, but model quality is explicitly
“not measured” and the flag stays off.

## Risks and decisions

- A hosted helper adds a vendor and sends voice transcript text outside Anthropic/OpenAI. Provider
  and retention must be documented accurately; user-visible disclosure is required.
- Transcript “cleanup” can turn a misheard number into a confident wrong number. Preserve original
  text and require semantic invariants plus measured evaluations; otherwise disable the helper.
- Langfuse Cloud retention is controlled by Langfuse account settings, not the application.
- Do not add a large dependency without owner approval; prefer a small SDK already compatible with
  the current Node runtime or direct HTTP with typed validation.
