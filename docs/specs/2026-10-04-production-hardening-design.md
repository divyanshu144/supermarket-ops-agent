# Production hardening — design

**Date:** 2026-10-04
**Branch:** `production-hardening`
**Status:** draft, awaiting review

## Purpose and target

Make the bot safe to run for **a handful of real shops that the owner onboards personally**.
Not open signup, not a public product. That bounds the scope: access is an allowlist, there is no
per-store billing, and abuse handling is a spend cap rather than a moderation system.

Source of this work is the review of 2026-10-04 (gaps in access control, cost control,
throughput and operations) plus the decision to evaluate runtime subagents.

**Constraints carried over, unchanged:**

- Agent-first. No regex or keyword intent router. The access gate below is authorization, not
  intent routing, and must stay that way.
- Locked stack (`CLAUDE.md` §2). Additions are small libraries, not replacements.
- Every invariant keeps a test that fails without its guard. The gate is
  `pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test`.
- Business rules live in tools and the schema, never in the system prompt.

## Decomposition

Six sub-projects, built in order, each with its own branch off the previous merge, its own plan
under `docs/plans/`, and the full gate green before the next starts.

| # | Sub-project | Depends on |
|---|---|---|
| A | Guardrails and cost | — |
| B | Session durability and graceful shutdown | A (cost logging) |
| C | Operability | B |
| D | Correctness audit | — (ordered after C) |
| E | Subagents | A (needs per-turn cost data) |
| F | Submission packaging | all |

This document is the design for all six. The implementation plan is written for A first;
B–F are planned when their turn comes, against the code as it then stands.

---

## A. Guardrails and cost

### Access

- New table `invite_codes`: `id`, `code_hash` (unique), `created_at`, `used_by_chat` (nullable),
  `used_at` (nullable), `revoked_at` (nullable). Codes are stored hashed; the plaintext is shown
  once when created.
- A grammY middleware runs before every handler. If the chat has no active store it replies once
  with a fixed message ("Private bot. Send `/start <code>`.") and stops. No model call, no
  provisioning.
- `/start <code>` redeems a valid, unused, unrevoked code and provisions the store. Redemption is
  a single conditional `UPDATE … WHERE used_at IS NULL AND revoked_at IS NULL RETURNING`, so two
  simultaneous redemptions cannot both win.
- `pnpm invite:create` and `pnpm invite:revoke <code-id>` are scripts run against the production
  database. There is no admin surface in the chat.
- A migration marks every existing store active, so the live bot and current reviewer chats keep
  working.

### Cost and abuse

| Control | Default | Env override |
|---|---|---|
| `maxTurns` per agent run | 15 | `AGENT_MAX_TURNS` |
| Budget per agent run | $0.50 | `AGENT_MAX_BUDGET_USD` |
| Abort timeout per turn | 90 s | `AGENT_TURN_TIMEOUT_MS` |
| Daily spend cap per store | $5.00 | `STORE_DAILY_BUDGET_USD` |
| Rate limit per chat | 20 turns / 10 min | `RATE_LIMIT_TURNS`, `RATE_LIMIT_WINDOW_S` |

- The runtime reads the SDK's final result message and returns cost and turn count with the
  reply. `logTurn` records both.
- New table `usage` keyed by `(store_id, day)` accumulating cost. A turn that would start after
  the daily cap is refused with a plain message; the cap is checked before any model call.
- Rate limit is in memory. That is correct for one replica and resets on restart; this is
  documented as a known limit, not hidden.
- Model name comes from `AGENT_MODEL` (default `claude-opus-5`). Optional
  `AGENT_FALLBACK_MODEL`.

### Destructive command

`/reset` with no argument explains what it would do and changes nothing. `/reset confirm` performs
it.

### Tests

Each fails if its guard is removed: an unredeemed chat triggers zero agent calls; a code cannot be
redeemed twice, including concurrently; a revoked code is rejected; the daily cap blocks a turn
before any model call; bare `/reset` leaves data untouched; a run exceeding the timeout is
aborted and replies cleanly.

---

## B. Concurrency and sessions

**Amended 2026-10-04** after researching the Agent SDK and grammY docs. Two findings overturned the
original text of this section:

1. The Agent SDK has a first-class `sessionStore` option (`append` and `load` are required). It
   mirrors transcripts to a backend of our choosing, and `load` is called before a resume. That
   replaces the Railway-volume idea: sessions live in Postgres and survive any redeploy.
2. grammY's runner in concurrent mode confirms update offsets early, so a killed process can lose
   up to 100 fetched updates (grammY docs, "Reliability Guarantees > grammY Runner"). Our
   `processed_updates` claim design (AD-16) relies on Telegram *redelivering* a turn that crashed
   mid-handling; the runner would silently turn that into a dropped message. **Decision: stay with
   sequential long-polling (`bot.start`).** Cost accepted: one slow turn delays other shops. The
   runner (with a durable Postgres inbox) is a later option if queueing is measured to matter.

Scope of B:

- **Postgres session store.** A `session_entries` table (project key, session id, subpath, ordinal,
  JSONB entry) behind a repository, and a thin `SessionStore` adapter passed to `query()` as
  `sessionStore`. `append` is one transaction, ordered by a bigserial id; this is correct while the SDK calls `append` serially within one process (its contract), and there is no per-session lock; `load` returns
  entries in append order, deep-equal to what was appended, or `null` for an unknown session.
  `delete` is implemented so `/new` and `/reset confirm` remove the conversation's entries and
  nothing orphans. The SDK's mirror-failure event is logged (redacted) and never fails a turn.
- **Failed resume degrades to a fresh session.** Before resuming, check the store (a stored
  session id with no stored entries, which is every session created before B, is treated as
  gone): drop `resume`, clear the stale `sessions` row, and treat the prior session cost as 0.
  A run that fails to start while resuming, before any assistant output, is retried once
  without `resume`. A missing or corrupt transcript never produces an error reply to the owner.
  This also resolves the failed-resume cost under-count deferred from sub-project A.
- **Graceful shutdown and restart recovery.** Two grammY/claim facts, both verified in the
  installed source, make the original wording ("recovered by redelivery, as before") wrong:
  `bot.stop()` does not wait for the in-flight handler and then confirms the update it is handling
  (`getUpdates` with `offset = lastTriedUpdateId + 1`), so today's SIGTERM path loses an in-flight
  owner message; and `claimUpdate` treats a claim younger than 300 s as "still running elsewhere",
  so a crash followed by a fast restart redelivers the update and then drops it. B therefore:
  (1) on SIGTERM stops accepting new updates (a first middleware that never calls `next()` and
  never returns, so grammY's loop issues no further `getUpdates` and nothing unhandled is
  confirmed), waits for the in-flight turn up to a bounded grace period (default 30 s,
  `SHUTDOWN_GRACE_MS`), then exits **without calling `bot.stop()`**; and (2) at boot expires every
  `claimed` row, because with one replica any claim present at boot belongs to a dead process, so
  a redelivered update is reclaimed and reprocessed (tools are idempotent per update). DEPLOY.md
  records that Railway's draining/kill timing must be checked against the grace period (not yet
  verified).
- **Instance lock (added after this spec was written).** Boot expiry is only safe if the previous process is really gone, so after migrations a process-lifetime Postgres advisory lock (`db/instance-lock.ts`) makes a new instance wait (up to 180 s) for the old one's connection to close before it expires claims and starts polling.
- **Not in B:** the runner, per-chat parallelism, a replay inbox.
- Tests: the store adapter round-trips, preserves order across batches, returns `null` for
  unknown sessions, and `delete` cascades to subpaths; a stale session id with no stored entries
  falls back to a fresh session with prior cost 0; a resume that fails before any output is
  retried once without resume; `/new` and `/reset confirm` delete stored entries; shutdown waits
  for an in-flight turn but not longer than the grace period.

## C. Operability

- Small HTTP server on `PORT` with `/healthz`: database reachable, seconds since last successful
  poll. Railway needs an HTTP check even though the bot itself has no inbound traffic.
- `@sentry/node` with every event passed through the existing `redact` function. Handlers for
  `unhandledRejection` and `uncaughtException` report and exit so Railway restarts the process.
- Dockerfile: `USER node`, `HEALTHCHECK`.
- Backups: Railway managed Postgres backups if the plan includes them (not yet verified);
  otherwise a nightly `pg_dump` to object storage. Either way a restore drill is documented and
  performed once.
- Deploys: link the GitHub repo to Railway so `main` deploys only after CI passes. Pin
  `@anthropic-ai/claude-agent-sdk` exactly. Add Dependabot and `pnpm audit` to CI. Correct the
  `package.json` name, description and license.
- Migrations on boot are safe with one replica; an advisory lock is added only if the replica
  count ever changes (noted in `DEPLOY.md`).

## D. Correctness audit

Each item starts as a read-only check. A bug becomes a failing test, then a fix.

- GST invoice numbering: gapless, sequential per store, safe under concurrency, resets by
  financial year.
- IST day boundaries in daily close and analytics.
- Injection through stored data: product and customer names containing instructions. Extend
  `src/agent/security.probe.ts`.
- Artifact files deleted after delivery.
- Customer data: per-store khata export and delete command, plus a stated retention note.

## E. Subagents

- One read-only analytics/deck subagent, narrow tool list, cheaper model. All mutating tools stay
  on the main agent. Billing and khata are never delegated.
- Gated on measurement: run the 13-beat `src/agent/e2e.ts` before and after. Keep the subagent
  only if cost per turn falls without a meaningful latency or correctness regression. If it does
  not pay for itself it is removed and the result recorded in `tasks/agent_memory.md`.
- Tests: a subagent cannot read another store's data (tenancy via `toolContext`) and cannot call
  a mutating tool.
- Exact `agents` option shape and delegation tool name confirmed against the Agent SDK docs
  first.

## F. Submission packaging

README trimmed to about one page with depth moved to `docs/DESIGN.md`; `HANDOFF.md` and
`tasks/todo.md` brought current; recording script per `docs/RECORDING.md`.

## Out of scope

Open signup, per-store billing, staff roles within a store, multi-replica operation, photo input.
Each is recorded as a known limit in the README rather than built.

## Open items to verify during implementation

- Railway plan tier and whether managed backups are included.
- Whether Railway's draining time exceeds the shutdown grace period (B).
- How the SDK behaves when `resume` names a session that exists nowhere (B retries without `resume`; the exact failure mode is not yet observed live).
- Agent SDK option names for `maxTurns`, budget cap, abort, `agents` and fallback model.
- Whether current reviewer chats should stay grandfathered after the review window.
