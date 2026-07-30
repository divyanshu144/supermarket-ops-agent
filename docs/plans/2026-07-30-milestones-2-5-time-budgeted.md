# Milestones 2–5 — Time-Budgeted Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Get from a verified foundation to a submittable take-home — live bot, working demo
path, both artifacts, README, recording — inside the remaining day-two budget.

**Predecessor:** `2026-07-29-milestone-0-1-foundation.md` (Tasks 1–14, complete except deploy).

---

## The budget

**Assumed remaining: ~12 working hours.** Every task below carries a box. If your real budget
differs, rescale by dropping from the **Cut Ladder** rather than by compressing every task —
uniform compression is how everything ends up 80% done and nothing ships.

| Phase | Contents | Box |
|---|---|---|
| A | Billing core — the graded heart | 4h |
| B | Stock-in and khata | 1.5h |
| C | Artifacts (PDF, PPTX) | 3h |
| D | Skills, preferences, delivery | 1.5h |
| E | Ship — deploy, README, recording | 2.5h |
| | **Total** | **12.5h** |

That is over budget by 30 minutes before anything goes wrong. **Assume something will.** The
Cut Ladder exists to be used, not admired.

---

## What "done" means: the recording IS the acceptance test

The brief specifies the 4–5 minute recording exactly. Treat it as the spec:

> receive stock → multi-item bill with an edit → oversell guard → khata cycle →
> generate a PDF invoice → generate the analysis deck → set a preference, start a `/new`
> chat, show it's remembered

**Build that path in that order. Nothing outside it is required.** Every task below exists
because some frame of that recording needs it. If a proposed piece of work doesn't appear in
those seven beats, it is not in scope today.

---

## Non-negotiable floor

If everything goes wrong, these four are what make the submission exist at all:

1. **A live bot** with the `@handle` in the README (`@divagentBot`).
2. **README** — the brief asks for our reasoning, explicitly not an LLM's.
3. **The recording.**
4. **Oversell guard + GST correctness**, demonstrably. These are the two most heavily graded
   items in §4 and the two most likely to be checked by hand.

Everything else is negotiable under time pressure. Sequence protects this floor: Phase A
delivers 4, Phase E delivers 1–3.

---

## Global constraints (carried forward)

- Money in integer paise, quantities in integer base units, GST in basis points.
- `store_id` and idempotency keys injected server-side via `AsyncLocalStorage`. Never tool
  parameters.
- `allowedTools` allowlist only. `Skill` is permitted; `Read`/`Bash`/`Write` are not.
- MRP is tax-inclusive; tax derives from the **line total**, never per-unit × qty.
- Tools return refusals and ambiguity as **data**, never exceptions, so the model relays or asks.
- Every task ends with `pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test` green
  and a commit.
- Never commit on `main`.

---

# Phase A — Billing core (4h)

Everything §4 grades lives here. If Phase A is solid and the rest is thin, the submission still
reads as serious engineering. The reverse is not true.

## Task 15 — Bill lifecycle repository (2h)

**Files:** `src/repositories/bills.ts`, `src/repositories/bills.test.ts`

**Interfaces produced:**

```ts
openBill(input: { customerName?: string }): Promise<{ billId: string }>
addBillItem(input: { billId: string; productQuery: string; qty: number; unit: Unit;
                     unitPriceOverridePaise?: number }): Promise<AddItemResult>
updateBillItem(input: { billId: string; productQuery: string; qty: number; unit: Unit }): Promise<...>
removeBillItem(input: { billId: string; productQuery: string }): Promise<...>
getBill(billId: string): Promise<BillView>
findBills(input: { customer?: string; since?: Date; limit?: number }): Promise<BillSummary[]>
finalizeBill(input: { billId: string; paymentMode: PaymentMode; paymentRef?: string;
                      customerName?: string; allowBelowCost?: boolean }): Promise<FinalizeResult>
```

`FinalizeResult` is a discriminated union — success, or a **refusal** carrying a reason the
model must relay:

```ts
type FinalizeResult =
  | { status: 'finalized'; invoiceNumber: string; totals: BillTotals }
  | { status: 'already_finalized'; invoiceNumber: string; totals: BillTotals }
  | { status: 'insufficient_stock'; shortfalls: Array<{ name: string; wanted: string; available: string }> }
  | { status: 'below_cost'; lines: Array<{ name: string; price: string; cost: string }> }
  | { status: 'unknown_customer'; customerName: string }
```

**The finalize transaction is the whole task.** It must, in one transaction:

1. `SELECT … FOR UPDATE` the bill; if already `finalized`, return `already_finalized` with the
   existing invoice — a success, not an error, and emphatically not a second decrement.
2. Lock every product row **ordered by product id**, so two concurrent bills over overlapping
   products cannot deadlock by grabbing them in opposite orders.
3. Below-cost check across all lines; refuse unless `allowBelowCost`.
4. Decrement each product with compare-and-set:
   `UPDATE products SET quantity_base = quantity_base - $qty WHERE id = $id AND store_id = $s AND quantity_base >= $qty`.
   Zero rows means insufficient stock → collect shortfalls, roll back, return the refusal.
5. Compute totals via `computeLine` per item, sum, `roundToNearestRupee`.
6. Assign `invoice_number` (per-store sequence).
7. Write `stock_movements` rows (`kind: 'sale'`, negative delta).
8. **If `paymentMode === 'khata'`**: upsert the account and insert the `khata_entries` charge and
   the balance update **inside this same transaction**. Bill-then-charge as two transactions
   leaves a crash window where stock is gone and the customer was never billed.

- [ ] Write the failing tests first (list in Task 16 — write them now, they drive this)
- [ ] Implement `finalizeBill` and the rest
- [ ] Green, commit

## Task 16 — §4 invariant tests (1.5h)

**Files:** `src/repositories/bills.invariants.test.ts`

Each test must fail if its guard is removed. Name them so a future reader knows why they exist.

- [ ] **Oversell** — bill 10 of a 6-stock item → `insufficient_stock`, stock unchanged at 6
- [ ] **Oversell at the DB** — direct negative update rejected by the CHECK constraint
- [ ] **Stock only moves on finalize** — add 4 items, assert stock unchanged; finalize, assert moved
- [ ] **Concurrency** — two bills each for 4 of a 6-stock item, `Promise.all` finalize:
      exactly one succeeds, one refuses, final stock is 2, never negative
- [ ] **Idempotency** — finalize twice → same invoice number, one decrement, one set of movements
- [ ] **Deadlock-freedom** — two bills over the same two products in opposite add order,
      finalized concurrently, both resolve (no timeout)
- [ ] **Khata atomicity** — finalize with `paymentMode: 'khata'` writes the ledger charge and the
      balance in the same transaction; a forced failure mid-finalize leaves neither
- [ ] **Price snapshot** — add item, change product MRP, finalize → bill uses the snapshot
- [ ] **Below cost** — refuses without the override, proceeds with it
- [ ] Green, commit

## Task 17 — Billing tools (0.5h)

**Files:** `src/tools/billing.ts`, extend `src/tools/index.ts`, `src/tools/billing.test.ts`

Thin wrappers over Task 15. Each presents a shaped view (no raw rows — **BigInt throws on
`JSON.stringify`**, and cost price must not reach the model). Add every tool name to
`ALLOWED_TOOLS`; a name typo silently disables the tool.

- [ ] Wrappers + presented views, tests asserting no cost price / ids leak, allowlist updated
- [ ] Green, commit

---

# Phase B — Stock-in and khata (1.5h)

## Task 18 — Inventory write tools (45m)

**Files:** `src/tools/inventory.ts` (extend), tests

- [ ] `receive_stock(product_query, qty, unit, cost_price?, mrp?)` — increments, writes a
      `receive` movement, updates prices when supplied
- [ ] `add_product(name, brand?, pack_size?, unit, is_loose, hsn_code, gst_rate_bps, cost_price, mrp, opening_qty?, reorder_level?)`
- [ ] `low_stock_report()` — items at or below reorder level
- [ ] Green, commit

## Task 19 — Khata tools (45m)

**Files:** `src/repositories/khata.ts`, `src/tools/khata.ts`, tests

- [ ] `get_khata_balance`, `charge_khata`, `settle_khata`, `khata_statement`
- [ ] **The asymmetry is deliberate and must be tested:** charging an unknown name auto-creates
      the account (that is how a kirana works); *settling* an unknown name **refuses**.
- [ ] Settling more than the outstanding balance refuses and asks for confirmation
- [ ] Green, commit

---

# Phase C — Artifacts (3h)

Both are named deliverables. Neither can be faked.

## Task 20 — PDF invoice (1.5h)

**Files:** `src/documents/invoice.ts`, `src/tools/documents.ts`, tests

Must show, per line: item, HSN, qty, unit, rate, taxable, CGST rate + amount, SGST rate +
amount, line total. Then a **rate-wise tax summary grouped by slab**, the round-off, the grand
total, payment mode and reference, and the shop's name and GSTIN.

- [ ] `generateInvoicePdf(billId): Promise<{ path: string; filename: string }>`
- [ ] Tool writes to an artifacts dir and returns `{artifact_id, filename, mime}` — the agent
      never performs Telegram I/O
- [ ] Test: file is a valid PDF (`%PDF` magic bytes), non-trivial size, and **the totals in it
      match the database**
- [ ] Green, commit

## Task 21 — Analytics + PPTX deck (1.5h)

**Files:** `src/repositories/analytics.ts`, `src/documents/deck.ts`, `src/tools/analytics.ts`

- [ ] `daily_summary(date?)` — total sales, tax collected, cash/UPI/card/khata split, top items,
      bill count. This is the "close the day" capability *and* the deck's data source.
- [ ] `sales_report(from, to)`, `stock_health()`
- [ ] `generateAnalysisDeck(from?, to?)` — pptxgenjs with **native chart objects**, not images:
      sales over time, top items, stock health, GST collected
- [ ] Test: valid PPTX (it is a zip — check `PK` magic), contains chart parts, numbers match DB
- [ ] Green, commit

---

# Phase D — Skills, preferences, delivery (1.5h)

## Task 22 — Skills and system prompt (1h)

**Files:** `.claude/skills/{inventory,billing,khata,analytics,documents}/SKILL.md`,
`src/agent/runtime.ts`

The brief calls the skill/tool surface "the heart of what we grade", so these are not filler.
Each skill teaches *how to run a shop*, not *what the tool signature is* — the schema already
says that.

- [ ] Five skill files. Delete the `probe` skill.
- [ ] System prompt injects current preferences at turn start, so the model applies them with no
      tool call
- [ ] Verify skills still load (`Skill` tool in `toolsUsed`) after the swap
- [ ] Green, commit

## Task 23 — Preferences and artifact delivery (30m)

**Files:** `src/tools/preferences.ts`, `src/telegram/bot.ts`

- [ ] `get_preferences`, `set_preference`
- [ ] Adapter sends any artifacts produced during a turn as Telegram documents after the reply
- [ ] Test: preference survives `clearSession` — this is the `/new` memory demo
- [ ] Green, commit

---

# Phase E — Ship (2.5h)

**Start Phase E no later than T-3h regardless of what remains unfinished.** A polished agent
nobody can message scores zero on three named deliverables.

## Task 24 — Railway deploy (1h)

Full sequence is already written in `HANDOFF.md` under the 🚩 section. Summary:

- [ ] Auth, `railway init`, add Postgres
- [ ] Set env vars, `railway up`
- [ ] **Run migrations against Railway's Postgres — it starts empty**
- [ ] **Stop the local bot first** — two processes on one token means 409s and dropped updates
- [ ] Confirm exactly 1 replica; message the bot; `railway logs | grep -i conflict` returns nothing

## Task 25 — README (1h)

The brief wants ~1 page and says explicitly: *"We need your thoughts, not an LLM's direct
output."* Write it in first person, plainly.

- [ ] `@divagentBot` prominently
- [ ] Setup instructions
- [ ] Harness choice and why (Claude Agent SDK; skills/tools/sessions are first-class)
- [ ] How the control loop works
- [ ] Skill and tool design — the capability surface and why it is shaped that way
- [ ] **Each §4 hard part and how it is solved** — this is the section they will read closest
- [ ] **Edge cases deliberately not handled** (spec §11). The brief rewards this explicitly.
- [ ] Honest limitations: the idempotency residual risk; agent behaviour is not automatically
      tested; single-store tenancy per chat
- [ ] Screenshots

## Task 26 — Recording (30m)

- [ ] Run the seven beats end to end, on the deployed bot, in one take if possible
- [ ] Show the oversell guard actually refusing, and the PDF/PPTX opening

---

## The Cut Ladder

Drop from the top when you fall behind. Each rung is chosen so the graded core survives longest.

| # | Cut | Costs you |
|---|---|---|
| 1 | `void_bill`, `adjust_stock` | Nothing graded. Already designated. |
| 2 | `find_bills`, `khata_statement` | "That bill as a PDF" needs the id in-conversation; works in the recording, weaker off-script. |
| 3 | Deck charts → 2 charts instead of 4 | Deck still real and native. |
| 4 | `stock_health`, `sales_report` | Daily close still works; deck loses a slide. |
| 5 | Skills → 3 files instead of 5 | Weakens the "heart of what we grade" surface. Painful. |
| 6 | PPTX deck entirely | **Drops a named deliverable.** Only above the floor. |

**Never cut:** deploy, README, recording, oversell guard, GST correctness.

## Checkpoints

- **T-8h** — Phase A must be done. If not, cut rungs 1–2 immediately and reassess.
- **T-5h** — Phases B and C must be done. If not, take rungs 3–4.
- **T-3h** — **Start Phase E no matter what.** Anything unfinished is now a Cut Ladder decision,
  not a "just finish it" decision.
- **T-1h** — Recording done. Stop building.

---

## A note on the brief's last line

> *"Ping us with questions — knowing what to ask is part of the signal."*

If anything is genuinely ambiguous, asking BigMantra is explicitly rewarded rather than
penalised. Worth using if a real question comes up — it costs nothing and is scored.
