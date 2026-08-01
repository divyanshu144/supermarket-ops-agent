# Improvements Design — Voice, Hindi, Latency, Observability

**Date:** 2026-08-01
**Status:** Awaiting approval
**Predecessor:** `2026-07-29-supermarket-ops-agent-design.md` (built, deployed, verified)

**Context:** The agent is live on Railway as `@divagentBot`, 203 tests green, all thirteen
end-to-end beats verified in production. The original 2-day deadline turned out to be a week —
the assignment was issued 2026-07-29 and is due around 2026-08-05, leaving roughly four days.
Every scope cut in the original spec, including dropping all of §7, was driven by that wrong
deadline.

**Risk posture: push it.** The user has chosen to accept risk to a working, verified system in
exchange for upside.

---

## The one rule

**The §4 invariant suite must pass unchanged after every package.** Oversell and GST correctness
are what the brief actually grades. Nothing here is worth breaking them, and any change that
requires editing an invariant test is a change that needs re-justifying first.

---

## Package A — Token redaction and turn logging

**Risk: none. Purely additive. Do first.**

### The security bug

grammY's `BotError` serialises the whole context including `ctx.api.token`, and our
`console.error` dumps it. **The bot token is currently sitting in Railway's log retention** —
observed directly during deployment. Anyone with log read access has full control of the bot.

Fix: a redacting serialiser applied before any error is logged. Strips `token`, and any value
matching the bot-token or `sk-ant-`/`sk-` shapes, replacing with `[redacted]`.

### The observability gap

The app logs only errors. When the user reported testing, the entire session had to be
reconstructed from database state — which showed what the agent *did* but never what it *said*,
which tools it chose, or why a turn took 21 seconds.

Fix: one structured JSON line per turn to stdout (Railway indexes it):

```
{ ts, update_id, store_id, direction: 'in'|'out', text, tools: [...],
  duration_ms, outcome: 'ok'|'error', error? }
```

Inbound text and replies contain customer names and amounts. That is real personal data, so:
log it at a level that can be disabled by env var, and say so in the README rather than
pretending the question does not exist.

**Not doing:** OpenTelemetry. Overkill for one shop in one process.

---

## Package B — Latency

**Risk: medium — touches the tool surface everything depends on.**

Current: 5–21s per turn, median ~9s. `ToolSearch` fires before nearly every store tool despite
the set being small.

**Investigate before changing.** The hypothesis is that the SDK auto-enables tool search above a
tool-count threshold and 27 tools crosses it. If confirmed, the lever is consolidating the
surface — several tools are thin variations that could merge (`sales_report` and `daily_summary`
overlap; `get_preferences` is nearly redundant with prompt injection).

**If measurement shows `ToolSearch` is not the cause, report that and stop.** Do not consolidate
tools to fit a theory the data does not support — a smaller tool surface is not automatically
better, and the brief grades the tool surface directly.

Guard: the §4 suite plus the tool-registration tests. Consolidation that changes behaviour fails
them.

---

## Package C — Hindi / Hinglish

**Risk: low. Data plus prompt, no logic change.**

Real kirana owners code-switch constantly: *"do kilo cheeni aur ek Aashirvaad atta, Ramesh ke
khaate mein"*. English-only voice would be a feature with no user.

### Where translation happens — decided

**Primarily in the model, with a narrow alias safety net.** The brief warns that a keyword router
doing the real work is an automatic fail; a hardcoded Hindi→English lookup table is that
antipattern in a different hat. The model translates the *query*; the tool still grounds the
*price and stock*, so grounding is not weakened.

The safety net: an `aliases text[]` column on `products`, populated only for staples where a
shopkeeper has several words for one thing.

| Product | Aliases |
|---|---|
| Sugar (loose) | cheeni, chini, shakkar |
| Rice (loose) | chawal, chaawal |
| Toor Dal (loose) | dal, daal, toor, arhar |
| Tata Salt | namak |
| Fortune Sunflower Oil | tel, oil |
| Aashirvaad Atta | atta, aata, gehun |
| Amul Butter | makkhan, butter |
| Parle-G | biscuit, biskut |
| Surf Excel | detergent, sabun, surf |
| Maggi | noodles |

`findStock` matches name, brand **or** alias. Note "atta" deliberately stays ambiguous across the
branded and loose SKUs — that is the clarifying-question path working, not a bug.

### Replying in kind

A `hindi` skill: reply in whatever language and script the owner used, keep the terse register,
and trust the tool's resolution over the model's own guess. Numbers and money stay in digits —
"₹485" not "chaar sau pachaasi".

---

## Package D — Media input: voice and photo

**Risk: medium. New code path into the agent.**

Both modalities are the same shape — *Telegram sends a file → fetch it → get it to the model* —
so this is **one generic media path with two thin branches**, not two features. Voice needs a
transcription hop; photo does not, because the model has native vision.

### Voice

```
voice note → download → transcribe() → text → existing agent path
```

`transcribe(audio: Buffer, mimeType: string): Promise<string>` is the entire provider surface.
OpenAI Whisper behind it (the user already has a key); swapping providers is one file, and the
agent layer never learns which one is there.

Telegram voice notes are OGG/Opus, which Whisper accepts directly. No transcoding.

**The bot echoes what it heard before acting:** *"Heard: do kilo cheeni, Ramesh ke khaate mein"*.
This is not decoration. A misheard **quantity** is the dangerous failure — "do" (2) and "das"
(10) differ by one phoneme, and silently billing 10kg because of a transcription slip is exactly
what destroys trust in a billing system. Showing the transcript makes the error visible before
money moves.

Guards: reject over ~60s or over the size cap, with a clear message rather than a stack trace.

### Photo

Same path, minus transcription: fetch the file, base64 it into the message content, let the
model's vision identify the product, then resolve it through `get_stock` exactly as if the owner
had typed the name. Grounding is unchanged — vision supplies a *guess at the name*, the tool
supplies the price.

If the model cannot identify it confidently, it asks. Same ambiguity path as everything else.

### Idempotency

Media messages carry an `update_id` like any other, so transport dedupe is unchanged. Worth
stating because transcription is the expensive step: a reprocessed voice note should not
re-transcribe. Cache the transcript against the `update_id`.

---

## Package E — Abandoned drafts

**Risk: low.**

The user's oversell attempt left a draft that will sit forever; nothing expires them. Harmless —
drafts hold no stock — but unbounded, and `find_bills` keeps surfacing them.

Add an age filter so `find_bills` ignores drafts older than 24h, and have `/reset` clear them.
No background job; not worth the machinery.

---

## Package F — Expiry / FEFO

**Conditional. Only if A–E are complete and green.**

First Expired, First Out: deduct from the batch expiring soonest. Genuinely useful for a shop
selling dairy and bread, and it enables *"what's expiring this week?"*.

**Why it is last and conditional:** it changes the fundamental stock model.
`products.quantity_base` stops being the truth and becomes a sum over `product_batches`. The
oversell compare-and-set stops being one atomic `UPDATE` and becomes an ordered walk across
batches. Cost price varies per batch, so the below-cost guard changes too.

That touches the oversell guard, the finalize transaction, and the invariant suite — the three
things already verified in production, for a payoff invisible in a demo.

**Precondition:** every other package green, §4 suite passing, and a fresh end-to-end run.

---

## Sequence

| # | Package | Risk | Rationale for position |
|---|---|---|---|
| A | Token redaction + logging | none | Fixes a live security bug; gives visibility for debugging everything after it |
| B | Latency | medium | Before voice, not after — transcription adds a hop, so fixing the floor first means voice lands on a fast system |
| C | Hindi/Hinglish | low | Voice is far less interesting without it |
| D | Media (voice + photo) | medium | Lands on a system already fast and already multilingual |
| E | Abandoned drafts | low | Small, do whenever |
| F | FEFO | high | Only if A–E green |

## Testing

- **A** — redaction unit-tested against a synthetic error carrying a token-shaped string
- **B** — measured before and after; §4 suite and tool-registration tests are the guard
- **C** — alias resolution tested per staple; ambiguity preserved for "atta"
- **D** — `transcribe()` mocked for unit tests; one live script for the real path, like `e2e.ts`.
  Media dedupe tested by replaying an `update_id`
- **E** — draft older than the cutoff is excluded from `find_bills`
- **F** — the entire existing §4 suite must pass unchanged, plus new batch-ordering tests

## Out of scope

- OpenTelemetry or a vendor observability stack
- Scheduled/auto-sent decks (needs a scheduler; low demo value)
- Barcode scanning (photo covers the same ground more impressively)
- Tamil or other languages beyond Hindi/Hinglish
- Multi-store or multi-user roles
