# Design notes

The full reasoning behind the README. Everything from "The harness, and why" down to "What I'd do
differently" is the original README text, moved here unchanged except for one corrected sentence
under Engineering standards. "Access and spend" and "Restarts and conversation storage" at the end
are new and describe work done after that text was written.

Contents: [harness](#the-harness-and-why) · [control loop](#how-the-control-loop-works) ·
[skills and tools](#skill-and-tool-design) · [hard parts](#the-hard-parts) ·
[security](#security) · [engineering standards](#engineering-standards) ·
[edge cases](#edge-cases-not-handled) · [AI tools](#how-i-used-ai-tools) ·
[with more time](#what-id-do-differently-with-more-time) · [access and spend](#access-and-spend) ·
[restarts](#restarts-and-conversation-storage)

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
Agent SDK query()  ── system prompt + preferences + 6 skills + 25 tools
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

Six skills in `.claude/skills/` — inventory, billing, khata, analytics, documents, hindi. They
teach *how to run a shop*, not what a signature looks like; the schema already says that. The
billing skill spends most of its length on what each refusal means, because that is where the
model would otherwise improvise.

The Hindi skill is a glossary and a register, not a lookup table. I considered an `aliases`
column on `products` and rejected it: partial coverage is worse than none, because it teaches the
model that Hindi strings are valid tool input and then fails on the words that have no alias.
Translation stays in the model; the tool still grounds the price.

25 tools across six families. Two rules shape all of them:

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
   identical calls in one turn — a bill with two identical lines — would collide. The key goes
   into `idempotency_keys` **first**, with `onConflictDoNothing()`; a losing insert (zero rows)
   means the key was already used, so the stored result is replayed instead of the write
   happening twice. Insert-first is the point — checking then writing leaves a window.

   Wired for `open_bill` **and** `add_bill_item`. That pairing is not optional, and finding out
   why was the most instructive bug on this branch. I keyed `open_bill` alone first. A crashed
   turn that replays then gets *the same draft back, already holding its lines*, and the model —
   which only sees `{status:'opened', bill_id}` — adds them again. Finalize decrements stock
   twice and charges twice. Unkeyed, that same replay had opened a fresh draft and billed
   correctly, leaving a stray empty one behind. **Half-applied idempotency was worse than none**:
   it turned a cosmetic residue into a wrong bill. The other mutating tools rely on layers 1 and 3.
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

### Voice, and Hindi
A voice note is downloaded, transcribed through Whisper, and fed into the same turn path text
uses — `handleTurn` is shared, so the update claim and the artifact drain can't drift between
modalities. The provider surface is one function, `transcribe(audio, mimeType, key)`.

**The bot echoes what it heard, then acts** — it does not wait for confirmation. In Hindi "do"
(2) and "das" (10) differ by one phoneme, and a billing system that silently acts on a misheard
quantity is worse than one that's slightly chattier. The transcript is visible in the same turn
the money moves.

The update is claimed *before* the download, not inside `handleTurn` as the text path does.
Otherwise a redelivery pays for a second transcription and sends a duplicate echo before dedupe
ever runs. `handleTurn` takes `{ alreadyClaimed: true }` so it doesn't then reject its own claim.

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

**The built-in tool surface is an allowlist.** `Skill` plus our 25, nothing else. `Read` is
denied — skills load through the `Skill` tool, which I verified empirically rather than assumed.
`security.probe.ts` asks the agent to read `.env`, run `ls -la`, list files and write a file: all
four refused, **zero tool calls**, no credential leaked.

---

## Engineering standards

Followed: TDD on everything below the agent; one-way dependencies (`domain/` knows nothing about
the DB, `agent/` nothing about Telegram); integer-only money; every §4 invariant has a test that
fails if its guard is removed — verified by mutation, not assumed.

Logging is one structured JSON line per turn — update id, store id, tools called, duration,
outcome. **Message text is off by default in production** and on in development, because inbound
text carries customer names and amounts; what debugging actually needed was tool choice and
timing. Errors go through a redactor first: grammY's `BotError` holds `ctx.api.token`, so an
unredacted error dump puts the bot token in log retention. It also strips tokens embedded in
URLs, which is the shape of Telegram's own file-download endpoint.

CI runs the same gate on every push — fmt, lint, typecheck and the full suite against a real
Postgres service container, because row locks, `CHECK` constraints and `ON CONFLICT` are the
things under test and none of them exist in a mock. No API key is needed: the tool layer is
exercised directly, so nothing in the suite calls a model.

Tests run with `fileParallelism: false`. The invariant suite installs a real DDL trigger on
`khata_entries` to prove the khata write is inside the finalize transaction, and while it exists
any parallel file inserting there fails. It was red about one run in five before I serialised it.

Skipped, deliberately: no tracing; no deploy automation (a deploy is a manual `railway up`, see
[`DEPLOY.md`](DEPLOY.md)). Access and spend limits were added later; see "Access and spend" below.

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
- **Idempotency under a diverging replay.** Keys are ordinal-based, so they only line up if the
  replayed turn makes the *same* sequence of calls. If the model reasons differently the second
  time, the ordinals shift and later calls miss their keys. Keying `open_bill` and
  `add_bill_item` together closes the realistic path; fully solving it needs a durable per-turn
  execution log, which is the honest fix I didn't build.
- **Voided sales still count toward reorder velocity.** `reorder_suggestions` reads `kind='sale'`
  and ignores `'reversal'`, so a voided bill briefly inflates the reorder signal.
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

The pattern repeated on this branch. Reviewing my own work, I "fixed" idempotency by keying
`open_bill` — and a reviewer showed the fix made a crash-replay produce a *doubled* bill, where
before it had only left a stray draft. I'd optimised the thing I was looking at and made the
system worse. Three separate tests I wrote also turned out to assert nothing: each would have
passed against the exact wrong implementation it named. Same failure as the concurrency suite,
one project later.

**Latency.** `ToolSearch` was firing before nearly every tool call — the SDK defers MCP tools
behind it by default. `alwaysLoad: true` on the server removed the hop: **10 of 13 end-to-end
beats invoked ToolSearch, then 0 of 13**, median turn 9064ms → 7175ms, total −15.5%. One line,
measured before and after rather than assumed, and no tool consolidated.

**Grounding is a prompt bug, not a model bug.** The agent kept answering "what's Ramesh's
balance?" from conversation memory — the *right* number, never read from the database. My prompt
said "never state a **price or a quantity** you have not read from a tool". A khata balance is
neither. The rule enumerated categories and missed the one that mattered. It's categorical now,
and it explicitly closes the "I already said it earlier" loophole.

## What I'd do differently with more time

- **A durable per-turn execution log**, closing the idempotency residual properly.
- **Golden-transcript tests** for agent behaviour, so orchestration regressions fail in CI rather
  than in a demo. `e2e.ts` is a live script I run by hand.
- **Expiry and FEFO.** Genuinely useful for dairy and bread, and deliberately cut: it makes
  `quantity_base` a derived sum over batches, turns the single-row compare-and-set into an
  ordered walk, and changes the below-cost guard — the three things already verified in
  production, for a payoff invisible in a demo.
- **Photo input.** Voice and photo share only the download; photo needs a different SDK call mode
  (`AsyncIterable<SDKUserMessage>`) whose interaction with session resume I haven't verified.

---

## Access and spend

The bot is invite-only. A chat can use it only if it already owns a store, and the only way to get
one is `/start <code>`. Codes are single-use, shown once and stored hashed; the operator manages
them with `pnpm invite create|list|revoke`. The access gate uses grammY's own command matcher: a
first version parsed the text itself, and `/start@otherbot hi` slipped past it into a handler that
created a store. The handler now also refuses to create one, so redeeming a code is the only way a
store comes into existence.

Spend is bounded at four levels, all configurable through the environment: turns, budget and time
per run; a daily budget per store (counted in IST days); a per-chat rate limit; and Whisper cost
recorded against the same daily budget. A run that times out is charged the per-run cap, because
its real cost is unknown and over-counting is the safe direction. `/reset` only explains itself;
`/reset confirm` does it.

If a resumed run fails before emitting any output and the SDK provides no usage result, I charge
that failed attempt the full per-run cap. The runtime retries once without the old session. If
that fresh attempt succeeds and reports usage, its charge is added to the conservative charge
for the failed resume, so a broken transcript cannot erase unknown model spend from the daily
total. If the retry also fails without a usage result, `AgentRunFailure` preserves both attempts
and carries the sum of their per-run caps in `conservativelyChargedTurnCostUsd`. When the SDK did
report usage for an attempt, I charge the reported per-run amount instead. Runtime tests check
the unknown-resume-cost plus successful-retry case, and a Telegram turn test checks that the
conservative total is persisted when both attempts fail.

## Restarts and conversation storage

Conversations are mirrored into Postgres through the Agent SDK's `sessionStore`, so a redeploy no
longer wipes them. A stored session the database has no transcript for is dropped to a fresh one
rather than failing, and a resume that fails to start before any output is retried once without
`resume`.

Shutdown is deliberately not `bot.stop()`. In grammY that call confirms the update being handled,
so a turn cut off by the exit would be lost. Instead the bot stops taking new updates, lets the
in-flight turn finish for up to `SHUTDOWN_GRACE_MS`, and exits; whatever was not confirmed is
redelivered. At boot, orphaned update claims are expired so a redelivered update is reclaimed, and
a Postgres advisory lock makes a new instance wait for the old one so two containers cannot both
work on the same message. Polling stays sequential on purpose: grammY's runner confirms offsets
early and can lose updates when killed. The cost is that one slow turn delays other shops.

What is verified and what is not is tracked in `HANDOFF.md`; the deployment side is in
[`DEPLOY.md`](DEPLOY.md).
