# Lessons

Chronological. After **any** correction or non-obvious discovery, append an entry:
what broke / the root cause / what to do next time.

---

## 2026-07-29 — Assignment.md was replaced mid-session

**What happened:** I answered a question about `claude_onboarding.md`, then asked three scoping
questions built on the assignment as I'd read it. The file was then swapped for an entirely
different brief (Newpage RAG assistant → BigMantra Supermarket Ops Agent), invalidating all
three questions.

**Root cause:** I treated a file read early in the session as still current later in the session.

**Next time:** Re-read source-of-truth documents before building decisions on top of them,
especially after any gap in the conversation. A file read is a point-in-time snapshot, not a
standing fact.

---

## 2026-07-29 — The claude-api skill does not cover the Claude Agent SDK

**What happened:** Loaded the `claude-api` skill expecting Agent SDK guidance for our locked
harness. It explicitly states it covers the Claude API and Managed Agents only, and that the
Claude Agent SDK is a separate product with its own docs.

**Root cause:** Two similarly-named things — the API SDK's Tool Runner
(`client.beta.messages.tool_runner`) and the Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`) — are easy to conflate.

**Next time:** For Agent SDK specifics (`query()` options, `createSdkMcpServer`, subagents,
session resume, `allowedTools`), go to `code.claude.com/docs/en/agent-sdk`. Do not substitute
the API tool-runner patterns, and do not write Agent SDK bindings from memory.

---

## 2026-07-29 — Sequenced the build to protect against the wrong risk

**What happened:** The first build order put schema, domain and tools before any end-to-end
wiring, justified as "if time runs out, what exists is correct." Review pointed out this is
backwards for a two-day integration-heavy build.

**Root cause:** I optimised against the risk I could see clearly (GST rounding errors) rather
than the risk that actually kills the project (the Agent SDK, Telegram or Railway behaving
differently than assumed). The first is reasoning I can do at a desk and verify with unit tests;
the second is only discoverable by running the thing.

**The tell I missed:** my own spec flagged that skill loading might go through the `Read` tool,
which the allowlist disables — a foundational assumption that could invalidate the entire skill
layer. I wrote that down as a risk and then scheduled the work that would surface it on day two.

**Next time:** When a build is integration-heavy and time-boxed, get a walking skeleton deployed
first — one thin slice through every layer, on the real host. Build behind a proven pipe. It
also means every milestone afterwards is demoable, so a bad second day still leaves something
recordable.

---

## 2026-07-29 — Dedupe that protects against the case that can't happen

**What happened:** Designed `processed_updates` as insert-on-receipt to dedupe Telegram
redeliveries. Review showed this drops real messages.

**Root cause:** I reasoned about redelivery as an abstract "the same update might arrive twice"
without asking *when* it actually arrives twice. Under long-polling, Telegram redelivers only
when the offset didn't advance — which is exactly the crash-mid-handling case where the row is
already written. So the guard fires precisely when reprocessing is required, and silently
swallows the owner's message.

**Next time:** For any dedupe or retry guard, write down the specific sequence that triggers a
duplicate before designing the check. "Could this arrive twice?" is the wrong question;
"under what exact failure does it arrive twice, and what state am I in then?" is the right one.
A completion marker and a claim look identical until you ask that.
