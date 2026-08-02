# Todo

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
- [ ] README (~1 page): harness + why, control loop, skill/tool design, each hard part, edge cases skipped
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

## Remaining — packaging

- [ ] **Rotate `TELEGRAM_BOT_TOKEN` and `ANTHROPIC_API_KEY`** — both reached deployment logs
      before the redactor landed
- [ ] Merge `improvements` → `main`, redeploy so Railway runs this code
- [ ] Make the repo public (`gh repo edit … --visibility public`) — user runs this
