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
- [ ] **User approves the spec** ← blocking everything below
- [ ] Implementation plan via `writing-plans` → `docs/plans/`

## Milestone 0 — Walking skeleton (first few hours, before anything else)

- [ ] Toolchain: `package.json`, tsconfig, eslint, prettier, vitest, drizzle-kit
- [ ] Docker Compose for local Postgres
- [ ] Minimal schema: `stores`, `products` only
- [ ] One tool: `get_stock`, with `store_id` injection
- [ ] Agent SDK runtime with the `allowedTools` allowlist ON
- [ ] Telegram adapter, minimal — real message in, real reply out
- [ ] Deploy to Railway, **replicas pinned to 1**
- [ ] ✅ Real Telegram message → agent → Postgres → reply, on the deployed instance
- [ ] **Verify: one trivial skill loads with the allowlist on** (spec §14 — highest risk)
- [ ] **Verify: `effort` latency** on a simple stock query; pick the level
- [ ] Record the decision + measurements in `tasks/agent_memory.md`

## Milestone 1 — Foundation

- [ ] Full schema + migrations (all tables, spec §5)
- [ ] `domain/money.ts`, `domain/units.ts`, `domain/gst.ts` — pure
- [ ] Unit tests: MRP back-calc, **line-total-before-tax (the 5332/5333 case)**, loose-item
      division rounding, half-up, CGST/SGST odd-paise split, unit conversion
- [ ] Seed routine: catalogue, opening stock, khata accounts, low-stock SKUs
- [ ] **Seed history dated relative to `now()` at provisioning**, never hardcoded

## Milestone 2 — Tool layer

- [ ] inventory tools + tests
- [ ] billing tools + tests, incl. `find_bills`
- [ ] **`finalize_bill` with `payment_mode: "khata"` — ledger charge inside the same transaction**
- [ ] khata tools + tests
- [ ] analytics tools + tests
- [ ] preferences tools + tests
- [ ] Integration test per §4 invariant (each must fail if its guard is removed)
- [ ] Concurrency test: parallel finalize over the same low stock
- [ ] Idempotency: occurrence ordinal in the key; test two identical calls in one turn both apply
- [ ] Transport: `processed_updates` as **claim/done**; test a claimed-but-not-done update reprocesses

## Milestone 3 — Conversation

- [ ] Remaining `.claude/skills/` — inventory, billing, khata, analytics, documents
- [ ] System prompt builder with preference injection
- [ ] Session mapping, typing indicator, artifact delivery path
- [ ] Commands: `/start`, `/new`, `/reset`, `/help`
- [ ] **Full end-to-end conversation working**

## Milestone 4 — Artifacts

- [ ] Invoice PDF (pdfmake) — line table, rate-wise tax summary, round-off, shop identity
- [ ] Analysis deck (pptxgenjs) — native charts for sales, top items, stock health, GST collected
- [ ] Artifact delivery back to the chat
- [ ] Tests: valid file structure, PDF totals match DB

## Milestone 5 — Ship

- [ ] Railway deploy with managed Postgres, bot left running
- [ ] README (~1 page): harness + why, control loop, skill/tool design, each hard part, edge cases skipped
- [ ] 4–5 min recording: stock → bill with edit → oversell guard → khata → PDF → deck → preference + `/new`
- [ ] Final gate: `pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test`
