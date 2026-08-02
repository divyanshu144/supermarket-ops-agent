# HANDOFF

Written so a cold-start session can resume. Update at every checkpoint.

**Last updated:** 2026-08-02, after the improvements branch
**Branch:** `improvements` — complete, not merged, not pushed
**Bot:** [@divagentBot](https://t.me/divagentBot), deployed on Railway, one replica, long-polling

---

## Current state

The improvements plan (`docs/plans/2026-08-01-improvements.md`) is **complete — all 10 tasks**,
plus a grounding fix and five fixes from the final whole-branch review.

**Verification, as of the last run:**

- `pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test` — green, **236 tests**, three
  consecutive clean runs.
- `pnpm tsx src/agent/e2e.ts` — **PASS, all 13 beats.**
- Latency: `ToolSearch` fired in 10/13 beats before, **0/13** after; median turn 9064ms → ~7000ms.

## What landed on this branch

| | |
|---|---|
| Loose atta seeded | the brief's own "which atta?" example had no second product to be ambiguous against |
| `bot.catch` + redactor | grammY's default handler called `bot.stop()` and dumped `ctx.api.token` into logs |
| Turn logging | one JSON line per turn; message text off by default in production |
| `alwaysLoad: true` | removed the ToolSearch round-trip before nearly every tool call |
| Hindi/Hinglish skill | glossary and register; no alias column, translation stays in the model |
| `handleTurn` extracted | `src/telegram/turn.ts`, shared by text and voice |
| Voice input | Whisper, echo-before-acting, claim before spending on the download |
| Stale drafts hidden | `find_bills` skips drafts older than 24h |
| `reorder_suggestions` | ranks by days-of-cover from real sales velocity |
| Idempotency layer 2 | `open_bill` **and** `add_bill_item` — see below |
| Grounding fix | the prompt's rule named "price or quantity"; a khata balance is neither |

## Two things to know before touching this

**Keying `open_bill` alone was worse than keying nothing.** A crash-replay got the same draft
back, already holding its lines, and the model appended them again — finalize decremented stock
twice and charged twice. Unkeyed, that replay opened a fresh draft and billed correctly.
`add_bill_item` is now keyed too. If you ever unkey one, unkey both.

**Tests run with `fileParallelism: false`** (`vitest.config.ts`). The invariant suite installs a
DDL trigger on `khata_entries` to prove the khata write is inside the finalize transaction; while
it exists, any parallel test file inserting there fails. The suite was red about one run in five
before this.

## Next action

Packaging, in this order:

1. **Rotate `TELEGRAM_BOT_TOKEN` and `ANTHROPIC_API_KEY`.** Both reached deployment logs before
   the redactor landed. The redactor stops the leak; it does not undo it.
2. Merge `improvements` → `main` and redeploy, so Railway actually runs this code.
3. Make the repo public: `gh repo edit divyanshu144/supermarket-ops-agent --visibility public
   --accept-visibility-change-consequences` — **run this yourself**; it accepts a GitHub warning.
4. Trim the README toward ~1 page, moving depth into `docs/DESIGN.md`. It is ~290 lines against a
   brief asking for about one.
5. Record the 4–5 minute demo per `docs/RECORDING.md`.

## Open questions

- **Recording script.** Seven graded beats plus voice, Hindi and reorder is too much for five
  minutes. Suggest featuring the two strongest — the oversell guard and the mid-build bill edit —
  and showing voice and Hindi briefly rather than fully.
- **Photo input** is designed but unbuilt. It needs `prompt: AsyncIterable<SDKUserMessage>`, whose
  interaction with session resume is unverified. Only worth it if packaging finishes early.

## Verification baseline

```bash
pnpm db:up
pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test   # 236 tests
pnpm tsx src/agent/e2e.ts                                    # 13/13 beats, needs API credit
pnpm tsx src/agent/security.probe.ts                         # 4 attacks, 0 tool calls
```

Voice needs `OPENAI_API_KEY`; without it the bot runs normally and replies that voice isn't
configured. The execution ledger for this branch — every deferred minor, parked finding and
process deviation — is at `.superpowers/sdd/2026-08-01-improvements/progress.md`.
