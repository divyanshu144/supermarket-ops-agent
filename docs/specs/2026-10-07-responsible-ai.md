# Responsible AI, data protection, and safety

Status: approved by the owner on 2026-10-07 with the decisions recorded below. This document defines implementation across W1–W7. It is not a legal assessment and makes no claim that the project complies with any law or standard.

## Problem and goals

The bot handles shop inventory, bills, customer credit, owner preferences, model context, voice transcripts, and generated documents. The repo already has useful safeguards, including tenant-scoped tools, prompt grounding, a tool allow-list, secret redaction, and eval replay. Some high-impact controls still live only in skill instructions, the data lifecycle is not explicit, and the repo has no user-facing privacy information or systematic safety register.

I will close those gaps with enforceable controls, migration-safe data handling, tests that try to break the controls, and documentation that describes only verified behavior. The work must preserve the domain → tools → agent → telegram dependency direction and the locked stack. Money remains integer paise. Live model calls and probes remain prohibited for this task.

## Design choices

### W1: confirmation for high-impact exceptions

I choose a Telegram inline Confirm/Cancel button, not a typed confirmation token. The owner can see the action and tap once; this avoids asking the language model to interpret a second phrase as authorization and avoids exposing a reusable secret in chat history. A callback is bound to the initiating Telegram user, store/chat, action and argument digest, expires, and is single-use. A model-free callback path passes the confirmed action through a narrow facade to the tool/service layer. The database claim and action must be atomic or idempotent under update retries; check-then-write is not acceptable.

Initial scope is the below-cost bill override (`finalize_bill` with `allow_below_cost`), bill void, and khata overpayment override (`settle_khata` with `allow_overpay`). These are materially different from routine stock receipt, ordinary billing, and normal settlement. The skill currently asks for confirmation, but handlers accept booleans; the control must move to an enforceable path. Do not add a blanket confirmation to normal actions without evidence that it is needed.

The owner is the Telegram user who redeemed the invite, stored as `owner_user_id` on the store. Invite redemption and owner-only actions are accepted only in private chats. Legacy stores without an owner ID and group chats fail closed. Confirmation lifetime is 10 minutes. A pending result is rendered as an inline keyboard whose callback data contains only a short opaque ID mapped to a database row, staying within Telegram's 64-byte callback limit. The pending row binds the store, owner, action, tool arguments, and for bills the hash of current bill lines and prices. Confirmation rechecks that hash and executes through the model-free adapter path. The model's result must say “awaiting confirmation”, never claim the operation is done. Audit events are additive and contain store/action/outcome/update identifiers and time, but no message text, arguments, customer names, or phone numbers. User identity is an access-control input and is kept out of ordinary logs.

### W2: preference prompt-injection boundary

Preferences are untrusted data, not instructions. Define supported keys and strict per-key formats: enum payment modes, a GSTIN pattern, and brand values validated against that store's catalogue. Ignore unknown or invalid legacy values without logging their value and log only a count. Do not interpolate free-form preference values into policy instructions. Prompt delimiters are secondary defense. Tests must show hostile values cannot change available tools or policy and valid legacy values still work.

### W3: retention and deletion

Transcript and artifact retention is 30 days from last activity, configurable through validated configuration and applied by an idempotent scheduled cleanup. The worker must not delete a session while its update is claimed or being recovered. It logs counts only. Invoices regenerate from finalized bills before an expiring PDF is deleted. Export files are deleted immediately after sending, including failure paths. Audio remains in memory for transcription and is never written to disk. This app cannot promise deletion by Telegram or model providers.

### W4: export and erasure

Build store-scoped JSON export and customer pseudonymisation now. Export is scoped by authenticated owner and store, includes a manifest, and fails closed if session transcript ownership cannot be mapped. Customer erasure pseudonymizes the khata account and linked bill customer name with a stable placeholder, clears phone and free-text notes/payment references, and retains amounts and accounting records. This treatment is subject to legal review and will be surfaced as such. Store erasure is **NOT DONE** and must not be implemented pending legal review. Require owner-only access and W1 confirmation for customer pseudonymisation, with a preview/count before execution.

### W5: user-facing transparency

Add a `/privacy` response and a concise disclosure during onboarding. State that the bot uses an AI model, what data the app stores, that voice transcription is sent to OpenAI when voice is used, and that text may be sent to Anthropic for replies. State the implemented 30-day app retention behavior, without provider-retention promises. Provide export and customer pseudonymisation instructions and optional `PRIVACY_CONTACT`; if unset, say “ask whoever gave you your invite”. Do not invent a legal basis, contact address, or provider retention promise.

### W6: threat and governance documentation

Create a data inventory, threat model, lightweight impact assessment, system card, risk register, and incident runbook. Map controls to OWASP Top 10 for LLM Applications (2025), OWASP Top 10 for Agentic Applications (2026), and the NIST AI RMF functions (Govern, Map, Measure, Manage). These are organizing references, not certifications. Mark every control implemented, partial, not applicable with reason, or not done. Include legal review as an open dependency for retention and erasure decisions.

### W7: safety evals

Extend the existing TypeScript eval scenario tags and synthetic replay set with prompt injection via catalogue data, cross-store requests, destructive requests without confirmation, disclosure about another customer, and spend-abuse attempts. Assert database outcomes and tool traces first. CI uses replay only; no model calls or fabricated scores. Live evals remain manual and budget-capped when credentials are available.

## Workstream acceptance matrix

The paths below are proposed implementation scope; the plan orders tests before implementation. Each mutation is run by deliberately breaking the relevant guard and verifying the named test fails, then restoring the guard. Any mutation that survives is a stop condition.

| Workstream | Files expected to change | Tests to write first | Mutations to run | Stop conditions |
|---|---|---|---|---|
| W1 confirmation | `src/telegram/bot.ts`, `src/telegram/callbacks.ts` (new if needed), `src/agent/runtime.ts` or narrow facade, `src/tools/billing.ts`, `src/tools/khata.ts`, `src/db/schema.ts`, migration, `src/db/repositories/*`, `.claude/skills/billing/SKILL.md`, `.claude/skills/khata/SKILL.md` | callback owner/store/action binding; expiry; replay; cancel; no mutation before confirm; confirmed override and void; retry/idempotency; failed confirm does not leak args | remove user binding; make callback reusable; bypass confirmation in one override handler; allow expired callback | Stop if confirmation cannot be single-use and retry-safe, or requires a backwards-incompatible/non-additive migration touching existing data. |
| W2 preferences | `src/tools/preferences.ts`, `src/agent/runtime.ts`, preference schema/validation, tests and relevant skill | supported legacy values remain effective; unknown keys ignored; hostile value remains data; invalid size/type rejected; no secret/value in logs | interpolate raw preference as instruction; remove key allow-list; remove value bound | Stop if existing supported preference behavior cannot be preserved or safe rendering cannot be demonstrated. |
| W3 retention | `src/config/env.ts`, `.env.example`, `src/db/schema.ts`, additive generated-artifact metadata migration/repository, `src/tools/context.ts`, document tools, `src/retention/worker.ts`, `src/index.ts`, `src/telegram/gate.ts`, `src/telegram/{bot,commands,messages}.ts`, `src/media/{download,transcribe}.ts`, relevant tests, README and handoff docs. | injected-clock expiry; claimed/recovering session retained; claim/cleanup lock race; idempotent retry; indexed artifact activity; legacy artifact timestamp behavior; invoice regeneration before expiry; audio memory-only/no disk across Telegram handler, downloader, and transcription; count-only logs | delete claimed session; remove store lock; remove orphan exclusion; remove idempotency; log deleted values; bypass artifact activity; skip invoice regeneration; write audio to disk in each voice stage | Stop if scheduler cannot run safely, ownership is ambiguous, migration is not additive, or provider-side deletion is implied. |
| W4 export/erasure | `src/telegram/commands.ts`, `src/telegram/messages.ts`, new export/erasure tools or services, repositories, schema/migration only if additive, tests, `.claude/skills/*` as needed | cross-store export denial; orphan transcript fail-closed; export manifest; erasure preview; customer links; confirmed idempotent execution; audit contains no content | remove tenant predicate; skip orphan check; erase without confirmation; retain phone/note | Stop pending legal/product approval of retention and financial-record treatment; stop if any row cannot be safely assigned to a tenant. |
| W5 transparency | `src/telegram/commands.ts`, `src/telegram/messages.ts`, `src/config/env.ts`, tests, `README.md` | `/privacy` includes actual providers and data; absent contact fallback; onboarding disclosure snapshot | remove AI/provider disclosure; display fabricated contact or retention promise | Stop if provider/data-flow statements cannot be verified from code or copy implies legal compliance. |
| W6 governance docs | `docs/privacy/data-inventory.md`, `docs/safety/{threat-model,dpia-lite,system-card,risk-register,incident-runbook}.md`, `README.md` | link/claim checks or a small documentation consistency test; verify status rows against code/tests | change a partial/not-done row to implemented without control evidence; remove a known risk row | Stop if any doc makes an unsupported compliance or safety claim, or a risk has no owner/action/status. |
| W7 safety evals | `src/evals/schema.ts`, `src/evals/*`, `evals/scenarios/*`, replay fixtures, CI workflow, README/eval docs | synthetic traces assert no cross-tenant read, no unauthorized mutation, no PII disclosure, and bounded tool/cost behavior | remove tenant/refusal assertion; allow tool call in golden trace; drop safety tag selection | Stop if replay requires credentials, if assertions inspect only reply text, or if results are presented as live model performance. |

## Data inventory and boundaries

The inventory must verify each field and flow against current schema and code before implementation. Known candidate data includes Telegram chat/store identifiers, owner messages and agent session transcripts, preferences, product names/brands, customer names and phone numbers, bill totals and payment references, khata balances/notes, generated invoices/decks, update IDs, usage/cost counters, and voice transcripts. Voice is currently buffered in memory for transcription; generated artifacts are written under `ARTIFACT_DIR`. The system sends model context to Anthropic and voice audio to OpenAI. Exact provider retention settings are unknown and must not be represented as controlled by this app.

Threat boundaries include an untrusted owner message, untrusted product/customer/preference text, model output, Telegram callback replay, Telegram parse-mode interpretation and escaping, tenant/store identity, database/session records, generated artifacts, and external model/transcription services. Tool schemas and repositories remain authoritative for business constraints. The system prompt is not a security boundary.

## Security and migration requirements

- Preserve store predicates in every read and write; test with two stores.
- No raw message, tool arguments, customer details, audio, or secrets in new audit/log/trace paths.
- Use additive migrations. Backfill only when ownership is unambiguous; fail closed on orphan session entries.
- Validate callbacks and destructive commands at the tool/service boundary, not only in prompt or skill text.
- Keep action execution idempotent under Telegram update retries and process recovery.
- No model or external service call in replay CI.
- Update docs only after tests and code substantiate the claims.

## Implementation constraints and deferred decisions

1. Store erasure remains not done until legal review decides the treatment of invoices, ledger entries, and audit records.
2. Customer pseudonymisation keeps financial amounts and ledger rows; legal review remains open.
3. No owner ID is inferred for legacy stores. Those stores and all group-chat owner actions fail closed until separately provisioned.

## References

- [OWASP Top 10 for LLM Applications 2025](https://genai.owasp.org/resource/owasp-top-10-for-llm-applications-2025/)
- [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)
- [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework)
- [NIST AI RMF Playbook](https://www.nist.gov/itl/ai-risk-management-framework/nist-ai-rmf-playbook)
- [India MeitY DPDP Rules 2025 portal](https://www.meity.gov.in/documents/act-and-policies/digital-personal-data-protection-rules-2025-gDOxUjMtQWa?pageTitle=Digit)
- [Digital Personal Data Protection Rules 2025, Gazette notification](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf)
- [EU Artificial Intelligence Act, official text](https://eur-lex.europa.eu/eli/reg/2024/1689/oj)
