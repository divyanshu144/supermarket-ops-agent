# Risk register

**Status:** partial

“Owner” below means the responsible role. It does not name a person or invent a privacy contact.
Statuses describe repository evidence at this checkpoint, not legal compliance.

| Risk | Status | Owner | Next action |
|---|---|---|---|
| Store export omits file contents and historical artifact metadata that cannot be assigned to a tenant | partial | Project maintainer | Keep the store-scoped registry for new artifacts; add a safe mapping only for historical files with reliable ownership evidence. The manifest names the current omission. |
| Transcript ownership is ambiguous for orphan session rows | implemented | Project maintainer | Keep fail-closed export behavior and add a tenant mapping only through a reviewed migration/backfill. |
| Customer mentions remain in historical transcripts after pseudonymisation | partial | Project maintainer | Keep the preview disclosure; decide transcript treatment only after product and legal review. |
| Retention duration is not legally reviewed | partial | Project maintainer | Obtain legal review of the proposed 30-day inactivity default and provider/deployment retention. |
| Store erasure treatment for accounting and audit records is unknown | not done | Project maintainer | Do not add a store-erasure route before legal review decides records, backups and provider data. |
| Telegram and Anthropic credentials were previously present in deployment logs | partial | Operator | Rotate `TELEGRAM_BOT_TOKEN` and `ANTHROPIC_API_KEY`, then verify the old credentials no longer work. Never paste the values into an issue or report. |
| Telegram may interpret outgoing text if a parse mode is enabled | partial | Project maintainer | Keep parse mode unset for untrusted text; add broad tests if a send path starts using formatting. |
| Provider retention and deletion are outside app controls | not done | Operator | Check the provider account settings and contractual terms; do not claim deletion until verified. |
| Live model quality and cost semantics are unverified | partial | Project maintainer | When credits exist, follow the eval runbook with explicit caps; do not accept a synthetic baseline as live evidence. |
| Privacy request contact is not configured | partial | Operator | Set a verified `PRIVACY_CONTACT` if desired; otherwise the bot falls back to the invite issuer. |

I use OWASP LLM/Agentic categories and NIST AI RMF functions as organizing references only. This
register does not claim certification or conformance.
