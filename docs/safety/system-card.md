# System card

**Status:** partial

This card describes the current repository behavior, not a certified safety profile or a measured
claim about live model quality.

## System

Supermarket Ops Agent is a TypeScript Telegram bot for one invited kirana-store owner. It uses the
Claude Agent SDK with a fixed tool allow-list, skills and PostgreSQL-backed tools. The configured
default model name in code is `claude-opus-5`; the deployment may override it through
`AGENT_MODEL`. The system also supports a configured fallback model. The runtime does not route to
another provider. Voice notes are sent to OpenAI for transcription when enabled.

## Intended use

The owner can inspect and update stock, prepare and finalize bills, track khata, ask for analytics,
and generate invoices or decks. Money is represented as integer paise. Tools and database rules
enforce business constraints; natural-language replies are not the source of truth for totals or
authorization.

## Boundaries and non-use

The system is not intended to provide legal, tax or accounting advice. It does not replace checking
the generated invoice or bookkeeping with the owner's records. It does not support group-chat owner
actions, multiple roles within one shop, store erasure, or deletion by Telegram or AI providers.
Legacy stores without a stored owner fail closed.

## Safeguards and known limits

Implemented controls include invite-based owner binding, strict preference formats, store-scoped
tools, domain refusals, owner-bound confirmation for selected high-impact actions, app-side
transcript/artifact cleanup, a privacy disclosure, store export and customer pseudonymisation. The
export includes indexed artifact metadata but omits invoice/deck file contents and metadata for
historical unindexed files, which cannot be assigned safely to a tenant. Pseudonymisation does not
rewrite existing transcript mentions.

The replay evaluation is synthetic and checks deterministic behavior. There is no accepted live
baseline and no live model call was run for this work. Model responses can still be wrong, ambiguous
or inconsistent. Owners should verify consequential records in the shop's source documents.

## Data and oversight

See the [data inventory](../privacy/data-inventory.md) for storage, retention and processor paths,
and the [incident runbook](incident-runbook.md) for containment actions. The project maintainer owns
technical follow-up. Legal review remains open for the proposed retention period and customer
record treatment.
