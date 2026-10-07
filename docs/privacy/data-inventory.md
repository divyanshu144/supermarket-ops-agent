# Data inventory

**Status:** partial

I verified these paths against the current Drizzle schema, repositories, Telegram handlers, model
runtime, media code, and retention worker. This inventory describes app-side handling. Telegram and
model providers may retain data under settings the app cannot inspect or control.

| Data | Why the app handles it | App location and access path | Retention or deletion | External processing and status |
|---|---|---|---|---|
| Store ID, owner Telegram user ID, invite-code hash | Resolve a shop and authorize its owner | `stores`, `invite_codes`; access and invite repositories | Store lifetime. Store erasure is not done. | Telegram supplies identifiers. Implemented access gate; store erasure not done. |
| Product names, brands, HSN/GST values, prices and stock | Catalogue and inventory operations | `products`, stock movement tables; store-scoped tools | Store lifetime unless edited through tools. | Product fields may enter model context as tool results. Tenant predicates are implemented and tested. |
| Bills, bill lines, totals, tax and payment references | Billing, invoice generation and accounting | `bills`, `bill_items`; billing repositories and invoice generator | Accounting rows are retained by this app. Proposed erasure approach is customer pseudonymisation, which retains amounts and ledger rows; not a legal conclusion. | Model receives tool-shaped values when needed. Implemented store export. |
| Khata customer names, phone numbers, balances, notes and entries | Customer credit and payment tracking | `khata_accounts`, `khata_entries`; khata tools | Proposed customer pseudonymisation clears phone, free-text notes, linked bill names and payment references. Amounts and rows remain. Store erasure is not done pending legal review. | Customer data may enter model context through tool results. Owner confirmation is required for pseudonymisation. |
| Owner preferences | Apply supported shop defaults | `preferences`; preferences repository and validated prompt rendering | Until changed or store erasure is reviewed. Invalid legacy values are ignored. | Only validated enum, GSTIN-shape and catalogue-brand values are rendered as bounded data. Implemented. |
| Owner messages and assistant/tool transcript entries | Resume conversations and inspect prior turns | Agent SDK session mirror in `sessions` and `session_entries`; transcript repository | Proposed default: 30 days after last activity, configurable in days. The worker removes app-owned transcript data. | Text may be sent to Anthropic for replies. Provider retention is unknown to this app. Implemented app-side worker; provider deletion not done. |
| Voice audio and transcription text | Convert an owner voice note into a turn | Audio is buffered in memory; transcription text continues through the ordinary turn/session path | Audio is not written to disk by the current path. Transcript follows the proposed 30-day inactivity retention. | Audio is sent to OpenAI for transcription when voice is used. Provider retention is unknown. |
| Generated invoice and deck files | Return invoice or analysis documents | Files under `ARTIFACT_DIR`; `generated_artifacts` stores each new file's store, last activity and optional bill link. | Proposed default: expire after 30 days from the last authenticated owner Telegram update. New indexed invoice PDFs regenerate from their finalized bill before the old file is deleted. Historical files without an index cannot be mapped safely; they expire by filesystem modification time until they age out. | Generated documents may contain store and customer data. `/export` includes indexed artifact metadata but omits file contents and metadata for historical unindexed files; the manifest names this limit. |
| Temporary JSON export | Give the authenticated owner a copy of app records | Unique file under `ARTIFACT_DIR`, mode `0600`, then Telegram document delivery | Deleted immediately after the send succeeds or fails. | Telegram receives the export as a document. Provider retention is not controlled by this app. |
| Usage, update claims, confirmation and audit metadata | Spend limits, retries, safe high-impact actions and recovery | `usage`, `processed_updates`, `pending_actions`, `audit_log`; repositories | Usage and accounting metadata follow database lifecycle. Pending actions expire after 10 minutes; expired rows are not an erasure mechanism. | Audit rows omit message text, tool arguments and customer details. Implemented and tested. |
| Application logs | Diagnose operations and failures | Process logs through the existing redactor | Log-provider retention is outside the repository's control and has not been verified here. | New W4 paths log no export content or pseudonymisation payload. |

## Boundaries and gaps

Owner identity is the Telegram user who redeemed the invite. Legacy stores with no recorded owner and
group chats fail closed. Export is store-scoped and fails closed if transcript rows cannot be
assigned safely. Customer pseudonymisation does not rewrite old transcript mentions; its Telegram
preview says so. Export includes indexed artifact metadata, not invoice/deck contents. Historical
files without registry rows cannot be assigned to a store and are omitted.

Retention duration and the customer pseudonymisation treatment are proposed defaults for the
application. New indexed artifacts share the store's authenticated Telegram activity clock;
historical artifacts use file modification time because there is no safe backfill. Legal review has
not established a legal basis, provider retention, or the correct treatment of accounting records.
Store erasure is not done.
