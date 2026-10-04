# HANDOFF

Written so a cold-start session can resume. Update at every checkpoint.

**Last updated:** 2026-10-04, after production-hardening sub-project B
**Branch:** `production-hardening-b` — sub-project B implemented, stacked on `production-hardening` (PR #1, which is not merged); not merged (`improvements` is already merged into `main`)
**Bot:** [@divagentBot](https://t.me/divagentBot), deployed on Railway, one replica, long-polling

---

## Current state

The `improvements` work (`docs/plans/2026-08-01-improvements.md`) is merged into `main`.

Branch `production-hardening` holds **sub-project A, guardrails and cost**, of
`docs/specs/2026-10-04-production-hardening-design.md`, built from
`docs/plans/2026-10-04-guardrails-and-cost.md`. All 10 plan tasks are implemented and committed.
It is **not merged and not pushed**, and its live-credential steps have **not been run** (below).

What A added:

- **Access:** the bot is invite-only. `invite_codes` table (hashed, single-use, atomic redemption);
  a gate before every handler replies "private bot" to chats without a store; `/start <code>`
  redeems. `pnpm invite create|list|revoke <id>` (production image: `node dist/scripts/invite.js`).
  Revoke only affects unredeemed codes.
- **Cost and abuse:** per-run max turns, max budget and timeout; per-store daily budget (`usage`
  table); per-chat in-memory rate limit; cost and turn count logged per turn; `AGENT_MODEL` and
  `AGENT_FALLBACK_MODEL`.
- **`/reset`** only explains; `/reset confirm` performs it.
- **Fix found in review:** the gate used its own parse of `/start`, so `/start@otherbot hi`
  slipped through and provisioned a store. The gate now uses grammY's matcher and `handleTurn`
  never creates a store (see `tasks/lessons.md`).

**Verification, as of the last run:** `pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test`
green, **307 tests in 35 files** (up from 236). `e2e.ts` and the live bot were **not** run on this
branch (no credentials in the session that built it).

Known limits: the rate limiter resets on restart; a turn aborted by the timeout reports no cost,
so it is charged the full per-run cap to the daily budget (a deliberate over-count; the next resumed
turn may also over-count because the session total chain keeps the pre-timeout value); no store can
be cut off with the CLI, including every chat that messaged the bot before invite-only access
(revoke only affects unredeemed codes; removing a store is a manual delete).

## Sub-project B: session durability and shutdown (branch `production-hardening-b`)

Plan: `docs/plans/2026-10-04-session-durability-and-shutdown.md`. All 7 tasks implemented and
committed. Stacked on PR #1 (sub-project A), which is not merged. Its live steps have **not been
run**.

- Agent transcripts are mirrored to Postgres (`session_entries`, `agent/session-store.ts`,
  `repositories/session-entries.ts`) so a conversation survives a redeploy. `/new` and
  `/reset confirm` delete them. A resume with no stored transcript starts a fresh session (prior
  cost 0); a resume that fails before any output is retried once without `resume`.
- SIGTERM drains the in-flight turn (up to `SHUTDOWN_GRACE_MS`) and exits 0 without `bot.stop()`
  (`telegram/drain.ts`). Boot order: migrations, instance lock (`db/instance-lock.ts`), expire
  claims, poll. See `docs/DEPLOY.md` for the caveats (first-deploy transition, lock lost on a
  dropped connection, migrations run before the lock).

**Branch state:** `production-hardening-b` is not pushed (no `origin/production-hardening-b`) and
not merged.

**Sub-project C note (healthcheck vs lock):** the instance lock is taken before polling starts. A
`/healthz` must be served BEFORE the lock wait and must not report unhealthy while merely waiting
for the lock, or the healthcheck must not gate stopping the old deployment. Otherwise the new
instance cannot become healthy while Railway waits for it before stopping the old one, the 180 s
lock timeout fires and the deploy fails. Railway's ordering of "new healthy" vs "stop old" is
unverified. Also: use a direct or session-mode `DATABASE_URL` (advisory locks break through a
transaction-mode pooler).

**Verification:** `pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test` green,
**386 tests in 39 files** (up from 307 on A), three consecutive runs after the final fix wave.

**B left out:** the grammY runner (sequential polling kept: the runner confirms offsets early and
can lose up to 100 updates on kill, which defeats redelivery recovery); a replay inbox; a session
retention job (abandoned conversations accumulate); in-process re-acquisition of a lost lock (a
lost lock now drains and exits 1 so Railway restarts the process); session rotation/retention
(transcripts grow until `/new`; `load` materialises all rows each turn and `loadTimeoutMs` is
60 s); probe step D (resuming a transcript cut off after a `tool_use` with no `tool_result`).
Review items M3 and M6 also exist and are not addressed here.

## What landed on the `improvements` branch (now in `main`)

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

For B, in order:

1. Run `pnpm tsx src/agent/session-store.probe.ts` with a real key. PASS in B is required before
   relying on durability. Paste C's output into `tasks/agent_memory.md` Known Gotchas.
2. Check Railway's SIGTERM-to-SIGKILL window (draining setting) against `SHUTDOWN_GRACE_MS`.
3. Deploy while the shop is idle: the deployment being replaced holds no instance lock, so on that
   one deploy a live claim can still be expired.
4. Then sub-project C.

Still pending from sub-project A: run these with real credentials, in order, then merge
`production-hardening`. A is not done until they pass.

1. `pnpm tsx src/agent/cost.probe.ts` — settles `SDK_COST_IS_CUMULATIVE`. Its header comment
   explains how to read an ambiguous result.
2. `pnpm tsx src/agent/e2e.ts` — all 13 beats must pass with outcome ok under the new limits. If a
   beat ends `max_budget` or `max_turns`, record its cost and raise the default deliberately.
3. Live Telegram check with a chat that has never used the bot, `pnpm dev` running:
   - a stranger saying "hello" gets only the private-bot reply;
   - `pnpm invite create`, then `/start <code>` gets the welcome;
   - the same code from a second chat is rejected;
   - bare `/reset` only explains and leaves stock unchanged; `/reset confirm` restores;
   - a normal turn's log line includes `cost_usd` and `num_turns`.

Then the earlier packaging items still open: rotate `TELEGRAM_BOT_TOKEN` and `ANTHROPIC_API_KEY`
(both reached deployment logs before the redactor), redeploy with `railway up --service bot`, make
the repo public (`gh repo edit divyanshu144/supermarket-ops-agent --visibility public
--accept-visibility-change-consequences` — run this yourself), record the demo per
`docs/RECORDING.md`.

Remaining sub-projects, each planned when its turn comes:

- **B. Concurrency and sessions** — implemented (see above); live probe, Railway timing check and
  idle deploy pending.
- **C. Operability** — `/healthz`, Sentry through `redact`, crash handlers, non-root Dockerfile
  with `HEALTHCHECK`, backups and a restore drill, deploy-on-CI, SDK pinned.
- **D. Correctness audit** — gapless GST invoice numbers, IST day boundaries, injection through
  stored names, artifact cleanup, khata export/delete.
- **E. Subagents** — one read-only analytics/deck subagent, kept only if measurement shows it pays.
- **F. Submission packaging** — trim README to about a page, move depth to `docs/DESIGN.md`, bring
  HANDOFF and todo current, recording.

## Open questions

- **Recording script.** Seven graded beats plus voice, Hindi and reorder is too much for five
  minutes. Suggest featuring the two strongest — the oversell guard and the mid-build bill edit —
  and showing voice and Hindi briefly rather than fully.
- **Photo input** is designed but unbuilt. It needs `prompt: AsyncIterable<SDKUserMessage>`, whose
  interaction with session resume is unverified. Only worth it if packaging finishes early.

## Verification baseline

```bash
pnpm db:up
pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test   # 373 tests
pnpm tsx src/agent/e2e.ts                                    # 13/13 beats, needs API credit
pnpm tsx src/agent/security.probe.ts                         # 4 attacks, 0 tool calls
```

Tip: if 5432 is taken by a native Postgres, set `POSTGRES_PORT` and `DATABASE_URL` accordingly (the
author ran the compose DB on 5435).

Voice needs `OPENAI_API_KEY`; without it the bot runs normally and replies that voice isn't
configured. The execution ledger for the improvements branch is at
`.superpowers/sdd/2026-08-01-improvements/progress.md`; for sub-project A at
`.superpowers/sdd/2026-10-04-guardrails-and-cost/`.
