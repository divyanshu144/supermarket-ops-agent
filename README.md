# Supermarket Ops Agent

A kirana store you run from a Telegram chat. Receive stock, cut bills, run customer credit,
close the day, and pull GST invoices and analysis decks — in plain terse English, no forms.

**Bot: [@divagentBot](https://t.me/divagentBot)** · invite-only: the operator gives an owner a code, sent as `/start <code>`. Then try `how much sugar is left?`. `/reset` only explains itself; `/reset confirm` does it.

[![CI](https://github.com/divyanshu144/supermarket-ops-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/divyanshu144/supermarket-ops-agent/actions/workflows/ci.yml)

Deployed on Railway, one replica, long-polling. Deployment notes: [`docs/DEPLOY.md`](docs/DEPLOY.md).
The full reasoning behind everything below: [`docs/DESIGN.md`](docs/DESIGN.md).

## Setup

```bash
pnpm install
cp .env.example .env          # add TELEGRAM_BOT_TOKEN and ANTHROPIC_API_KEY
pnpm db:up                    # Postgres 16 in Docker
pnpm db:migrate
pnpm dev
```

Gate: `pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test` — 386 tests. Voice input needs
`OPENAI_API_KEY`; without it the bot runs normally and text is unaffected. Two scripts hit the live
API rather than mocks: `pnpm tsx src/agent/e2e.ts` (the brief's thirteen beats) and
`pnpm tsx src/agent/security.probe.ts`.

## The harness, and why

**Claude Agent SDK (TypeScript).** The brief names it first, and skills, tool schemas and sessions
are first-class in it, so the capability surface being graded is the SDK's own idiom rather than
scaffolding I invented. The cost is that the SDK is a coding agent by default — Bash, Read, Write,
Edit — and behind a public Telegram bot that is a shell anyone can reach. So the runtime throws all
of that away and allows `Skill` plus our 25 tools, nothing else. Model is `claude-opus-5` with
adaptive thinking; I routed nothing cheaper, because this is a billing system and a skipped tool
call is worse than a slow one.

## How the control loop works

```
Telegram (long-poll)
   ↓  claim the update, resolve chat → store, read preferences
Agent SDK query()  ── system prompt + preferences + 6 skills + 25 tools
   ↓  observe → reason → call tool → read result → continue
in-process MCP tools (Zod schemas)  →  domain/ (pure, integer-only)  +  db/ (transactions, row locks)
   ↓
reply, then any generated files, then mark the update done
```

One `query()` per message, resumed by session id so a bill can be built across turns. Tools push
generated files onto the turn context and the adapter sends them after the reply. The agent never
touches Telegram, so an invoice can be generated in a test with no bot running.

## Skill and tool design

Six skills — inventory, billing, khata, analytics, documents, hindi — teach *how to run a shop*,
not what a signature looks like. 25 tools across six families, shaped by two rules.
**Refusals are data, never exceptions:** `finalize_bill` returns `insufficient_stock` with the
shortfalls, and the model relays it. **Ambiguity is data too:** `get_stock('atta')` returns
candidates and the *model* decides to ask which one, because the brief is explicit that the
clarifying question must not be a hardcoded branch. `store_id` is never a tool parameter; it comes
from the verified chat, so no prompt can address another shop.

## How the hard parts were solved

| Part | How | Detail |
|---|---|---|
| Grounding | Every price, rate and quantity comes from a tool, which returns shaped views, never raw rows | [more](docs/DESIGN.md#grounding) |
| GST | MRP is tax-inclusive, so tax is back-calculated from the line total; integer paise and basis points, no floats | [more](docs/DESIGN.md#gst) |
| Oversell | Compare-and-set `UPDATE … WHERE quantity_base >= qty`; a `CHECK` constraint underneath | [more](docs/DESIGN.md#oversell-guard) |
| Multi-turn bills | A draft until finalize; price, rate and HSN snapshotted at add time; stock moves only at finalize | [more](docs/DESIGN.md#multi-turn-bills) |
| Idempotency | Three layers: update claim, per-tool keys inserted first, finalize that succeeds on a repeat | [more](docs/DESIGN.md#idempotency--three-layers) |
| Concurrency | Finalize locks the store row, then products in sorted id order, in one transaction | [more](docs/DESIGN.md#concurrency) |
| Khata | Billing to credit is one transaction; charging opens an account, settling an unknown name refuses | [more](docs/DESIGN.md#khata) |
| Guardrails | Below cost refuses unless confirmed; above MRP refuses with no override; nothing is ever deleted | [more](docs/DESIGN.md#guardrails) |
| Memory | Preferences live in Postgres and are injected each turn; `/new` clears only the conversation | [more](docs/DESIGN.md#memory-across-sessions) |
| Voice, Hindi | Whisper into the same turn path; the bot echoes what it heard, then acts | [more](docs/DESIGN.md#voice-and-hindi) |
| Real artifacts | `pdfmake` invoices; `pptxgenjs` decks with native charts, asserted by a test | [more](docs/DESIGN.md#real-artifacts) |
| Access, spend | Invite-only; per-run, per-store and per-chat limits | [more](docs/DESIGN.md#access-and-spend) |
| Restarts | Conversations mirrored to Postgres; shutdown drains the turn in flight instead of confirming it | [more](docs/DESIGN.md#restarts-and-conversation-storage) |

## What I didn't handle

- Inter-state supply (IGST), partial returns, expiry and batch tracking, e-invoicing, split
  payments and bill-level discounts.
- Multi-user roles: anyone in the chat is the owner, so in a group every member is.
- Idempotency under a diverging replay. Keys are ordinal-based, so they only line up if a replayed
  turn makes the same calls; closing it properly needs a durable per-turn execution log.
- Agent behaviour is not in CI. The tool layer is exhaustively tested; the orchestration is covered
  by `e2e.ts`, a live script.
- One slow turn delays other shops, because polling is sequential on purpose (the runner can lose
  updates when killed). Conversation transcripts also grow until `/new`; there is no retention job.

The full list, how I used AI tools, and what I'd do with more time are in
[`docs/DESIGN.md`](docs/DESIGN.md#edge-cases-not-handled).
