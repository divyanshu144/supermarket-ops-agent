# Supermarket Ops Agent — Design Spec

**Date:** 2026-07-29
**Status:** **Approved** 2026-07-29, after one review round (findings applied as AD-15 … AD-25 in `tasks/agent_memory.md`)
**Deadline:** 2 days, fixed
**Brief:** `Assignment.md` (BigMantra take-home)

---

## 1. What we're building

A conversational agent that runs an Indian kirana store end to end from Telegram. The owner
receives stock, cuts bills, checks stock, runs customer credit, closes the day, and pulls
invoices and analysis decks, all in plain terse English. No web app, no admin panel, no forms.

**The model orchestrates.** We author skills and tools; Claude decides what to call. A regex or
keyword intent router doing the real routing is an automatic fail per the brief, as is a
node-per-command state machine. Clarifying questions come from the model, never from a branch.

### Scope decision

Two days, fixed. This spec covers the §3 capability list and the §4 hard parts, and **nothing
from §7**. The §4 list is what is actually graded; a demo that nails oversell, idempotency,
concurrency and GST beats one with voice notes bolted on over a race condition.

---

## 2. Locked decisions

| Decision | Choice | Reason |
|---|---|---|
| Harness | Claude Agent SDK (TypeScript) | Named first in the brief. Skills, tool schemas, subagents and sessions are first-class, so the graded surface is the SDK's own idiom. |
| Model | `claude-opus-5`, adaptive thinking | Tool-orchestration reliability matters more than token cost here. No cheaper routing. |
| Runtime | Node 24, pnpm | Installed locally. |
| Telegram | grammY, **long-polling** in dev and prod | No public URL, no webhook config, no TLS. Redelivery dedupe is required regardless of transport. |
| Database | Postgres + Drizzle | Row-level locking and real transaction isolation, which is the honest answer to the concurrency requirement. |
| Tenancy | **One store per Telegram chat** | Reviewers run the same script concurrently; a shared store means one reviewer's stock-in silently defeats another's oversell-guard demo. |
| PDF | `pdfmake` | Declarative docs with native table support. A GST invoice is two tables. No headless Chrome, so no 300MB image or cold-start risk. |
| PPTX | `pptxgenjs` | Emits **native** PowerPoint chart objects. The brief demands real charts. |
| Tests | Vitest | TS-native, fast, covers unit and integration. |
| Deploy | Railway | Managed Postgres attached in one click, push-to-deploy, stays running through review. |

---

## 3. Architecture

```
Telegram
   │  long-poll
   ▼
┌─────────────────────────────────────────────────┐
│ src/telegram  adapter                           │
│  update_id dedupe · chat→store resolution       │
│  session mapping · typing indicator             │
│  artifact delivery (PDF/PPTX back to chat)      │
└────────────────────┬────────────────────────────┘
                     │ text + injected context
                     ▼
┌─────────────────────────────────────────────────┐
│ src/agent  Claude Agent SDK query() loop        │
│  system prompt · skills · session resume        │
│  observe → reason → act → feed back → continue  │
└────────────────────┬────────────────────────────┘
                     │ tool calls
                     ▼
┌─────────────────────────────────────────────────┐
│ src/tools  in-process SDK MCP server, Zod       │
│  thin · validated · invariants enforced here    │
└──────────┬──────────────────────────┬───────────┘
           ▼                          ▼
   ┌───────────────┐          ┌────────────────┐
   │ src/domain    │          │ src/db         │
   │ GST, rounding │          │ Drizzle, txns  │
   │ units. Pure.  │          │ row locks      │
   └───────────────┘          └────────────────┘
```

### Layering rule

`domain/` knows nothing about the DB or the agent, and is exhaustively unit-tested.
`tools/` compose `domain/` + `db/`. `agent/` knows tools but not Telegram. `telegram/` knows the
agent but never the DB. Dependencies point one way. **Business rules never live in the prompt.**

### Directory layout

```
src/
  index.ts          config validation, migration check, wire adapter → agent, start
  config/           env parsing, fail fast at boot
  telegram/         grammY adapter, commands, dedupe, artifact delivery
  agent/            SDK setup, system prompt builder, session store
  tools/            inventory · billing · khata · analytics · documents · preferences
  domain/           gst.ts · money.ts · units.ts · resolve.ts   (pure, no I/O)
  db/               schema.ts · migrations/ · repositories/ · tx.ts
  seed/             catalogue + synthetic history
.claude/skills/     inventory · billing · khata · analytics · documents
```

---

## 4. Security model

Two rules, both consequences of the bot being an open input channel.

**1. The built-in tool surface is disabled.** The Claude Agent SDK ships Bash, Read, Write, Edit,
Glob, Grep, WebSearch and WebFetch. Left on, that is a live shell behind a Telegram chat box.
`allowedTools` is an explicit allowlist of our own MCP tools and nothing else.

**2. `store_id` is never a tool parameter.** Tool schemas expose only business arguments
(`sku`, `qty`, `amount`). The adapter injects `store_id` into the execution context from the
verified Telegram chat. The model has no argument with which to address another store, so no
amount of prompt injection reaches one. Tenancy is enforced at the boundary, not hoped for in
the prompt. The same mechanism injects the idempotency key (§7).

---

## 5. Data model

All state tables carry `store_id`. Money is **integer paise**, never floats. Quantities are
**integer base units** (grams for kg/g, millilitres for litre/ml, whole units for
packet/dozen/piece) so that 2.5 kg of loose sugar is `2500` and never a float.

| Table | Key columns | Notes |
|---|---|---|
| `stores` | `id` (Telegram chat id), `name`, `gstin`, `state_code` | Shop identity for invoices. |
| `preferences` | `(store_id, key)`, `value` jsonb | Behavioural defaults: payment mode, preferred brand. Survives `/new`. |
| `products` | `store_id`, `name`, `brand`, `pack_size`, `unit`, `is_loose`, `hsn_code`, `gst_rate_bps`, `cost_price_paise`, `mrp_paise`, `quantity_base`, `reorder_level_base` | `CHECK (quantity_base >= 0)` is the oversell backstop. GST as basis points (0/500/1200/1800), never a float percentage. |
| `bills` | `status` (draft/finalized/void), `customer_name`, `payment_mode` (cash/upi/card/**khata**), `payment_ref`, `subtotal_paise`, `cgst_paise`, `sgst_paise`, `round_off_paise`, `total_paise`, `invoice_number` | Totals and invoice number are null until finalize. `payment_mode = khata` requires `customer_name`. **Multiple concurrent drafts per store are legal** — the brief's "two bills in flight" is an intra-chat scenario, since per-chat stores never contend cross-chat. |
| `bill_items` | `bill_id`, `product_id`, `qty_base`, `unit_price_paise`, `gst_rate_bps`, `hsn_code` | **Price, GST rate and HSN are snapshotted at add time** so a bill built over several messages doesn't shift if someone edits the product mid-build. |
| `khata_accounts` | `store_id`, `customer_name`, `phone`, `balance_paise` | Unique on `(store_id, lower(customer_name))`. |
| `khata_entries` | `account_id`, `kind` (charge/payment/adjustment), `amount_paise`, `bill_id`, `note` | Append-only ledger. Balance maintained on the account inside the same transaction. |
| `stock_movements` | `product_id`, `kind` (receive/sale/adjust/reversal), `qty_base_delta` signed, `bill_id`, `unit_cost_paise` | Audit trail, and the source for sales velocity in the deck. |
| `idempotency_keys` | `(store_id, key)` PK, `operation`, `result` jsonb | Insert-first, on conflict return the stored result. The unique constraint *is* the enforcement. Key includes an **occurrence ordinal** — see §7. |
| `processed_updates` | `update_id` PK, `chat_id`, `status` (claimed/done), `claimed_at`, `completed_at` | Transport-layer **claim**, not a completion marker. See §7. |
| `sessions` | `store_id` PK, `agent_session_id` | Chat → Agent SDK session for resume. `/new` clears this row and nothing else. |

---

## 6. GST computation

This is where "did they actually think about it" lives.

### MRP is tax-inclusive

Maximum Retail Price in India is inclusive of all taxes. Adding GST on top of MRP would charge
the customer more than the printed price, which is illegal. So we **back-calculate**:

```
taxable_paise = round_half_up(mrp_paise × 10000 / (10000 + gst_rate_bps))
gst_paise     = mrp_paise − taxable_paise
```

For Amul Butter 100g at MRP ₹62 and 12% GST: taxable ₹55.36, GST ₹6.64, customer pays ₹62.

### Order of operations — line total first, then tax

**The tax is derived from the line total, never from per-unit tax multiplied by quantity.** The
two differ by a paise or two and only one is defensible: the customer pays `MRP × qty` exactly,
so the taxable value must be back-calculated from that figure.

Worked example, 4 × Maggi 70g at MRP ₹14, 5% GST:

| Order | Taxable | GST | Total |
|---|---|---|---|
| Per-unit then multiply | `round(1400 × 10000/10500) = 1333` ×4 = **5332** | 268 | 5600 |
| **Line total then derive** ✅ | `round(5600 × 10000/10500)` = **5333** | 267 | 5600 |

### Loose-item line totals

`mrp_paise` is the price per **selling unit** (per kg for loose, per packet for packaged), while
`qty_base` is in base units (grams). The line total therefore requires a division:

```
line_total_paise = round_half_up(mrp_paise × qty_base / base_units_per_selling_unit)
```

2.5 kg of sugar at ₹52/kg: `round_half_up(5200 × 2500 / 1000)` = 13000 paise = ₹130.00.
The division rounds **half-up, once, at the line level**, before any tax derivation.

### Split and rounding

- **CGST = floor(gst_paise / 2); SGST = gst_paise − CGST.** Odd paise go to SGST. Documented,
  deterministic, and the two always sum to the total GST.
- Intra-state supply only, so always CGST + SGST. Inter-state (IGST) is out of scope (§11).
- Bill total rounded to the nearest rupee; the difference becomes an explicit `round_off_paise`
  line on the invoice, as Indian GST invoices show.
- 0% items (loose atta, rice, fresh produce) have `taxable = mrp`, `gst = 0`, and still appear in
  the tax breakup with their HSN and a 0% rate.

All of the above lives in `domain/gst.ts` and `domain/money.ts` with table-driven tests covering
each rule, including the 5332-vs-5333 case above and odd-paise CGST/SGST splits.

### The invoice must show

Per line: item, HSN, qty, unit, rate, taxable value, CGST rate + amount, SGST rate + amount,
line total. Then a **rate-wise tax summary** grouped by GST slab, the round-off, the grand total,
payment mode and reference, and the shop's name and GSTIN.

---

## 7. The §4 hard parts, and where each is enforced

Every one of these gets a test that fails if the guard is removed.

### Grounding
Prices, GST slabs and stock come only from the DB via tools. An unresolvable product returns
`{status: "not_found"}` and the model asks rather than inventing a price.

### Oversell guard
Enforced at the tool layer with a compare-and-set, never read-then-write:

```sql
UPDATE products SET quantity_base = quantity_base - $qty
WHERE id = $id AND store_id = $store AND quantity_base >= $qty
RETURNING quantity_base
```

Zero rows returned means insufficient stock, and the whole transaction rolls back. The
`CHECK (quantity_base >= 0)` constraint is the backstop if anything ever bypasses the tool.

### Multi-turn bills
A bill accumulates across messages as `status = draft`. `add_bill_item` snapshots price and GST
and returns a running total; it does **not** touch stock. `add_bill_item` returns a soft warning
when the requested qty exceeds current stock, so the model can flag it early, but the hard block
is at finalize. **Stock decrements only on finalize.**

### Idempotency — three layers
Telegram redelivers updates, so a retried finalize must not double-bill.

**1. Transport — a claim, not a completion marker.** This distinction is load-bearing. Under
long-polling, Telegram redelivers *only* when the offset didn't advance, which is exactly the
crash-mid-handling case. A naive insert-on-receipt would therefore reject the redelivery of a
turn that never finished, and the owner's message would vanish silently. So:

| On receipt | Action |
|---|---|
| No row | Insert `status = claimed`, process, then mark `done` |
| Row `done` | Genuine duplicate. Skip. |
| Row `claimed`, stale | Previous attempt died mid-turn. **Reprocess**, letting layers 2 and 3 absorb whatever partially ran. |

**2. Tool — keyed with an occurrence ordinal.** Each mutating call carries a key derived by the
adapter from `(update_id, tool_name, hash(args), ordinal)`, injected server-side exactly like
`store_id` and never model-supplied. The ordinal is a per-turn counter over
`(tool_name, args_hash)`, so the *N*th identical call maps to the *N*th stored result. Without
it, two legitimately identical calls in one turn — a bill with two identical lines — would
collide, and the second would silently become a no-op returning the first result.

**3. Semantic.** `finalize_bill` on an already-finalized bill returns the existing invoice as a
success. Not an error, and emphatically not a second decrement. `open_bill` is likewise
idempotency-keyed, so a reprocessed turn resumes the same draft instead of opening a second one.

> **Accepted residual risk.** The ordinal assumes a reprocessed turn issues the same sequence of
> identical calls, and model output is not deterministic. Keying `open_bill` closes the worst
> path (two distinct bills, two decrements). A replay that diverges structurally could still
> double-apply. Fully solving it needs a durable per-turn execution log, which is out of budget
> at two days. Documented in the README rather than papered over.

### Concurrency
- Every mutation runs in a transaction.
- Rows locked with `SELECT … FOR UPDATE`, **ordered by product id**, so two bills touching the
  same products can't deadlock by grabbing them in opposite orders.
- Stock changes are compare-and-set, so a read-modify-write race is structurally impossible.
- `finalize_bill` locks the bill row and re-checks `status = draft` inside the lock.

### Guardrails
Tools return refusals as **data** the model must relay, never silently comply and never throw.

- **Below cost.** `add_bill_item` accepts an optional `unit_price_override`; finalize refuses if
  any line price is under cost price, and requires an explicit override argument to proceed.
- **No stock deletion.** There is no delete tool. Corrections go through `adjust_stock`, which
  writes a signed `stock_movements` row and leaves the audit trail intact.
- **Phantom khata.** `settle_khata` on an unknown customer refuses. Settling more than the
  outstanding balance refuses and asks for confirmation. Note the deliberate asymmetry:
  *charging* a new name auto-creates the account, because that is how a kirana actually works.

### Bill-to-khata in one transaction
"Make a bill … put it on Ramesh's khata" is the most common kirana flow, so `finalize_bill`
accepts `payment_mode: "khata"` with a `customer_name`. The stock decrement, the tax
computation, the invoice number and the `khata_entries` charge plus account balance update all
happen **inside a single transaction**. Finalising and then charging as two calls would leave a
crash window in which stock is decremented and the customer is never billed — the books-consistency
failure the brief is explicitly testing for.

### Memory across sessions
Preferences live in Postgres, outside the context window. They are injected into the system
prompt at the start of every turn so the model applies them without a tool call, and written via
`set_preference`. `/new` clears the conversation session row and touches nothing else.

### Real artifacts
`pdfmake` produces a GST-correct invoice; `pptxgenjs` produces a deck with native chart objects.
Tools write to an artifacts directory and return `{artifact_id, filename, mime}`; the adapter
delivers them after the turn. The agent never performs Telegram I/O.

---

## 8. Tool surface

Design principle: thin, one job each, invariants inside, structured results the model can reason
over. Ambiguity is returned as data so the *model* decides to ask.

**inventory** — `list_products`, `get_stock`, `add_product`, `receive_stock`, `adjust_stock`,
`low_stock_report`

**billing** — `open_bill`, `add_bill_item`, `update_bill_item`, `remove_bill_item`, `get_bill`,
`find_bills`, `finalize_bill`, `void_bill`

`find_bills(customer?, date_range?, limit?)` exists because §3 asks for *"send me that bill as a
PDF"* verbatim, and `generate_invoice_pdf` takes a `bill_id`. Without a lookup, a reference one
turn stale — or "Ramesh's bill from yesterday" — has no path to an id, and a named deliverable
fails on an entirely plausible phrasing. Multiple matches return as candidates, so the model
asks which one.

**khata** — `get_khata_balance`, `charge_khata`, `settle_khata`, `khata_statement`

**analytics** — `daily_summary`, `sales_report`, `stock_health`

**documents** — `generate_invoice_pdf`, `generate_analysis_deck`

**preferences** — `get_preferences`, `set_preference`

### Product resolution

`"atta"` matches both Aashirvaad Atta 5kg and loose atta. The resolver returns:

```json
{ "status": "ambiguous", "candidates": [ {...}, {...} ] }
```

The tool supplies the candidates; **the model decides to ask which one**. That is the difference
between a clarifying question and a hardcoded branch, and it is the mechanism the brief is
testing for.

---

## 9. Skills

`.claude/skills/` holds the capability surface the model reads — the "how to run a store"
knowledge that does not belong in tool descriptions or the system prompt.

| Skill | Covers |
|---|---|
| `inventory` | Receiving stock, adding products, unit conventions, loose vs packaged, when to ask which brand |
| `billing` | Building a bill across turns, edits, finalize discipline, payment modes, when to confirm |
| `khata` | Credit conventions, settlement rules, the charge/settle asymmetry |
| `analytics` | What a daily close contains, how to read the numbers back conversationally |
| `documents` | When a PDF invoice is wanted vs an analysis deck |

---

## 10. Seeding

A new chat provisions a store and seeds it. Without seeding, "make this week's analysis deck"
produces an empty PPTX, and that is one of the two headline artifacts.

- Real SKUs from §2 (Aashirvaad Atta 5kg, Tata Salt 1kg, Amul Butter 100g, Fortune Sunflower Oil
  1L, Maggi 70g, Parle-G, Surf Excel) plus loose sugar, rice and dal, with correct HSN codes,
  GST slabs, cost prices, MRPs and opening stock.
- **~2 weeks of synthetic sales history, dated relative to provisioning time**, so the deck has
  real trends, real top items and real GST collected. Dates are generated from `now()` at
  provisioning, never hardcoded — otherwise "this week's analysis deck" is empty for anyone who
  messages the bot after the seed data's calendar window has passed.
- 2–3 khata customers, at least one carrying a balance, so "Ramesh's balance?" answers instantly.
- 1–2 SKUs at or below reorder level, so "what's running out?" returns something real.
- 1 SKU at deliberately low stock, so the oversell guard is easy to trigger on camera.
- Default shop name and GSTIN, so invoices are valid immediately and the preference demo has
  something to override.

**Commands:** `/start` welcome + provision, `/new` clear conversation only, `/reset` reseed this
store, `/help`.

---

## 11. Edge cases we are NOT handling

The brief explicitly rewards documenting these rather than papering over them.

- **Inter-state supply (IGST).** Intra-state only, so always CGST + SGST.
- **Returns and refunds.** No credit notes. `void_bill` reverses a whole bill; there is no
  partial return.
- **Expiry and batch tracking, FEFO.** Stock is a single quantity per SKU.
- **Purchase orders and supplier management.** `receive_stock` records the receipt, not the
  supplier relationship.
- **E-invoicing, IRN, e-way bills.** Out of scope for a store of this size.
- **Composition scheme dealers** and **cess on demerit goods**.
- **Split payments** across modes on one bill. One mode per bill.
- **Bill-level discounts.** Line-level price override only.
- **Multi-user roles** within a store. Anyone in the chat is the owner.
- **Agent behaviour tests.** Prompt behaviour is non-deterministic; we test the tool layer
  exhaustively and the model's orchestration manually. Called out honestly in the README.

---

## 12. Testing

| Layer | What | How |
|---|---|---|
| Unit | GST back-calculation from MRP, half-up rounding, CGST/SGST split incl. odd paise, unit conversion, round-off | Table-driven, exhaustive. Pure functions, no I/O. |
| Integration | Every §4 invariant | Real Postgres. Each test fails if its guard is removed. |
| Concurrency | Two bills finalized in parallel over the same low stock | Assert exactly one succeeds, the other refuses, stock never negative. |
| Idempotency | Same `update_id` replayed | Assert one bill, one decrement, identical response. |
| Artifacts | Generated PDF and PPTX | Assert valid file structure and that totals in the PDF match the DB. |

**Gate:** `pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test`

---

## 13. Build order — walking skeleton first

**Revised after review.** An earlier draft sequenced correctness first (schema → domain → tools →
integration) on the reasoning that if time ran out, what existed would be correct. That
optimises for the wrong risk. On a two-day integration-heavy build, the thing that kills you is
not GST rounding — which can be reasoned about at a desk — but the Agent SDK, Telegram or
Railway behaving differently than assumed. Those are discoverable only by running them end to
end. §14's skill-loading question is proof: a foundational assumption that could invalidate the
entire §9 layer, and no amount of desk work settles it.

| # | Milestone | Contains |
|---|---|---|
| **0** | **Walking skeleton** | Minimal schema (`stores`, `products`), one tool (`get_stock`), Agent SDK runtime with the allowlist on, Telegram adapter, **deployed to Railway**. A real message reaches Postgres and comes back. Also runs the three §14 verifications. |
| 1 | Foundation | Full schema + migrations, `domain/` with exhaustive unit tests, seed routine |
| 2 | Tool layer | All six tool families + an integration test per §4 invariant, concurrency and idempotency tests |
| 3 | Conversation | Remaining skills, system prompt, sessions, `/new` `/reset`, artifact delivery path |
| 4 | Artifacts | Invoice PDF, analysis deck |
| 5 | Ship | README, 4–5 min recording, final gate |

**Milestone 0 must land in the first few hours.** Everything after it is built behind a proven
pipe, and every milestone from that point is independently demoable — so if day two goes
sideways, there is always something recordable rather than a half-built agent.

---

## 14. Verify on day one, not day two

Three assumptions that are cheap to test now and expensive to discover late. All three belong to
Milestone 0.

### Skills vs. the disabled tool surface — highest risk
Agent Skills use progressive disclosure: the model pulls `SKILL.md` content on demand. **If that
path goes through the SDK's `Read` tool rather than harness-internal loading, disabling `Read`
makes the entire §9 skill layer inert** — and the brief calls the skill/tool surface "the heart
of what we grade."

Test exactly one trivial skill, with the allowlist on, before writing the other four. If it
turns out skills need `Read`, the fallbacks in preference order are: (a) allow `Read` scoped to
the skills directory only, if the SDK supports path scoping; (b) inline skill content into the
system prompt, losing progressive disclosure but keeping the capability surface. Decide after
measuring, not before.

### Railway replicas pinned to 1
Two instances long-polling one bot token produce 409 conflicts and dropped updates. This looks
fine until a rolling deploy briefly runs two containers. Pin replicas to 1 and use a
stop-before-start deploy strategy.

### Response latency at the chosen effort level
Adaptive thinking on `claude-opus-5` will make *"how much sugar is left?"* feel slow to someone
driving twenty messages through a demo, and that is a real demo-quality cost.

**The lever is `effort`, not thinking.** Disabling thinking on Opus 5 has two documented failure
modes — tool calls emitted as plain visible text where the call silently never runs, and
`<thinking>` tags leaking into replies. A silently-skipped tool call in a billing agent is far
worse than latency. `low` and `medium` are unusually strong on this model, so measure a simple
stock query at each and pick the lowest that still orchestrates multi-tool flows reliably.

---

## 15. Open questions

None blocking. Decided during implementation:

- Exact synthetic-history distribution (which SKUs sell how often). Data, not architecture.
- Invoice visual template. Correctness first, styling if time allows.
- Whether `void_bill` ships. Included in the plan, first thing cut if Milestone 4 is at risk.
- Final `effort` level, pending the Milestone 0 latency measurement (§14).
