# Todo

## Responsible AI, data protection, and safety (2026-10-07) — approved, implementation underway

- [x] Draft workstream spec: `docs/specs/2026-10-07-responsible-ai.md`
- [x] Draft implementation plan: `docs/plans/2026-10-07-responsible-ai.md`
- [x] Owner approval and implementation decisions recorded in spec and plan
- [x] W1: enforce single-use owner confirmation for high-impact exceptions (gate green; independent review complete)
- [x] W2: constrain and safely render owner preferences (gate green; independent review complete)
- [x] W5: add accurate `/privacy` and onboarding disclosure (gate green; independent review complete)
- [ ] W3: implement approved transcript and artifact retention
- [ ] W4: export and erasure, blocked on legal/product record-retention decision
- [ ] W6: data inventory, threat model, impact assessment, system card, risk register, incident runbook
- [ ] W7: synthetic safety replay scenarios and CI coverage

Checklist written **before** implementing. Mark `[x]` as each item finishes — don't batch.
Milestones from the design spec §13. The detailed per-task breakdown comes from
`writing-plans` and lands in `docs/plans/`.

---

## Milestone 0 — Onboarding & design

- [x] Explore project context, establish stack
- [x] Write `CLAUDE.md` (operating manual)
- [x] Write design spec → `docs/specs/2026-07-29-supermarket-ops-agent-design.md`
- [x] Scaffold `tasks/`, `docs/`, `HANDOFF.md`
- [x] **User approves the spec** ← blocking everything below
- [x] Implementation plan via `writing-plans` → `docs/plans/`

## Milestone 0 — Walking skeleton (first few hours, before anything else)

- [x] Toolchain: `package.json`, tsconfig, eslint, prettier, vitest, drizzle-kit
- [x] Docker Compose for local Postgres
- [x] Minimal schema: `stores`, `products` only
- [x] One tool: `get_stock`, with `store_id` injection
- [x] Agent SDK runtime with the `allowedTools` allowlist ON
- [x] Telegram adapter, minimal — real message in, real reply out
- [x] Deploy to Railway, **replicas pinned to 1**
- [x] ✅ Real Telegram message → agent → Postgres → reply, on the deployed instance
- [x] **Verify: one trivial skill loads with the allowlist on** (spec §14 — highest risk)
- [x] **Verify: `effort` latency** on a simple stock query; pick the level
- [x] Record the decision + measurements in `tasks/agent_memory.md`

## Milestone 1 — Foundation

- [x] Full schema + migrations (all tables, spec §5)
- [x] `domain/money.ts`, `domain/units.ts`, `domain/gst.ts` — pure
- [x] Unit tests: MRP back-calc, **line-total-before-tax (the 5332/5333 case)**, loose-item
      division rounding, half-up, CGST/SGST odd-paise split, unit conversion
- [x] Seed routine: catalogue, opening stock, khata accounts, low-stock SKUs
- [x] **Seed history dated relative to `now()` at provisioning**, never hardcoded

## Milestone 2 — Tool layer

- [x] inventory tools + tests
- [x] billing tools + tests, incl. `find_bills`
- [x] **`finalize_bill` with `payment_mode: "khata"` — ledger charge inside the same transaction**
- [x] khata tools + tests
- [x] analytics tools + tests
- [x] preferences tools + tests
- [x] Integration test per §4 invariant (each must fail if its guard is removed)
- [x] Concurrency test: parallel finalize over the same low stock
- [x] Idempotency: occurrence ordinal in the key; test two identical calls in one turn both apply
- [x] Transport: `processed_updates` as **claim/done**; test a claimed-but-not-done update reprocesses

## Milestone 3 — Conversation

- [x] Remaining `.claude/skills/` — inventory, billing, khata, analytics, documents
- [x] System prompt builder with preference injection
- [x] Session mapping, typing indicator, artifact delivery path
- [x] Commands: `/start`, `/new`, `/reset`, `/help`
- [x] **Full end-to-end conversation working**

## Milestone 4 — Artifacts

- [x] Invoice PDF (pdfmake) — line table, rate-wise tax summary, round-off, shop identity
- [x] Analysis deck (pptxgenjs) — native charts for sales, top items, stock health, GST collected
- [x] Artifact delivery back to the chat
- [x] Tests: valid file structure, PDF totals match DB

## Milestone 5 — Ship

- [x] Railway deploy with managed Postgres, bot left running
- [x] README (~1 page): harness + why, control loop, skill/tool design, each hard part, edge cases skipped
      (95 lines on `readme-trim`; the full text is in `docs/DESIGN.md`; wording still to be read by the author)
- [ ] 4–5 min recording: stock → bill with edit → oversell guard → khata → PDF → deck → preference + `/new`
- [x] Final gate: `pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test`

---

## Improvements branch (2026-08-01 → 02) — complete

Plan: `docs/plans/2026-08-01-improvements.md`. All ten tasks, plus a grounding fix and five
fixes from the final whole-branch review.

- [x] Loose atta seeded — the brief's "which atta?" example had nothing to be ambiguous against
- [x] `bot.catch` + secret redactor — grammY's default handler stopped the bot and leaked the token
- [x] Structured turn logging — message text off by default in production
- [x] `alwaysLoad: true` — ToolSearch 10/13 beats → 0/13, median 9064ms → ~7000ms
- [x] Hindi/Hinglish skill — glossary and register, no alias column
- [x] `handleTurn` extracted to `src/telegram/turn.ts`, shared by text and voice
- [x] Voice input — Whisper, echo-before-acting, claim before spending on the download
- [x] Stale drafts hidden from `find_bills`
- [x] `reorder_suggestions` — ranked by days-of-cover from real sales velocity
- [x] Idempotency layer 2 — `open_bill` **and** `add_bill_item` (keying one alone was worse)
- [x] Grounding fix — the prompt said "price or quantity"; a khata balance is neither
- [x] Suite flake fixed — `fileParallelism: false`; was red ~1 run in 5
- [x] Gate green: 236 tests, three consecutive clean runs
- [x] `e2e.ts`: PASS 13/13

## Production hardening — sub-project A: guardrails and cost (branch `production-hardening`)

Plan: `docs/plans/2026-10-04-guardrails-and-cost.md`. Implemented and merged into `main`
through `fa89f53` (PR #1). I verified the history on 2026-10-06; live checks remain pending.

- [x] 1. Environment configuration (limits, budget, rate limit, models)
- [x] 2. Schema and migration (`invite_codes`, `usage`, session cost)
- [x] 3. Access repository (invite codes, atomic redemption)
- [x] 4. Usage repository and session cost
- [x] 5. Rate limiter
- [x] 6. Agent limits, runtime and cost probe
- [x] 7. Messages and commands (invite-aware `/start`, confirm-gated `/reset`)
- [x] 8. Access gate, turn wiring and bot assembly (incl. `/start@otherbot` fix)
- [x] 9. Invite CLI
- [x] 10. Documentation and gate (307 tests, three runs)
- [ ] Live: `pnpm tsx src/agent/cost.probe.ts` (settles `SDK_COST_IS_CUMULATIVE`) — needs credentials
- [ ] Live: `pnpm tsx src/agent/e2e.ts`, 13 beats ok under the new limits — needs credentials
- [ ] Live: Telegram checklist (stranger reply, code redeem, reuse rejected, `/reset` vs `/reset confirm`, `cost_usd`/`num_turns` in log) — needs a real bot token
- [x] Merge sub-project B through PR #2, then PR #1
- [ ] Sub-project B live checks and sub-projects C–F (see `HANDOFF.md`)

## Production hardening — sub-project B: session durability and shutdown (branch `production-hardening-b`)

Plan: `docs/plans/2026-10-04-session-durability-and-shutdown.md`. Implemented and merged
through `8536b3d` (PR #2) and `fa89f53` (PR #1).

- [x] 1. Transcript table and repository
- [x] 2. SDK session-store adapter
- [x] 3. Clearing a conversation and boot-time claim expiry
- [x] 4. Runtime: use the store, drop an unknown resume, retry a failed start
- [x] 5. Live probe for the store (written, not run)
- [x] 6. Drain gate, graceful shutdown, instance lock and boot recovery
- [x] 7. Documentation and gate
- [ ] Live: `pnpm tsx src/agent/session-store.probe.ts` (B must PASS; paste C's output into agent_memory) — needs credentials
- [ ] Check Railway's SIGTERM-to-SIGKILL window against `SHUTDOWN_GRACE_MS` — needs Railway
- [ ] Deploy while the shop is idle (first-deploy lock transition) — needs Railway

## Remaining — packaging

- [ ] **Rotate `TELEGRAM_BOT_TOKEN` and `ANTHROPIC_API_KEY`** — both reached deployment logs
      before the redactor landed
- [x] Merge `improvements` → `main` (redeploy still needed so Railway runs it)
- [ ] Make the repo public (`gh repo edit … --visibility public`) — user runs this

## Applied AI work, checkpoint 2026-10-06

- [x] Read operating rules and tracking documents; reconcile A and B against git history
- [x] Create `eval-harness` from working branch `readme-trim`, code commit `4359796`
- [x] Run the current gate: 386 tests in 39 files, 2026-10-06, no model calls
- [x] Write Phase 1 spec `docs/specs/2026-10-06-agent-evals.md` and companion plan
- [x] Obtain approval of both documents before writing code (2026-10-06)
- [ ] Agree live spend cap and the SDK stop-after-exceed budget limitation
- [ ] Run protected live prerequisites: cost, session store, e2e, security, in that order
- [ ] Implement and verify Phase 1, including test mutations and live regression experiments
- [x] Task 1a: Postgres sandbox isolation — 14/14 dedicated-instance tests pass; initial
      review findings fixed and fresh scoped review passed. Eight semantic mutations killed.
- [x] Task 1b: protected subprocess output capture — security findings fixed and fresh
      evidence review passed; 13 behavior tests mutation-checked.
- [x] Task 2: tool and model-attempt observation — SDK hook IDs correlate outcomes; optional
      result flags, fallback usage and retry failure evidence are tested and reviewed. Gate:
      42 files, 416 passed and 9 skipped on 2026-10-06.
- [x] Task 3: scenario contract and deterministic oracle — actual generated PDF text and PPTX
      XML/chart content, persisted bill inputs and aggregates, exact external-change grounding,
      candidate shape, and store-scoped snapshots checked. Oracle amendment reviewed and approved;
      both movement-store predicate mutants fail. Final gate: 46 files, 453 tests on disposable
      `eval_control`; exact output is in the Task 3 report.
- [ ] Task 4: approved replay-isolation amendment implemented; child-process replay now binds to
      an owned sandbox and checks process/pool host, port, database and user before each step.
      Fresh independent review passed after both findings were fixed. CI-shaped replay run:
      5 passed, 2 sandbox-provisioning tests skipped; dedicated integration: 7 passed.
- [ ] Tasks 5–8: synthetic budget/report primitives and baseline refusal implemented and
      mutation-checked. Full coordinator, CLI, 50-scenario inventory, judge calibration,
      regression demos, and accepted baseline remain incomplete. No API calls or probes ran.
- [x] Incident check: one user-approved read-only query of `drizzle.__drizzle_migrations` on
      localhost:5435 returned six rows matching the current migration journal. This shows the DB
      was at the journal head when checked, not whether the earlier `pnpm db:migrate` changed it.
      No credentials printed and no rollback attempted. Earlier invoice test failed with EPERM
      before connecting; no query succeeded from that test.
- [ ] Live cap: zero; no probes, model evals, or live smoke runs were executed. Cost semantics
      remain unverified, comparison refuses, and no baseline is accepted.
- [ ] Live smoke: after credits exist, run cost/session/e2e/security probes in order, resolve
      SDK cost semantics, finish/review the live runner, then use the runbook in
      `evals/results/task-5-to-8-synthetic.md`. Proposed future smoke cap there is $0.25.
- [ ] Prepare each later phase separately, with its own spec, plan and approval
