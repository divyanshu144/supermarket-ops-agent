# Supermarket Ops Agent

A kirana store you run from a Telegram chat. Receive stock, cut bills, run customer credit,
close the day, and pull GST invoices and analysis decks — in plain terse English, no forms.

**Bot: [@divagentBot](https://t.me/divagentBot)** · try `/start`, then `how much sugar is left?`

> **Deployed on Railway**, one replica, long-polling. The container applies pending migrations
> on boot, so a freshly provisioned Postgres works without a manual step — the first deploy
> failed on `relation "processed_updates" does not exist` before that was added.
> Host-agnostic instructions for Railway, Fly.io and split Postgres/compute are in
> [`docs/DEPLOY.md`](docs/DEPLOY.md).

---

## Setup

```bash
pnpm install
cp .env.example .env          # add TELEGRAM_BOT_TOKEN and ANTHROPIC_API_KEY
pnpm db:up                    # Postgres 16 in Docker
pnpm db:migrate
pnpm dev
```

Verification gate: `pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test` — 203 tests.

Two scripts that hit the live API rather than mocks:

- `pnpm tsx src/agent/e2e.ts` — walks all thirteen beats of the brief's recording script
- `pnpm tsx src/agent/security.probe.ts` — tries to make the agent read `.env` and run a shell

---

## The harness, and why

**Claude Agent SDK (TypeScript).** The brief names it first, and it was the right call for one
reason: skills, tool schemas and sessions are first-class in it. The thing being graded here is
the capability surface, so I wanted that surface to be the SDK's own idiom rather than
scaffolding I invented around a raw loop.

The cost is that the SDK is a coding agent by default — it ships Bash, Read, Write, Edit, Glob,
Grep and web tools. Behind a public Telegram bot that is a shell anyone can reach. So the first
thing the runtime does is throw them all away (see Security below).

Model is `claude-opus-5` with adaptive thinking on. I did not route anything cheaper: this is a
billing system, and a tool call the model skips is worse than one that takes an extra second.

## How the control loop works

```
Telegram (long-poll)
   ↓  claim the update, resolve chat → store, read preferences
Agent SDK query()  ── system prompt + preferences + 5 skills + 27 tools
   ↓  observe → reason → call tool → read result → continue
in-process MCP tools (Zod schemas)
   ↓
domain/ (pure, integer-only)     db/ (transactions, row locks)
   ↓
reply, then any generated files, then mark the update done
```

One `query()` per message, resumed by session id so a bill can be built across turns. Tools push
generated files onto the turn context; the adapter drains it after the reply. The agent never
touches Telegram, which is what lets an invoice be generated in a test with no bot running.

## Skill and tool design

Five skills in `.claude/skills/` — inventory, billing, khata, analytics, documents. They teach
*how to run a shop*, not what a signature looks like; the schema already says that. The billing
skill spends most of its length on what each refusal means, because that is where the model
would otherwise improvise.

27 tools across six families. Two rules shape all of them:

**Refusals are data, never exceptions.** `finalize_bill` returns
`{status: 'insufficient_stock', shortfalls: [...]}`. "You only have 6 Maggi" is an answer, not a
crash, and the model has to relay it.

**Ambiguity is data too.** `get_stock('atta')` returns candidates rather than picking one. The
tool supplies the options; the *model* decides to ask. That is the difference between a
clarifying question and a hardcoded branch, and the brief is explicit that the question has to
come from the model.

---

## The hard parts

### Grounding
Every price, rate and quantity comes from a tool. Tools return *shaped* views, never raw rows —
partly because `JSON.stringify` throws outright on a BigInt (this broke every `get_stock` call in
production while the unit tests stayed green), and partly because cost price is the shop's margin
and has no business reaching a model that talks to customers.

### GST
**MRP is tax-inclusive**, so GST is back-calculated out of it, never added on top — adding it
would charge above the printed price, which is illegal. ₹62 at 12% is ₹55.36 taxable + ₹6.64 GST.

**Tax derives from the line total, not per-unit tax × quantity.** For 4 × ₹14 at 5% those differ:
5333 taxable vs 5332. Line-total-first is correct because the customer pays exactly ₹56.00, so
the taxable value must come out of that figure. There is a test asserting `5333` and explicitly
`not 5332`.

Money is integer paise, quantities are integer base units, GST rates are basis points. No float
touches any of them. CGST is `floor(gst/2)` and SGST takes the remainder, so odd paise always
land somewhere and the halves always sum to the whole.

### Oversell guard
Compare-and-set, never read-then-write:

```sql
UPDATE products SET quantity_base = quantity_base - $qty
WHERE id = $id AND store_id = $store AND quantity_base >= $qty
```

Zero rows returned *is* the refusal. A `CHECK (quantity_base >= 0)` constraint sits underneath as
a backstop, verified live in Postgres rather than merely declared in the ORM.

### Multi-turn bills
A bill is a draft until finalize. `add_bill_item` snapshots price, GST rate and HSN at add time,
so a bill built across five messages doesn't shift if someone edits the product mid-build. Stock
moves only at finalize.

Bill lines carry an explicit `line_no`. The primary key is a random UUID, so without it "which
line came first" is unanswerable — and two lines of one product at different prices would
collapse unpredictably on edit, making the same inputs produce ₹42 or ₹39 at random.

### Idempotency — three layers
1. **Transport.** `processed_updates` is a *claim*, not a completion marker. Under long-polling
   Telegram only redelivers when the offset didn't advance — exactly when the previous turn
   crashed. An insert-on-receipt dedupe would reject precisely the redelivery that must be
   reprocessed, and the owner's message would vanish silently.
2. **Tool.** Keys are `(update_id, tool, args_hash, ordinal)`, issued per turn by
   `IdempotencyIssuer` and injected server-side. The ordinal matters: without it two legitimately
   identical calls in one turn — a bill with two identical lines — would collide. Wired for
   `open_bill` only, since that is the path whose duplicate does real damage: the key is
   inserted into `idempotency_keys` first, with `onConflictDoNothing()`, and a losing insert
   (zero rows) means the key was already used, so the existing bill id is returned instead of a
   second draft being opened. The other mutating tools don't take a key and rely on layers 1 and
   3.
3. **Semantic.** Finalizing an already-finalized bill returns the existing invoice as a
   *success*. Not an error, and not a second decrement.

### Concurrency
Finalize takes `FOR NO KEY UPDATE` on the store row, then locks products in sorted id order
inside one transaction. `NO KEY` specifically so it doesn't conflict with the `FOR KEY SHARE`
that foreign-key inserts take on the same row.

Being precise about what this means: **the store gate serializes finalizes per store.** It is not
fine-grained row-level concurrency, and the compare-and-set and lock ordering beneath it are
defence in depth for if the gate is ever removed. Because they sit below the gate, the invariant
suite drives raw pool connections directly to test them — an earlier version of that suite passed
with the sort deleted and the CAS replaced, which is exactly the false confidence worth avoiding.

### Khata
Billing to credit is one transaction: stock decrement, invoice, ledger charge and balance update
together. Bill-then-charge as two transactions leaves a window where stock is gone and the
customer was never billed.

The two directions are deliberately asymmetric. **Charging** an unknown name opens the account —
a neighbour asks to put it on credit and the book gets a new page. **Settling** an unknown name
refuses, because money against a customer who doesn't exist is a mistake every time.

### Guardrails
- **Below cost** refuses, overridable once the owner confirms — their money to lose.
- **Above MRP** refuses with **no override**. MRP is the legal maximum; it isn't the owner's to
  give away. This was missing until review caught the asymmetry.
- **No delete anywhere.** Corrections are signed `stock_movements` rows; `void_bill` is a real
  reversal.

### Memory across sessions
Preferences live in Postgres and are injected into the system prompt each turn, so they apply
with no tool call. `/new` clears the conversation row and nothing else. In the end-to-end run,
beat 13 answers "UPI" after `/new` having called **no tools at all**.

### Real artifacts
`pdfmake` for the invoice: per-line HSN and CGST/SGST, a rate-wise tax summary grouped by slab,
explicit round-off, shop GSTIN. `pptxgenjs` for the deck with **native chart objects** — a test
asserts the zip contains `ppt/charts/chart` and *no* `ppt/media/image`, because a picture of a
chart would pass a looser check.

---

## Security

Two properties, both because a Telegram bot is an open input channel.

**`store_id` is never a tool parameter.** It travels through `AsyncLocalStorage` from the
verified chat. The model has no argument with which to address another shop, so no prompt can
talk it into one. Tenancy is enforced at the boundary, not hoped for in the prompt.

**The built-in tool surface is an allowlist.** `Skill` plus our 27, nothing else. `Read` is
denied — skills load through the `Skill` tool, which I verified empirically rather than assumed.
`security.probe.ts` asks the agent to read `.env`, run `ls -la`, list files and write a file: all
four refused, **zero tool calls**, no credential leaked.

---

## Engineering standards

Followed: TDD on everything below the agent; one-way dependencies (`domain/` knows nothing about
the DB, `agent/` nothing about Telegram); integer-only money; every §4 invariant has a test that
fails if its guard is removed — verified by mutation, not assumed.

Skipped, deliberately: no CI pipeline; no structured logging or tracing (`console.error` with
ids); no auth beyond Telegram's own chat identity; no rate limiting.

## Edge cases not handled

Called out rather than papered over:

- **Inter-state supply (IGST).** Intra-state only, so always CGST + SGST.
- **Returns and credit notes.** `void_bill` reverses a whole bill; no partial returns.
- **Expiry, batch tracking, FEFO.** One quantity per SKU.
- **E-invoicing, IRN, e-way bills.** Out of scope at this size.
- **Composition scheme, cess on demerit goods.**
- **Split payments** across modes on one bill.
- **Bill-level discounts.** Line-level price override only.
- **Multi-user roles.** Anyone in the chat is the owner.
- **Idempotency under a diverging replay.** If a crashed turn is reprocessed and the model
  produces a *structurally different* sequence of calls, the ordinal can misalign. Keying
  `open_bill` closes the worst path (two bills, two decrements). Fully solving it needs a durable
  per-turn execution log.
- **Agent behaviour is not automatically tested.** The tool layer is exhaustive; the model's
  orchestration is covered by `e2e.ts`, which is a live script, not a CI gate.

## How I used AI tools

Claude Code wrote most of this, and the interesting part is where it was wrong.

I ran a design spec through review before any code. That review caught three things I'd have
shipped: no khata payment mode on `finalize_bill` (so bill-then-charge would have been two
transactions with a crash window), no way to resolve "that bill" into an id, and — the sharp one
— that my Telegram dedupe was inverted. Under long-polling, redelivery only happens when the
turn crashed, so insert-on-receipt would drop exactly the messages that needed reprocessing.

The same review argued the build order was backwards: I'd sequenced correctness first, and the
real risk on an integration-heavy build is the SDK behaving unexpectedly. Reordering to a
deployed walking skeleton first immediately surfaced two bugs a green test suite was hiding —
`JSON.stringify` throwing on BigInt, and `settingSources: []` silently disabling every skill.

Later, a review of my *own* concurrency tests found them largely vacuous: the store gate meant
two finalizes never overlap, so the deadlock test couldn't deadlock. My first replacement was
vacuous too — I only caught it by deleting the sort and watching the test still pass. The lesson
I'd keep: **a passing concurrency test proves nothing until you mutate the guard and watch it
fail.**

## What I'd do differently with more time

- **Chase the latency.** `ToolSearch` fires before every store tool despite the set being small;
  it's the prime suspect for the ~10s floor, and I'd measure that before touching `effort`.
- **A durable per-turn execution log**, closing the idempotency residual properly.
- **Reorder suggestions from sales velocity.** `stock_movements` already holds the data.
- **Hindi/Hinglish.** Real kirana owners code-switch constantly and the agent currently doesn't.
- **Golden-transcript tests** for agent behaviour, so orchestration regressions fail in CI rather
  than in a demo.
