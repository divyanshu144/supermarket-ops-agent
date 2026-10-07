# Responsible AI implementation plan

Status: approved by the owner on 2026-10-07. Work is split into reviewable tasks; each starts with tests, then a small implementation, mutation checks, and a stop gate. Commit each completed task locally on `responsible-ai`; never push. Do not run live model calls or probes.

## Preconditions and sequencing

1. Owner approval and decisions are recorded in [the spec](../specs/2026-10-07-responsible-ai.md).
2. Start W1, then W2, then W5, W3, W4 customer pseudonymisation/export slice, W6, and W7. Store erasure is explicitly not done pending legal review.
3. For each workstream: inspect current code and migrations; write failing tests first; implement only that workstream; run the relevant tests and mutation checks; run the repository verification gate at the checkpoint. Do not proceed after a failed stop condition.
4. Use only an explicitly disposable database URL for database tests. Do not read `.env`, use the normal local database, or run live model calls/probes. Keep credentials out of output.
5. Update `HANDOFF.md`, `tasks/todo.md`, and `tasks/lessons.md` at each checkpoint. Commit each finished task locally; never push.

## W1: enforce confirmation for high-impact exceptions

**Files expected to touch:** `src/telegram/bot.ts`; a narrow callback handler such as `src/telegram/callbacks.ts`; an agent-facing model-free facade; `src/tools/billing.ts`; `src/tools/khata.ts`; `src/db/schema.ts`; additive migration and targeted repositories; billing/khata skills; unit and integration tests.

**Tests to write first:** unconfirmed below-cost finalize, bill void, and overpayment produce no mutation; confirm is bound to the originating user/store/action digest; cancel has no effect; expired, modified, and replayed callbacks fail; concurrent callback delivery causes one effect; retry after action completion returns the same outcome; callback path does not invoke the model; audit contains no message or arguments.

**Implementation:** store `owner_user_id` when an invite is redeemed in a private chat. Add owner binding additively; legacy stores with null owner fail closed. Persist an opaque single-use pending action with 10-minute expiry, store and owner binding, exact tool arguments, idempotency key, and a bill fingerprint over current lines and prices. Send a keyboard with short callback ID mapped to the row. Confirm atomically claims the action, rechecks the bill fingerprint, and executes through a model-free facade. The model-visible tool returns an awaiting-confirmation result; it never performs or claims completion. Add Confirm/Cancel callbacks routed through Telegram. Update skill descriptions to match.

**Mutations:** remove callback user binding; permit a second successful claim; skip expiry; route execution without confirmation; make retry execute a second settlement. Each corresponding test must fail.

**Stop if:** schema change is not additive, authorization relies only on prompt text, replay/concurrency can duplicate a financial mutation, or any log/audit record contains the action payload or customer data.

## W2: treat preferences as untrusted data

**Files expected to touch:** preference schema/validation, `src/tools/preferences.ts`, `src/agent/runtime.ts`, focused tests, and only the skill/docs that describe preference behavior.

**Tests to write first:** valid existing preferences continue to affect behavior; unknown legacy keys do not enter model context; hostile text remains a value and cannot add tools or override policy; invalid or oversized values are rejected; logs do not contain preference values.

**Implementation:** define strict typed supported keys: payment-mode enum; GSTIN strict format; brand must match an existing store catalogue value. Ignore invalid/unknown legacy keys and log a count, never the values. Delimit any remaining rendered values as secondary defense. Preserve valid use cases only where their values meet the new format.

**Mutations:** restore raw key/value interpolation; remove the key allow-list; remove length/type validation. Require each test to fail.

**Stop if:** a known preference silently stops working, hostile content becomes instruction text, or remediation requires an unreviewed data-destructive migration.

## W5: explain data and AI use to owners

**Files expected to touch:** `src/telegram/commands.ts`, `src/telegram/messages.ts`, `src/config/env.ts`, message tests, and `README.md`.

**Tests to write first:** `/privacy` accurately identifies Anthropic text processing and OpenAI voice transcription; onboarding identifies AI use; unset `PRIVACY_CONTACT` uses the invite-issuer fallback; claims match the actual retention configuration and data inventory.

**Implementation:** add concise `/privacy` and onboarding copy, optional validated contact configuration, fallback text “ask whoever gave you your invite”, and links to export/customer pseudonymisation instructions. State implemented 30-day app retention and do not make provider-retention claims.

**Mutations:** delete the AI disclosure; falsely state voice never leaves the app; show an invented contact or retention guarantee. Tests must fail.

**Stop if:** provider flow cannot be verified, text promises unknown provider retention, or copy implies a legal conclusion.

## W3: retention and artifact lifecycle

**Files expected to touch:** `src/config/env.ts`, `.env.example`, `src/db/schema.ts`, an additive `generated_artifacts` migration, artifact and update repositories, `src/tools/context.ts`, document tools, `src/retention/worker.ts`, `src/index.ts`, `src/telegram/gate.ts`, `src/telegram/bot.ts`, `src/telegram/commands.ts`, `src/telegram/messages.ts`, `src/media/download.ts`, `src/media/transcribe.ts`, relevant tests, README and handoff docs.

**Tests to write first:** injected-clock cleanup at the configured age; claimed/recovering sessions are retained; repeated cleanup is idempotent; generated artifacts expire; cleanup logs counts only; voice path creates no persistent audio file.

**Implementation:** add validated configurable retention at the proposed default of 30 days since last activity for transcripts and indexed artifacts. Make cleanup tenant-aware and safe around in-flight update claims by taking an explicit PostgreSQL row lock on stores in ascending order, shared with `claimUpdate`. Track new generated artifacts by store and bill, refresh their activity on authenticated owner updates, and regenerate indexed invoice PDFs from finalized bills before expiring their old files. The additive registry has no backfill: historical files with no unambiguous store mapping remain unindexed and expire by filesystem modification time until they age out. Delete JSON export files immediately after send or failure (the export path lands in W4). Keep transcription buffers in memory. Document that external providers’ retention is outside this cleanup.

**Mutations:** delete a claimed session; remove tenant filtering; log the deleted transcript or customer field; skip artifact cleanup; write voice audio to disk. Each guard test must fail.

**Stop if:** a safe scheduler is unavailable, worker cannot identify tenant ownership, or the design implies deletion at an external provider.

### W3 corrective follow-up after W6 review

The independent W6 review found that the worker had not connected the approved invoice-regeneration behavior to artifact cleanup and used filesystem modification time for all artifacts. The W3 worker currently deletes sessions using `store_id`; schema inspection confirms `sessions.store_id` is the primary key, so there can be only one session row per store, but the delete predicate will be narrowed to that row's session ID for clarity. Tests are written before the implementation changes. No historical artifact backfill will be attempted because old filenames do not safely identify a store or bill. This follow-up must be independently reviewed and gated before W6 can be completed.

## W4: export and erasure

**Files expected to touch:** owner commands and messages; new export/erasure service or tools; tenant-scoped repositories; additive schema/migration only if essential; integration tests; privacy/data inventory docs.

**Tests to write first:** store A cannot export store B; orphan transcript rows cause a fail-closed incomplete-export response; export includes a manifest; preview counts match the target; customer erasure links only the selected customer’s records; execution requires W1 confirmation, is idempotent, and leaves a content-free audit event.

**Implementation:** owner-only JSON export with a manifest; fail closed on orphaned transcript ownership. Build preview-before-execute customer pseudonymisation with stable placeholder, cleared phone, notes, and payment references, retaining bill/ledger amounts. Gate execution through W1. Store erasure is NOT DONE and is documented as pending legal review; do not create its command or mutation path.

**Mutations:** remove a store predicate; skip orphan detection; execute without confirmation; leave phone/note content; repeat erasure and duplicate audit. Tests must fail.

**Stop if:** customer pseudonymisation cannot be implemented without an unapproved non-additive migration, any row’s tenant ownership is unclear, or export could present an incomplete transcript set as complete. Store erasure remains not done regardless of W4 completion.

## W6: data inventory and safety documents

**Files expected to touch:** `docs/privacy/data-inventory.md`; `docs/safety/threat-model.md`; `docs/safety/dpia-lite.md`; `docs/safety/system-card.md`; `docs/safety/risk-register.md`; `docs/safety/incident-runbook.md`; README safety/privacy links.

**Tests to write first:** add a lightweight consistency check for safety status vocabulary, referenced files, and README links if existing tooling supports it; otherwise define a manual review checklist and verify each claim against its test/control evidence.

**Implementation:** inventory data, purpose, location, access, retention status, and processor path; map concrete threats and controls to OWASP LLM 2025, OWASP Agentic 2026, and NIST AI RMF. Mark each control implemented, partial, not applicable with reason, or not done. Include incident containment, credential rotation, evidence preservation, and owner communication steps without exposing secrets.

**Mutations:** mark a known missing control as implemented; remove an identified threat; claim certification/compliance. A doc consistency check or reviewer checklist must catch each.

**Stop if:** documents claim compliance, provider retention, or control coverage without evidence; unresolved risks have no owner/action/status.

## W7: synthetic safety evaluation

**Files expected to touch:** eval scenario schema and runner in `src/evals/`; synthetic fixtures in `evals/`; CI workflow; eval docs and README.

**Tests to write first:** replay asserts no cross-store data/tool access, no mutation without confirmation, no unrelated customer PII disclosure, and bounded tool behavior for spend-abuse scenarios. Ensure replay tags select safety cases and run without credentials.

**Implementation:** add synthetic replay cases for catalogue prompt injection, cross-store access, delete/stock-destruction requests, customer-data fishing, and tool/cost abuse. Report only deterministic replay checks. Add a manual live runbook with a small configured cap for later credentialed use; do not run it now.

**Mutations:** delete a tenant assertion, accept a forbidden tool in the trace, remove safety tag filtering, or make replay invoke a model. Each should fail an offline test.

**Stop if:** CI needs an API key, outputs are represented as live model quality, or safety assertions only grade reply wording rather than state and tool trace.

## Checkpoint and completion criteria

At every workstream checkpoint, report changed files, exact gate output, tests and mutations attempted, synthetic versus live evidence, unresolved risks, and updates made to handoff/todo/lessons. Do not call a workstream complete if a mutation survives or the gate cannot be run safely. The overall project remains incomplete until all approved workstreams are implemented and reviewed; this document alone is a proposal.
