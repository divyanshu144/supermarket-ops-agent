# Improvements Design — Correctness Gaps, Voice, Hindi, Latency, Observability

**Date:** 2026-08-01
**Status:** Approved
**Predecessor:** `2026-07-29-supermarket-ops-agent-design.md` (built, deployed, verified)
**Revised after review** — see "What review changed" at the end.

**Context:** The agent is live on Railway as `@divagentBot`, 203 tests green, all thirteen
end-to-end beats verified in production. The original 2-day deadline turned out to be a week —
the assignment was issued 2026-07-29 and is due around 2026-08-05, leaving roughly four days.
Every scope cut in the original spec, including dropping all of §7, was driven by that wrong
deadline.

**Risk posture: push it** — but review found that the highest-return work is not new features.
Three things already claimed as working are not: the brief's own clarifying-question example has
no data to fire on, the bot stops itself on any unhandled error, and one of the three advertised
idempotency layers was never wired. Those come first.

---

## The one rule

**The §4 invariant suite must pass unchanged after every package.** Oversell and GST correctness
are what the brief actually grades. Nothing here is worth breaking them, and any change that
requires editing an invariant test is a change that needs re-justifying first.

---

## Package 0 — The atta row

**15 minutes. Highest return in this document. Do first.**

`src/seed/catalogue.ts` contains exactly one atta: `Aashirvaad Atta 5kg`. So `findStock('atta')`
returns `{status: 'found'}` and **never `ambiguous`** — nothing in the catalogue produces an
ambiguous match at all.

This matters because that exact example is load-bearing everywhere:

- The brief, §3, verbatim: *"add atta → 'Which one — Aashirvaad 5kg or loose?'"*
- The original spec §8, as the worked example of ambiguity-as-data
- `README.md:80`: "`get_stock('atta')` returns candidates rather than picking one"
- `src/agent/e2e.ts:58` sidesteps it by saying "aashirvaad atta"

Fix: add a loose atta SKU to the catalogue (loose wheat flour, 0% GST, sold by kg — consistent
with the other loose staples). The clarifying-question mechanism, which is graded and which the
model already implements correctly, becomes demonstrable on camera.

Zero risk: seed data only, no schema change, no code path touched.

---

## Package A — Error handling, token redaction, turn logging

**Three problems in the same thirty lines of `src/telegram/bot.ts`.**

### A1. The bot stops itself — availability

There is **no `bot.catch` anywhere**. grammY's default handler logs the error, calls
`await this.stop()`, and rethrows. `/start`, `/new` and `/reset` have no try/catch
(`bot.ts:31-53`), so a single DB blip inside `provisionStore` during the review window takes the
bot down and the reviewer messages a dead bot.

Fix: install `bot.catch`, and wrap the command handlers so a failure replies with an error rather
than propagating.

### A2. The token leaks — security

The leak is not through our `console.error` (`bot.ts:86` logs a bare error with no `ctx`). It is
through **grammY's own handler and the rethrow**: `BotError` holds `ctx` as an own enumerable
property, `ctx.api` holds `this.token`, and Node's unhandled-rejection printer `util.inspect`s
the chain. **The bot token is in Railway's log retention now.**

Fix: a redacting serialiser used by our `bot.catch` handler. It must strip the `token` property,
values matching the bot-token and `sk-ant-`/`sk-` shapes, **and tokens embedded in URLs** —
Telegram's file-download endpoint is `https://api.telegram.org/file/bot<TOKEN>/…`, so Package D
would otherwise reintroduce the leak through a different path.

Installing `bot.catch` (A1) is what makes the redactor reachable at all. A redactor without it
changes nothing.

### A3. Nothing is logged — observability

The app logs only errors. When the user reported testing, the session had to be reconstructed
from database state, which showed what the agent *did* but never what it *said*, which tools it
chose, or why a turn took 21 seconds.

Fix: one structured JSON line per turn to stdout (Railway indexes it):

```
{ ts, update_id, store_id, tools: [...], duration_ms, outcome: 'ok'|'error', error? }
```

**Message text is not in that line.** It goes behind a flag defaulting **off** in production and
on in development. This is a better answer than "we log customer names but you can turn it off",
and it costs nothing — what was actually needed for debugging was tool choice and duration, not
the text. The README says so in one sentence.

**Not doing:** OpenTelemetry. Overkill for one shop in one process.

---

## Package B — Latency

**One line. Not a tool-consolidation project.**

Current: 5–21s per turn, median ~9s. `ToolSearch` fires before nearly every store tool.

The SDK exposes the lever directly — `sdk.d.ts:495-502`, on the MCP server config:

> `alwaysLoad?: boolean` — *"When true, all tools from this server are always included in the
> prompt and never deferred behind tool search. Equivalent to `defer_loading: false` on the API.
> Default: tools are deferred when tool search is enabled."*

Set `alwaysLoad: true` in `createSdkMcpServer` (`src/tools/index.ts:30-34`), measure before and
after, report the number. The only documented side effect is that startup blocks until the server
connects, capped at 5s — nothing for an in-process server.

If that does not move latency, the next lever is `effort` (`src/config/env.ts:7`, currently
`medium`), which the original spec §14 identified.

**Tool consolidation is explicitly not in scope.** The brief calls the tool surface "the heart of
what we grade", and the skills reference tools by name (`analytics/SKILL.md:10,21`) with no test
tying skill text to registered tool names — so consolidation would silently rot the skill layer
for no measured gain.

---

## Package C — Hindi / Hinglish

**Skill only. No migration, no schema change, no resolver change.**

Real kirana owners code-switch constantly: *"do kilo cheeni aur ek Aashirvaad atta, Ramesh ke
khaate mein"*. English-only voice would be a feature with no user.

### Why there is no alias column

The earlier draft proposed an `aliases text[]` column covering ten staples. **Partial coverage is
worse than none.** Aliases teach the model that Hindi query strings are valid tool input; it then
calls `findStock('makhan')` on a product with no alias, gets `not_found`, and says "no such
product". English-only at least forces it to translate every time. `add_product`
(`src/tools/inventory.ts:123-158`) has no alias parameter either, so anything created on camera
would have no Hindi handle at all.

Worse, `findStock` (`src/repositories/products.ts:32-58`) is the single funnel for
`addBillItem`, `updateBillItem`, `removeBillItem`, `receiveStock` and `adjustStock`. Broadening
its WHERE clause turns `found` into `ambiguous` for cases that currently work in one shot, and
every caller then asks a question instead of doing the thing. That is a logic change to the
resolver every mutation runs through — not the "data plus prompt" the earlier draft claimed.

### What we do instead

A `hindi` skill carrying this shop's vocabulary as a glossary — cheeni/chini/shakkar → sugar,
chawal → rice, daal/toor/arhar → toor dal, namak → salt, tel → oil, atta/gehun → atta,
makkhan → butter, biskut → biscuits, sabun/surf → detergent, noodles → Maggi — plus the register
rules: reply in whatever language and script the owner used, stay terse, keep numbers and money in
digits ("₹485", not "chaar sau pachaasi"), and trust the tool's resolution over your own guess.

Translation stays in the model, which is what the brief rewards, and the work lands in the skill
surface being graded rather than in a lookup table.

---

## Package D — Voice input

**Voice only. Photo is a swing item — see "After packaging".**

```
voice note → download → transcribe() → text → existing agent path
```

`transcribe(audio: Buffer, mimeType: string): Promise<string>` is the entire provider surface.
OpenAI Whisper behind it (the user already has a key); swapping providers is one file, and the
agent layer never learns which one is there. Telegram voice notes are OGG/Opus, which Whisper
accepts directly — no transcoding.

Voice converges into the existing `text: string` path, so `runAgent` does not change.

**The bot echoes what it heard, then proceeds** — *"Heard: do kilo cheeni, Ramesh ke khaate
mein"*. Not decoration: a misheard **quantity** is the dangerous failure. "Do" (2) and "das" (10)
differ by one phoneme, and silently billing 10kg on a transcription slip is what destroys trust
in a billing system. It **must not gate** — echo and continue in the same turn, never wait for
confirmation.

Guards: reject on `voice.duration` and `voice.file_size` **from the update, before downloading**
— Telegram's `getFile` caps at 20 MB and a 60s Opus note is ~1 MB, so the real guard is duration.
Clear message, not a stack trace.

**Shared handler body.** The turn body at `bot.ts:55-90` — claim → provision → typing → agent →
reply → drain artifacts → complete — must be extracted and shared, not duplicated, because it
carries the verified dedupe and artifact paths. Extraction is behaviour-preserving and the
existing tests are the guard.

**No transcript cache.** The earlier draft proposed caching transcripts against `update_id`.
`claimUpdate` already makes re-transcription impossible except under a stale reclaim, and there
is no store to cache into. Dropped.

---

## Package E — Abandoned drafts

**30 minutes. Half of it already exists.**

The oversell attempt left a draft that will sit forever. Harmless — drafts hold no stock — but
`find_bills` keeps surfacing them.

Add an age filter so `find_bills` ignores drafts older than 24h. `/reset` already deletes every
bill (`src/seed/index.ts:138-143`), so that half is done. No background job.

---

## Package F — Reorder suggestions from sales velocity

**New. Brief §7 item 3. Two hours, zero invariant risk.**

`stock_movements` already holds the data — README:248 notes this as future work. One tool that
reads outbound movements over a window, computes units/day per product, and reports days-of-cover
against current stock, so the owner can ask *"what should I order?"* and get a ranked answer
rather than a flat below-reorder-point list.

Pure read. Touches no invariant. Adds to the tool surface the brief calls the heart of grading —
strictly better return than photo.

---

## Package G — Idempotency layer 2: wire it or correct the claim

`README.md:128-137` presents three idempotency layers as shipped, answering a §4 hard part. Layer
2 is not wired: `idempotencyKeys` appears only in `src/db/schema.ts:213` and its schema test, no
tool accepts a key, and `IdempotencyIssuer.next()` is called only from `src/tools/context.test.ts`.
`openBill` (`bills.ts:285-296`) is a plain insert, contradicting original spec §7 ("`open_bill` is
likewise idempotency-keyed").

Under a stale reclaim, a reprocessed turn opens a second draft.

**Preferred:** wire it for the mutating tools, starting with `open_bill` — that closes the worst
path and makes the README true. **Fallback if time runs short:** correct the README to describe
two layers and list the third under edge cases not handled. What is not acceptable is leaving a
headline claim that a reviewer disproves with one grep.

---

## Sequence

| # | Package | Est. | Rationale for position |
|---|---|---|---|
| 0 | Loose atta seed row | 15 min | Makes a graded, already-claimed mechanism demonstrable |
| A | `bot.catch` + redactor + turn log | 3 h | Availability bug during the review window; unlocks debugging for everything after |
| B | `alwaysLoad` + measure | 1 h | One line; do it before voice adds a hop |
| C | `hindi` skill | 2 h | Voice is far less interesting without it |
| D | Voice input | 3 h | Lands on a system already fast and already multilingual |
| E | Draft age filter | 30 min | Small |
| F | Reorder from velocity | 2 h | Best §7 return per hour |
| G | Idempotency layer 2 | 1 h | Either wire it or stop claiming it |
| — | **Packaging (reserved)** | **1 day** | README to ~1 page, repo hygiene, 4–5 min recording. §6 deliverables, not leftovers |

### After packaging, if time remains

**Photo input.** Shares only the download helper with voice — maybe twenty lines. After that it
diverges: `runAgent` takes `text: string` and passes `prompt: input.text`
(`src/agent/runtime.ts:39-48`), while an image needs a content block, which needs
`prompt: AsyncIterable<SDKUserMessage>` — a different call mode with unverified interaction with
`resume: input.sessionId`. That is a mode switch on the path all thirteen verified beats run
through. If attempted, verify the mode switch empirically in the first hour, exactly as original
spec §14 treated skill loading, before building anything on top of it.

### Cut

**FEFO.** Correctly analysed, correctly ranked last, and still wrong to carry: a package
preconditioned on "everything else green" with four days left never starts, and planning
attention spent on it now is spent for nothing. Its analysis — `quantity_base` stops being the
truth and becomes a sum over batches, the atomic CAS becomes an ordered walk, per-batch cost
changes the below-cost guard, and `voidBill`'s single-row restore breaks too — moves to the
README's "what I'd do differently with more time", where it demonstrates understanding at no
risk. It is already listed under edge cases not handled (README:209).

---

## Testing

- **0** — a test asserting `findStock('atta')` returns `ambiguous` with both candidates. This is
  the test that would have caught the gap.
- **A** — redaction unit-tested against a synthetic `BotError` carrying a token-shaped string,
  a `token` property, and a token embedded in a URL. A handler test asserting a thrown error
  replies rather than stopping the bot.
- **B** — measured before and after; §4 suite and tool-registration tests are the guard.
- **C** — skill content only; covered by the live run, not unit tests.
- **D** — `transcribe()` mocked for unit tests; duration/size guards tested at the boundary;
  one live script for the real path, like `e2e.ts`. The extracted turn body is covered by the
  existing dedupe and artifact tests, which must pass unchanged.
- **E** — a draft older than the cutoff is excluded from `find_bills`.
- **F** — velocity arithmetic unit-tested on fixed movement rows, including a product with no
  sales (no division by zero) and a window with no data.
- **G** — replaying the same `open_bill` key returns the existing bill rather than opening a
  second.

## Out of scope

- OpenTelemetry or a vendor observability stack
- Tool consolidation
- Scheduled/auto-sent decks (needs a scheduler; low demo value)
- Barcode scanning
- Languages beyond Hindi/Hinglish
- Multi-store or multi-user roles
- FEFO and batch tracking

---

## What review changed

Recorded because the reasoning matters more than the conclusions.

1. **Package B was a project; it is a config flag.** The premise ("SDK defers above a tool-count
   threshold") was right and the remedy was wrong. `alwaysLoad` removes the ToolSearch hop
   without touching a tool. The "what if it's a null result" worry dissolves with it.
2. **Package A was aimed at the wrong log site** and missed that no `bot.catch` exists — so the
   redactor alone would have fixed nothing, and a live availability bug sat unnoticed beside it.
3. **The atta example has no data to fire on.** Claimed in the brief, the spec and the README;
   `e2e.ts` sidesteps it. Not in the earlier draft at all.
4. **The alias column was the worst of both.** Partial coverage actively teaches the wrong
   behaviour, and it changes the resolver every mutation runs through.
5. **Voice and photo do not share enough** to be "one generic media path". Voice is trivial;
   photo changes the agent's entry signature.
6. **Packaging was not in the spec** while the README stood at ~5 pages against a "~1 page"
   instruction. It now has a reserved day.
7. **FEFO cut rather than gated**, and **reorder-from-velocity added** — better §7 return per
   hour, and no invariant risk.
