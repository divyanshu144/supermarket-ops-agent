# HANDOFF

Written so a cold-start session can resume. Update at every checkpoint.

**Last updated:** 2026-10-07, W1 implemented, reviewed, and locally verified
**Branch:** `responsible-ai`, created from `eval-harness` at `c435f26`.
**Bot:** [@divagentBot](https://t.me/divagentBot), deployed on Railway, one replica, long-polling

---

## Current state

### Responsible-AI checkpoint (2026-10-07)

Draft spec: `docs/specs/2026-10-07-responsible-ai.md`.
Draft plan: `docs/plans/2026-10-07-responsible-ai.md`.
The owner approved both and provided binding decisions on 2026-10-07. The spec and plan now record
those decisions. The branch is `responsible-ai`, based on `eval-harness` at `c435f26`.

The design uses owner-only bound Telegram Confirm/Cancel callbacks for below-cost bill finalize,
bill void, khata overpayment override, and customer pseudonymisation. The store records the Telegram
user who redeemed the invite. Legacy stores without an owner ID and all group chats fail closed.
Callbacks use short IDs mapped to DB rows, bind exact tool arguments and current bill lines/prices,
and expire after 10 minutes. Transcript and artifact retention is 30 days from last activity;
invoice PDFs regenerate from bills before expiry and export files are deleted after send. Store
erasure is explicitly NOT DONE pending legal review. No live model call or probe is permitted.

W1 implementation and independent review are complete; it is ready for its local commit. It records the
invite redeemer as store owner, fails closed for legacy stores/groups/other users, and moves
below-cost finalize, bill void, and khata overpayment behind a model-free 10-minute confirmation
callback. Callback claims bind owner/store/update, exact tool-argument hash, and bill-line/price
fingerprint. The below-cost refusal snapshot supplies the pending fingerprint without a later read;
finalize and void recheck the fingerprint inside the locked transaction. Pending model
results are rendered as “awaiting confirmation”. Denied callbacks are answered so Telegram clears
the spinner. The additive migration is `src/db/migrations/0006_good_the_call.sql`.

W1 targeted verification: 84 tests passed across 9 files. Required gate on disposable
`127.0.0.1:55439/rai_test`: `pnpm fmt:check` passed, `pnpm lint` passed, `pnpm typecheck` passed,
`pnpm test` passed (477 passed, 13 skipped; 52 files). Mutation evidence is in
`docs/safety/mutation-ledger.md`. One owner-predicate mutation was initially masked by an expired
test fixture; the fixture now uses the current injected time, and the mutation fails as intended.
Two fresh independent reviews found no unresolved blocker after the below-cost snapshot race fix;
the later reviewer could not connect to the DB from its sandbox, but the main run passed. The default
`src/agent/runtime.ts` path has no diff. No live model call, probe, or `.env` access occurred.

Every DB command and gate must use an explicitly disposable `DATABASE_URL`. Each completed task
gets a local commit on this branch; never push. Independent review is required at each task
checkpoint. Any hard stop is recorded here before proceeding to independent work. W2, W5, W3, the
W4 export/customer-pseudonymisation slice, W6, and W7 remain pending. Store erasure remains NOT DONE
pending legal review.

### Eval harness checkpoint

The offline eval Tasks 1–3 were committed and pushed as `c435f26` on `eval-harness`. Live budget is
zero; no cost probe or live model run has happened. Replay output is synthetic and cannot serve as
an accepted live baseline. The worktree was clean before the `responsible-ai` branch was created.

The `improvements` work (`docs/plans/2026-08-01-improvements.md`) is merged into `main`.

Branch `production-hardening` holds **sub-project A, guardrails and cost**, of
`docs/specs/2026-10-04-production-hardening-design.md`, built from
`docs/plans/2026-10-04-guardrails-and-cost.md`. All 10 plan tasks are implemented and committed.
I verified that A reached `main` through merge `fa89f53` (PR #1), including B through
merge `8536b3d` (PR #2). I found no new evidence that the pending live steps ran.

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
committed and merged through PR #2 and PR #1. Its live steps remain unverified.

- Agent transcripts are mirrored to Postgres (`session_entries`, `agent/session-store.ts`,
  `repositories/session-entries.ts`) so a conversation survives a redeploy. `/new` and
  `/reset confirm` delete them. A resume with no stored transcript starts a fresh session (prior
  cost 0); a resume that fails before any output is retried once without `resume`.
- SIGTERM drains the in-flight turn (up to `SHUTDOWN_GRACE_MS`) and exits 0 without `bot.stop()`
  (`telegram/drain.ts`). Boot order: migrations, instance lock (`db/instance-lock.ts`), expire
  claims, poll. See `docs/DEPLOY.md` for the caveats (first-deploy transition, lock lost on a
  dropped connection, migrations run before the lock).

**Branch state:** both hardening branches have remote refs and their changes are in local
`main`. I verified this from git history, not from the old handoff.

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

The user approved `docs/specs/2026-10-06-agent-evals.md` and
`docs/plans/2026-10-06-agent-evals.md` with “looks good, goahead”. The database isolation code
passed a fresh review with 14 dedicated-instance tests. Protected child capture and its
redaction policy passed scoped review with 13 behavior tests and mutation evidence. Live calls
still need an explicit spending cap; query-level budget accounting is not yet implemented.
I will keep later phases on their requested branches and commit only when
asked. The initial handoff correction is explicitly requested as the first commit.

The live prerequisites must run in this order against a disposable local database:

1. `pnpm tsx src/agent/cost.probe.ts`
2. `pnpm tsx src/agent/session-store.probe.ts`
3. `pnpm tsx src/agent/e2e.ts`
4. `pnpm tsx src/agent/security.probe.ts`

I have not run these in this session. Credential presence checks returned true for the model
key, bot token and DB URL; I did not print values or validate authentication. Existing probes
print raw errors or replies; the security
probe could print a leaked credential before detecting it. I will specify protected execution
and disposable database setup before asking for probe output. Never paste credentials.

For deployment durability, still pending:

1. Run `pnpm tsx src/agent/session-store.probe.ts` with a real key. PASS in B is required before
   relying on durability. Paste C's output into `tasks/agent_memory.md` Known Gotchas.
2. Check Railway's SIGTERM-to-SIGKILL window (draining setting) against `SHUTDOWN_GRACE_MS`.
3. Deploy while the shop is idle: the deployment being replaced holds no instance lock, so on that
   one deploy a live claim can still be expired.
4. Then sub-project C.

Still pending from sub-project A: the live checks below. A is merged, but merging did not
verify cost accounting or the deployed bot.

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
- **F. Submission packaging** — README trimmed to 95 lines with the full text moved to
  `docs/DESIGN.md` (done on `readme-trim`, author still to read the wording); bring HANDOFF and todo
  current; recording.

## Open questions

- What live dollar cap is authorized? The SDK stops after exceeding `maxBudgetUsd`; I have
  proposed strict admission accounting with that billing limitation disclosed, not a guaranteed
  provider-charge ceiling. See the spec before approving.
- **Recording script.** Seven graded beats plus voice, Hindi and reorder is too much for five
  minutes. Suggest featuring the two strongest — the oversell guard and the mid-build bill edit —
  and showing voice and Hindi briefly rather than fully.
- **Photo input** is designed but unbuilt. It needs `prompt: AsyncIterable<SDKUserMessage>`, whose
  interaction with session resume is unverified. Only worth it if packaging finishes early.

## In-flight files

I committed the requested reconciliation as `b6ac0af`. The approved Phase 1 spec, plan and
checkpoint updates remain uncommitted. `src/evals/database.ts` and its tests currently exist.
Task 1a has 14 dedicated-instance tests and a fresh review passing; evidence is in
`evals/results/task-1a-fix-*`. Protected subprocess capture and task 2 tool/model observation
are implemented and reviewed; evidence is in `evals/results/task-1b-mutations.md` and
`evals/results/task-2-mutations.md`. Task 3's amended deterministic oracle is implemented and
has a fresh independent review passing. It reads actual generated PDF text and PPTX XML, checks
persisted bill inputs and aggregates, and verifies store-scoped movement snapshots. Its final
gate passed with 46 files and 453 tests on the disposable `eval_control` database; exact output
and mutation evidence are in `.superpowers/sdd/2026-10-06-agent-evals/task-3-report.md` and
`evals/results/task-3-mutations.md`. It has no live agent run or measured model outcome.

Task 4 replay isolation amendment is approved and implemented in the working tree. Real-handler replay now requires
an owned sandbox and runs in a fresh child process with that sandbox's worker URL. It compares
host, port, database and user for process and pool targets, and repeats those checks before each
step. The separate injected-tools API is explicitly test-only. Connection failures are serialized
without their messages or connection strings. The initial focused replay run passed 6/6. The
retry-accounting correction adds a Telegram ledger test. A fresh independent review found two
issues, then passed after both fixes: CI skips only the two separate-sandbox integration tests
when `EVAL_TEST_DATABASE_ADMIN_URL` is absent, and the child revalidates its persisted ownership
manifest before each step. The approved amendment documents those changes. Task 4 replay is
available to synthetic work; the complete eval runner and live baseline remain pending.

During Task 3, `pnpm db:migrate` was run without a URL override; drizzle-kit loaded `.env` and
reported success against the configured localhost port 5435. A later invoice test failed with
`EPERM` before connecting to port 5435; no query succeeded. With user approval, I later ran one
read-only transaction querying only `drizzle.__drizzle_migrations` on localhost:5435. Its six
rows match all six entries in the current migration journal, establishing that the database was
at the journal head when checked. This does not establish whether the earlier command changed it.
No rollback was attempted and no credentials were printed. No database commands should run
without explicit disposable URL overrides.
The execution ledger is `.superpowers/sdd/2026-10-06-agent-evals/progress.md`.
`Claude outputs/` was already untracked when I started and I have left it alone.

## Verification baseline

I reran the gate on 2026-10-06 at commit `b6ac0af`, with only the proposal and tracking docs
uncommitted, Node v24.13.0. Model id: not applicable, no live model calls. The first sandboxed
attempt failed with Postgres connection `EPERM`; both reruns with local database access passed.
The final run reported:

```text
 Test Files  39 passed (39)
      Tests  386 passed (386)
   Start at  11:53:14
   Duration  19.06s (transform 275ms, setup 208ms, import 6.68s, tests 9.32s, environment 2ms)
```

The test count below is current. Live outcomes in older notes are historical claims, not
results reproduced in this session.

Current Phase 1 checkpoint: Tasks 1a, 1b, 2, and 3 are complete. The approved Task 4 replay
isolation amendment passed fresh independent review; Tasks 5–8 are still incomplete. The latest
required full gate passed on 2026-10-07 with
both database URL variables explicitly set to the disposable `eval_control` service, Node
v24.13.0, model id not applicable:

```text
> pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test
> Newpage_assignment@1.0.0 fmt:check /Users/divyanshu/Desktop/All Projects/supermarket-ops-agent
> prettier --check .

Checking formatting...
All matched files use Prettier code style!

> Newpage_assignment@1.0.0 lint /Users/divyanshu/Desktop/All Projects/supermarket-ops-agent
> eslint .


> Newpage_assignment@1.0.0 typecheck /Users/divyanshu/Desktop/All Projects/supermarket-ops-agent
> tsc --noEmit


> Newpage_assignment@1.0.0 test /Users/divyanshu/Desktop/All Projects/supermarket-ops-agent
> vitest run


 RUN  v4.1.10 /Users/divyanshu/Desktop/All Projects/supermarket-ops-agent


 Test Files  47 passed (47)
      Tests  460 passed (460)
   Start at  15:11:11
   Duration  27.16s (transform 391ms, setup 213ms, import 8.06s, tests 15.82s, environment 2ms)
```

The first attempt was blocked by sandbox EPERM to local Postgres; the same command was
rerun with approved local database access and passed. This is not a live eval result.

Before any push, I also ran the same gate in clean detached worktrees at each of the three
requested commits. Each run used the disposable single Postgres service with
`EVAL_TEST_DATABASE_ADMIN_URL` unset, matching CI's service shape. Results:

```text
522028d Task 1: 41 files passed; 404 passed, 9 skipped (413 total)
91dd8f4 Task 2: 42 files passed; 416 passed, 9 skipped (425 total)
bb5ab8e Task 3: 46 files passed; 442 passed, 11 skipped (453 total)
```

Formatting, lint and typecheck passed in all three worktrees. The database-isolation integration
cases skipped cleanly without the dedicated admin URL. The Task 4 replay suite also skips its
two sandbox-provisioning tests with this CI shape; see the Task 4 replay report for exact output.

```bash
pnpm db:up
pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test   # 386 tests, 39 files
pnpm tsx src/agent/e2e.ts                                    # 13 beats, live rerun pending
pnpm tsx src/agent/security.probe.ts                         # live rerun pending
```

Tip: if 5432 is taken by a native Postgres, set `POSTGRES_PORT` and `DATABASE_URL` accordingly (the
author ran the compose DB on 5435).

Voice needs `OPENAI_API_KEY`; without it the bot runs normally and replies that voice isn't
configured. The execution ledger for the improvements branch is at
`.superpowers/sdd/2026-08-01-improvements/progress.md`; for sub-project A at
`.superpowers/sdd/2026-10-04-guardrails-and-cost/`.

## 2026-10-07 eval-harness checkpoint

The Task 4 replay-isolation amendment is approved and has a fresh independent PASS. The worker
uses a proof derived from the exact owned sandbox, compares host/port/database/user without
passwords, and revalidates the persisted manifest and DB target before every step. On the
single-Postgres CI shape, replay reports 5 passed and 2 sandbox provisioning tests skipped;
with the disposable eval admin service, all 7 replay tests pass. The current `runtime.ts`
default production call path was reviewed and remains unchanged; retry-cap failure accounting
is handled in the Telegram adapter and covered by its own DB-backed test.

The latest user instruction set the live budget to zero. No live calls or probes ran, and
`cost.probe.ts` was not run. Tasks 5–8 have synthetic budget/report primitives and a comparison
command that refuses because SDK cost semantics are unverified. This is not a full eval runner:
the complete coordinator/CLI, 50 reviewed scenarios, blind judge calibration, regression
demonstrations and live baseline are still open. Details and exact future runbook are in
`evals/results/task-5-to-8-synthetic.md`. Synthetic results are never eligible as a baseline.
