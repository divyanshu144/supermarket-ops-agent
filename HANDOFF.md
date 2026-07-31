# HANDOFF

Written so a cold-start session can resume. Update at every checkpoint.

**Last updated:** 2026-07-30, after Milestone 0 + 1

---

## 🚩 DEFERRED: Railway deployment (Task 8)

**Deliberately postponed by the user on 2026-07-30. Everything is prepared; only auth is missing.**

The brief requires **a live bot the reviewers can message, kept running while they review, with
the `@handle` in the README**. That is a graded deliverable and it is currently NOT satisfied —
the bot only runs locally.

Ready and committed: `Dockerfile`, `railway.json` (`numReplicas: 1`, `overlapSeconds: 0`),
`.dockerignore`. The image **builds and its contents are verified** — entry point, all three
migrations, `.claude/skills/`, no dev binaries in the runtime layer.

To finish, in order:

1. Auth — `railway login` from a real terminal (the `!` prefix has no TTY), **or** an account
   token from railway.com/account/tokens as `RAILWAY_TOKEN`.
2. `railway init && railway add --database postgres`
3. Set vars: `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `AGENT_EFFORT`, `NODE_ENV=production`
4. `railway up`
5. **Run migrations against Railway's Postgres** — it starts empty and the bot cannot serve a
   single message until they are applied: `DATABASE_URL=<railway url> pnpm db:migrate`
6. **Stop the local bot first.** Two processes long-polling one token cause 409 conflicts and
   dropped updates — the same failure `numReplicas: 1` exists to prevent.
7. Confirm one replica in the dashboard, then message the bot and check `railway logs` for 409s.

---

## Current State

Branch `feat/milestone-0-walking-skeleton`, 15 commits. **Gate green: fmt, lint, typecheck,
110 tests.**

**Milestone 0 and 1 are complete except the deploy.** A real Telegram message travels
adapter → agent → Postgres → grounded reply. Verified live, not just unit-tested.

Bot handle: **@divagentBot** ("SuperOps") — runs locally via `pnpm tsx src/index.ts`.

### Verified live (not just tested)

- Grounded answer through `get_stock` to real Postgres: "Sugar (loose) — 18 kg. ₹52/kg, GST 0%"
- **Skills load behind the allowlist** — gate is the built-in `Skill` tool, **not** `Read`.
  Requires `settingSources: ['project']`; with `[]` they silently never load.
- `CHECK (quantity_base >= 0)` confirmed in Postgres via `psql`
- Docker image builds; migrations and skills present inside it

### Bugs found by running, that passing tests missed

1. `get_stock` returned raw rows; `JSON.stringify` throws on the BigInt `storeId`, so every
   call errored in production. Fixed via a presented view that also stops leaking cost price.
2. `settingSources: []` silently disabled every skill.
3. Missing FK cascades on `bill_items` / `stock_movements` (caught by the seed test).
   `khata_entries.bill_id` is **SET NULL** on purpose — the ledger must outlive the bill.
4. `packageManager` unpinned: container corepack pulled pnpm 11 against a pnpm-9 lockfile and
   the image would not build. Pinned to `pnpm@9.15.4`.

## Next Action

1. **Run the security probe** (`pnpm tsx src/agent/security.probe.ts`) — written but never
   executed; two attempts hit API 529s. Until it passes, spec §4's claim that a Telegram user
   cannot reach the filesystem is designed-for and unit-tested but **not empirically proven**.
   `ToolSearch` appeared in `toolsUsed` despite not being allowlisted, which is exactly why
   this needs running rather than assuming.
2. **Measure `low` and `high` effort.** Only `medium` is measured, at 15.1s for a simple stock
   query — slow for a demo where a reviewer sends twenty messages. Lever is `effort`; never
   disable thinking (on Opus 5 that can emit tool calls as plain text that silently never run).
3. **Re-plan Milestones 2–5** — the plan covered 0 and 1 only, pending Task 9's outcomes, which
   are now known. §9 stands unchanged, so the skills design needs no rework.
4. Then Milestone 2: the remaining tool families and the §4 invariant tests.

## Open Questions

- Final `AGENT_EFFORT` value, pending the sweep.
- Whether `void_bill` ships (first cut if time runs short).

## Verification Baseline

`pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test` — **green, 110 tests, 12 files.**
Requires Docker Postgres up (`pnpm db:up`) and a `.env`; `POSTGRES_PORT=5434` locally because
5432 was occupied.

## Constraints

- 2-day deadline, day 2. Scope: §3 capabilities + §4 hard parts. Zero §7 stretch items.
- The Claude Agent SDK is **not** covered by the `claude-api` skill — see
  `code.claude.com/docs/en/agent-sdk`. Bindings verified against installed 0.3.220.

---

## 2026-07-31 — Milestones 2 & 3 complete, END-TO-END PASSING

**27 commits, 203 unit tests, 27 tools. Gate green.**

**End-to-end: all 13 beats pass** (`pnpm tsx src/agent/e2e.ts`) — receive stock, multi-item
bill, mid-build edit, finalize, oversell guard, khata charge/balance/settle, daily close, PDF
invoice, analysis deck, set preference, and recall after /new.

**Security probe passes** — 4 filesystem/shell attempts refused, zero tool calls.

### Remaining, both needing the user

1. **Task 24 — Railway deploy.** Still 🚩 blocked on `railway login` (needs a TTY) or a
   `RAILWAY_TOKEN`. Dockerfile and railway.json are built and the image is verified. Full
   sequence in the 🚩 section above. The brief's "live bot kept running while we review" is a
   graded deliverable and is NOT yet satisfied — the bot runs locally only.
2. **Task 26 — Recording.** 4–5 min of the 13 beats. The e2e script output is a working script
   for it.

### Bugs found by running things, that a green suite had hidden
- `JSON.stringify` throws on BigInt — every `get_stock` call errored in production
- `settingSources: []` silently disabled all skills
- `formatPaise(-40050)` produced `₹-401.-50` (reachable via khata overpayment)
- Missing FK cascades on bill_items/stock_movements
- `packageManager` unpinned — container pulled pnpm 11 against a pnpm-9 lockfile
- Duplicate bill lines collapsed by random UUID order → nondeterministic bill totals

---

## 2026-07-31 — DEPLOYED AND VERIFIED IN PRODUCTION

Bot live on Railway as **@divagentBot**. Project `kirana-ops-agent`, one replica, long-polling.
Repo: github.com/divyanshu144/supermarket-ops-agent

**User-driven Telegram test confirmed working.** Verified against production database, not logs:
- Bill built across turns, mid-build edit applied (butter dropped, Maggi 4→6)
- Stock moved exactly once, only at finalize (Sugar -2kg, Atta -1, Maggi -6)
- Oversell: 500-Maggi bill stayed a draft with ZERO stock movements
- Khata charge +500 with matching ledger entry, balance and ledger agree
- 14/14 updates processed to 'done', no stuck claims
- Latency median 9s, range 5-21s

**Deploy bug found and fixed:** first deployment died on `relation "processed_updates" does not
exist` — managed Postgres arrives empty. Container now migrates on boot via drizzle-orm's
programmatic migrator (drizzle-kit is a dev dep, absent from the runtime image). Migrations copy
to `dist/db/migrations` because the migrator resolves relative to its own compiled location.

### Known issues, not blocking

1. **Abandoned drafts accumulate.** A refused bill leaves a draft forever; nothing expires them.
   Harmless (drafts hold no stock) but unbounded, and `find_bills` keeps returning them.
2. **No conversation logging.** Only errors are logged, so misbehaviour can only be diagnosed
   from database state — you can see what the agent DID, never what it SAID.

### Remaining

- **Recording** — `docs/RECORDING.md` has the shot list. Needs screen capture.
- **Rotate credentials** — Railway CLI echoed both tokens to stdout, and grammY's error dump put
  the bot token in Railway logs.
