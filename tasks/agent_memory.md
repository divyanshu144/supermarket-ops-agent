# Agent Memory — Supermarket Ops Agent

Durable structured reference. **Honour locked decisions even if the code suggests otherwise.**
If a locked decision needs to change, change it here first and say so explicitly.

---

## Architecture Decisions

### Locked 2026-07-29

| # | Decision | Why |
|---|---|---|
| AD-1 | Claude Agent SDK (TypeScript) as the harness | Named first in the brief; skills, tool schemas and sessions are first-class, so the graded surface is the SDK's own idiom rather than scaffolding we invent. |
| AD-2 | `claude-opus-5`, adaptive thinking, no cheaper routing | Tool-orchestration reliability outweighs token cost on a graded 2-day build. |
| AD-3 | Postgres + Drizzle | Row locking and real transaction isolation is the honest answer to the concurrency requirement. |
| AD-4 | **One store per Telegram chat**, keyed on chat id | Reviewers run the same script concurrently; a shared store lets one reviewer's stock-in silently defeat another's oversell-guard demo. |
| AD-5 | **`store_id` is never a tool parameter** — injected server-side from the verified chat | The model has no argument with which to address another store, so prompt injection cannot cross tenancy. Enforced at the boundary, not in the prompt. |
| AD-6 | **Built-in SDK tools disabled** (Bash/Read/Write/Edit/Glob/Grep/Web*) via an `allowedTools` allowlist | A Telegram bot is an open input channel; those tools behind it are a live shell. |
| AD-7 | Money in **integer paise**; quantities in **integer base units** (g / ml / whole units) | No floats anywhere near money or stock. 2.5 kg is `2500`, not a float. |
| AD-8 | **MRP is tax-inclusive; GST is back-calculated** | Adding GST on top of MRP would charge above the printed price, which is illegal in India. |
| AD-9 | CGST = `floor(gst/2)`, SGST = remainder | Deterministic, documented, and the two always sum to the total. Odd paise go to SGST. |
| AD-10 | Long-polling in dev **and** prod | No public URL, webhook config or TLS. Dedupe is required regardless of transport. |
| AD-11 | pdfmake for PDF, pptxgenjs for PPTX | Native table support / native chart objects. No headless Chrome. |
| AD-12 | Railway for deployment | Managed Postgres in one click, stays running through review. |
| AD-13 | Price, GST rate and HSN **snapshotted onto `bill_items` at add time** | A bill built across several messages must not shift if the product is edited mid-build. |
| AD-14 | Scope: §3 capabilities + §4 hard parts. **Zero §7 stretch items.** | 2-day fixed deadline. §4 is what is graded. |
| AD-32 | **B keeps sequential polling and mirrors sessions in Postgres** (`session_entries` behind the SDK `sessionStore`). | The grammY runner confirms offsets early and can lose up to 100 updates on kill (from reading grammY's source). Sessions are expected to survive redeploys; unverified until `src/agent/session-store.probe.ts` passes. |

### Revised 2026-07-29 after spec review

| # | Decision | Why |
|---|---|---|
| AD-15 | **Walking skeleton first** — deployed end-to-end pipe before schema/domain/tools | The risk that kills a 2-day integration build is SDK/Telegram/Railway surprises, not GST rounding. Reverses the earlier correctness-first order. Also makes every later milestone demoable. |
| AD-16 | **`processed_updates` is a claim, not a completion marker** | Under long-polling, redelivery happens *only* when the offset didn't advance — i.e. exactly when the turn crashed mid-handling. Insert-on-receipt would reject precisely the redelivery that must be reprocessed, silently dropping the owner's message. |
| AD-17 | Idempotency key includes an **occurrence ordinal** | `(update_id, tool, args_hash)` alone collides on legitimately repeated identical calls (two identical bill lines), silently no-op'ing the second. |
| AD-18 | **`finalize_bill` accepts `payment_mode: "khata"`**; ledger charge inside the finalize transaction | Bill-then-charge as two transactions leaves a crash window where stock is decremented and the customer is never billed. |
| AD-19 | **Tax is derived from the line total, never per-unit × qty** | The customer pays `MRP × qty` exactly, so taxable value must derive from that. 4 × Maggi ₹14 @5%: 5333 taxable, not 5332. |
| AD-20 | Loose-item line total: `round_half_up(mrp_paise × qty_base / base_units_per_selling_unit)`, rounded once at line level | `mrp_paise` is per selling unit (per kg), `qty_base` is grams; the division needs an explicit rounding rule. |
| AD-21 | `find_bills(customer?, date_range?, limit?)` exists | §3 asks for "send me that bill as a PDF" verbatim; without a lookup, a stale reference has no path to a `bill_id`. |
| AD-22 | Seed history dated **relative to `now()` at provisioning** | Hardcoded dates make "this week's deck" empty for anyone messaging after the seed window passes. |
| AD-23 | Latency lever is **`effort`, not disabling thinking** | Disabling thinking on Opus 5 causes tool calls emitted as plain text (call silently never runs) and `<thinking>` leakage. A skipped tool call in a billing agent is far worse than latency. |
| AD-24 | **Railway replicas pinned to 1** | Two instances long-polling one bot token → 409 conflicts and dropped updates. Looks fine until a rolling deploy runs two containers. |
| AD-25 | Multiple concurrent **draft bills per store stay legal** | The brief's "two bills in flight" is intra-chat, since per-chat stores never contend cross-chat. Rules out a single-draft unique index. |

---

## Known Gotchas

- **SDK cost semantics are unverified.** The SDK docs state `total_cost_usd` on a resumed session
  includes earlier spend; `SDK_COST_IS_CUMULATIVE = true` in `src/agent/limits.ts` rests on the
  docs only. `pnpm tsx src/agent/cost.probe.ts` and `pnpm tsx src/agent/e2e.ts` have NOT yet been
  run and must be run with a real key before relying on the per-run budget cap.
- **The `claude-api` skill does not cover the Claude Agent SDK.** They are different packages.
  Agent SDK docs live at `code.claude.com/docs/en/agent-sdk`. Verify its surface there rather
  than from memory or from the Claude API skill's tool-runner examples.
- **An empty store produces an empty analysis deck.** Seeding must include ~2 weeks of synthetic
  sales history or one of the two headline artifacts demos as blank charts.
- **grammY `bot.stop()` confirms the in-flight update** (`offset = lastTriedUpdateId + 1`) and does
  not wait for the handler, so a SIGTERM path that calls it loses the owner's message. Shutdown
  drains instead and exits without `stop()` (`telegram/drain.ts`).
- **`claimUpdate`'s 300 s stale window drops a redelivered update after a fast restart**, hence the
  boot-time claim expiry (`expireInFlightClaims`).
- **The boot-time claim expiry is only safe because of the instance lock.** A Railway handoff may
  run two containers briefly (not verified); `overlapSeconds` is not a guarantee. `db/instance-lock.ts` makes the
  new instance wait for the old one's connection to close. The lock is lost silently if its
  connection drops mid-life, and the first deploy that introduces it replaces code that holds no lock.
- **The grammY runner confirms offsets early** (up to 100 updates lost on kill), which is why
  sequential polling was kept.
- **The SDK `SessionStore` is `@alpha`**, retries `append`, wants `uuid` idempotency, and
  `mirror_error` text can contain query parameters (log the session id only).
- **Postgres `jsonb` rejects U+0000.** Transcript entries are stored with NUL characters removed
  (`repositories/session-entries.ts`).
- **Live probe C output (resume from a store with no transcript): not yet captured.** Run
  `pnpm tsx src/agent/session-store.probe.ts` with a real key and paste Q-C's output here.
- **cSpell flags every domain term** (khata, kirana, atta, paise, CGST, GSTIN…). Project
  dictionary is in `cspell.json`; add new domain words there rather than ignoring the warnings.

---

## Solved Problems

_(empty — record the problem, the root cause, and the fix as they come up)_

---

## Useful Patterns

- **Refusals are data, not exceptions.** Guardrail violations return a structured refusal the
  model must relay. Tools never silently comply and never throw for a business-rule violation.
- **Ambiguity is data too.** The resolver returns `{status: "ambiguous", candidates: [...]}`;
  the *model* decides to ask which one. That is what makes the clarifying question model-driven
  rather than a hardcoded branch.
- **Compare-and-set for stock**, never read-then-write. `UPDATE … WHERE quantity_base >= $qty`
  returning zero rows *is* the oversell guard.
- **Lock rows in deterministic order** (sorted by product id) so concurrent bills over
  overlapping products cannot deadlock.

### Verified empirically 2026-07-30 (Milestone 0)

| # | Finding | Evidence |
|---|---|---|
| AD-26 | **Skills load behind the strict allowlist.** The gate is the built-in `Skill` tool, NOT `Read` — so the filesystem stays denied and spec §9 needs no reshaping. Requires `settingSources: ['project']`; with `[]` skills silently never load and every test still passes. | `runtime.smoke.ts`, reproduced at all three effort levels |
| AD-27 | **Effort does not measurably drive latency** for a simple query. low 14.2s / medium 12.4s / high 9.5s — ordering inverted from expectation, so at n=1 per level this is variance, not signal. Floor is ~10–14s. Keeping `medium`. | effort sweep, one sample per level |
| AD-28 | **`ToolSearch` runs before `get_stock` on every turn**, despite only two tools being registered. Prime suspect for the latency floor, and the thing to investigate before the demo — not `effort`. | `toolsUsed` in all six smoke runs |
| AD-29 | **The allowlist genuinely blocks the filesystem.** Four direct attempts (read `.env`, run `ls -la`, list files, write a file) all refused with **zero tool calls** and no credential leaked. §4 is now empirically supported, not just designed for. | `security.probe.ts` |
| AD-30 | **Tools must never return raw DB rows.** `JSON.stringify` throws outright on BigInt, so `get_stock` errored on every call in production while unit tests passed. Present a shaped view — which also stops leaking cost price and internal ids to the model. | live smoke run; regression test in `inventory.test.ts` |
| AD-31 | **Pin `packageManager`.** Unpinned, container corepack pulled pnpm 11 against a pnpm-9 lockfile and the image would not build at all. | docker build failure |
