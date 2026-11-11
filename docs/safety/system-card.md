# System card

**Status:** partial

This card describes the current repository behavior, not a certified safety profile or a measured
claim about live model quality.

## System

Supermarket Ops Agent is a TypeScript Telegram bot for one invited kirana-store owner. It uses the
Claude Agent SDK with a fixed tool allow-list, skills and PostgreSQL-backed tools. The configured
default model name in code is `claude-opus-5`; the deployment may override it through
`AGENT_MODEL`. The system also supports a configured fallback model. The runtime does not route to
another provider for tool choice. Voice notes are sent to OpenAI for transcription when enabled.
An optional hosted open-weight helper can remove a small set of speech fillers; it is off by
default, has no tools or database access, and always preserves the original transcript for Claude.

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

The fairness-check work adds a Postgres-backed synthetic name-swap test and a budget-gated live
counterfactual runner. Its committed report is **NOT RUN**: the live runner was not invoked, and the
Hindi and Hinglish prompts remain `human_reviewed: false`. Twenty-four synthetic names and five
scenario templates cannot establish behavior for real customers; names are only an imperfect
proxy, model output varies across repeats, and the app has one live user. The corpus intentionally
has no demographic labels. Names were selected from a public combined given-name list, not sampled
as a representative population ([source and limits](fairness-plan.md#limits)). Current text and Whisper paths do not expose a declared language bucket,
so no language detector or runtime language counters were added.

## Data and oversight

See the [data inventory](../privacy/data-inventory.md) for storage, retention and processor paths,
and the [incident runbook](incident-runbook.md) for containment actions. The project maintainer owns
technical follow-up. Optional Langfuse Cloud tracing exports pseudonymous usage metadata and
operational events when configured; content capture is off by default. Langfuse retention is
controlled outside this application. When the hosted voice helper is enabled, transcript text is
sent to the operator-configured provider; its retention was not verified. Legal review remains open for the proposed retention period
and customer record treatment.
