# Threat model

**Status:** partial

I use the boundaries below to describe controls and open work. This document is not a certification
or a claim that all risks are eliminated. The model prompt is not an authorization boundary; tool
schemas, repositories and Telegram owner checks enforce business actions.

## Assets and trust boundaries

Assets include stock, prices, bills and tax, customer credit and contact details, owner preferences,
conversation transcripts, generated files, confirmation rows, invite hashes, spend records and
credentials. Trust boundaries are Telegram input and callbacks, model output, catalogue and
preference text, store-scoped database access, filesystem artifacts, logs, Anthropic text processing
and OpenAI voice transcription.

## Threats and controls

| Threat | Control in code | Status | Evidence or remaining work |
|---|---|---|---|
| Prompt injection in owner text or a product name | Tool allow-list and grounding; product and preference data remain data; business rules live in tools and schema. | partial | Preference boundary is tested. Full live agent behavior has no accepted live baseline. W7 adds synthetic replay only. |
| Cross-store request or leaked store identifier | Store ID is injected from authenticated private chat; repository reads and writes carry tenant predicates. | implemented | W1/W2/W4 repository tests cover tenant and owner boundaries. |
| Telegram callback replay or callback theft | Short opaque callback ID maps to a DB row; row binds store, owner, action arguments and optional bill fingerprint; 10-minute expiry and atomic single-use claim. | implemented | Confirmation repository and Telegram tests cover owner mismatch, replay, expiry and mutation-free pending path. |
| Telegram parse-mode interpretation of untrusted text | Outgoing bot messages currently do not set `parse_mode`; privacy route has an adapter assertion. | partial | No broad test asserts this for every send path. Keep untrusted output as plain text unless escaping is added and tested. |
| Destructive or financial tool call without owner confirmation | W1 callback route executes model-free; below-cost override, bill void, overpayment and customer pseudonymisation use the confirmation table. | implemented | Confirmation integration tests. Ordinary domain rules remain enforced in tools. |
| Preference injection or malformed legacy value | Strict payment enum, GSTIN shape, catalogue-validated brand, unknown/invalid keys ignored, bounded prompt data rendering. | implemented | Preference repository and runtime tests. |
| Transcript disclosure or unsafe export of another tenant | Owner-only export, store-scoped data queries, fail-closed orphan transcript check, temporary export deletion after delivery attempt. | partial | Indexed artifact metadata is exported; file contents and metadata for historical unindexed files are omitted. Provider-held data is outside app export. |
| Credential exposure in deployment logs or configuration | Existing redactor; secrets are read from environment and must not be copied into reports. | partial | The Telegram bot token and Anthropic API key previously reached deployment logs and must be rotated. Rotation is an operator action still pending. |
| Resource and spend abuse | Per-run limits, per-store daily spend limit, per-chat rate limit, update claims and fixed tool allow-list. | partial | No live cost semantics run is accepted; budget behavior is tested with synthetic/mocked usage. |
| User asks for store erasure before record treatment is reviewed | No store-erasure command or mutation path exists. | not done | Legal review must decide treatment of accounting, audit, invoice and provider data first. |

## Reference mapping

I use the OWASP Top 10 for LLM Applications (2025), OWASP Top 10 for Agentic Applications
(2026), and NIST AI RMF Govern, Map, Measure and Manage as organizing references. Mapping a row
here does not establish conformance or certification.

| Reference theme | Relevant threats and current evidence |
|---|---|
| OWASP LLM prompt injection and sensitive information disclosure | Catalogue/preference injection and transcript/export boundaries above; preference controls are implemented, broader agent behavior remains partial. |
| OWASP Agentic tool misuse and excessive agency | Fixed allow-list, store-scoped tools, owner-bound callbacks and financial tool guards. Live behavioral measurement remains open. |
| NIST Govern and Map | Named project-maintainer role owns risk follow-up; data boundaries and open legal decisions are recorded in the inventory and risk register. |
| NIST Measure and Manage | Deterministic tests and synthetic replay run offline; live evaluation is not executed without credits and a separate budget decision. |

## Operational assumptions

The bot runs as one Railway replica with long polling and a PostgreSQL database. Deployment access,
log retention, backup deletion, Telegram retention and provider retention were not verified as part
of this work. Treat them as outside the controls described here until checked by the operator.
