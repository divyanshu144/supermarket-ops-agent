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
| B | Concurrency and sessions | A (cost logging) |
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

- Replace `bot.start` with `@grammyjs/runner`, with `sequentialize` keyed by chat ID. Different
  shops run in parallel; one shop's messages stay ordered. Runner concurrency is capped (about 8)
  to protect the database pool and API rate limits.
- Shutdown stops the runner and waits for in-flight turns, with a bounded grace period.
- **Experiment first:** send a message, deploy, send another, and observe whether `resume` finds
  the session. The Agent SDK keeps transcripts on local disk and Railway's disk is ephemeral, so
  the expectation is that it does not.
- Whatever the result, a failed resume degrades to a fresh session. A missing or corrupt
  transcript never produces an error reply to the owner.
- If sessions do not survive: point the SDK's config directory at a Railway volume (preferred),
  or store transcripts in Postgres (heavier, rejected unless the volume route fails). Exact SDK
  mechanism is confirmed against the Agent SDK docs before implementation, not written from
  memory.
- Tests: two chats overlap in time while same-chat messages stay ordered; a missing or corrupt
  session file falls back to a fresh session.

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
- Whether `resume` survives a redeploy (B experiment).
- Agent SDK option names for `maxTurns`, budget cap, abort, `agents` and fallback model.
- Whether current reviewer chats should stay grandfathered after the review window.
