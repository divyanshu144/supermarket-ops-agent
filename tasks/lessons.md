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

---

## 2026-10-04 — An authorization gate with its own idea of "/start"

**What happened:** The access gate let `/start@otherbot hi` through the allow-list; it fell into the
text handler, which provisioned a store for a stranger.

**Root cause:** Two definitions of "is this /start". The gate parsed the command text itself; grammY's
`bot.command` requires the entity and the bot's own @username. The gate was more permissive than the
framework, and the downstream handler would create a store for whoever reached it.

**Next time:** Authorization checks must use the framework's own matcher, and the downstream handler
must fail closed rather than create the resource.

---

## 2026-10-04 — Recovery designed on unverified library and deploy assumptions

**What happened:** The spec said an interrupted turn "is recovered by redelivery as before", and the
SIGTERM handler called `bot.stop()`. Reading the installed source showed both were wrong.

**Root cause:** Unverified assumptions about library behaviour: that `bot.stop()` waits for handlers
(it confirms the update being handled), and that a fresh claim after a restart is reclaimable (the
300 s stale window drops it). The fix for the second, expiring claims at boot, then assumed the
previous process was dead, which rested on deploy configuration (`overlapSeconds`, one replica)
rather than anything enforced.

**Next time:** Read the library source for the exact shutdown/confirmation semantics before designing
recovery on top of it. A recovery step that assumes the previous process is dead must be backed by a
mutual-exclusion primitive (here a Postgres advisory lock), not by deploy configuration.

## 2026-10-06: merged status and verification evidence drifted

I found that HANDOFF and todo still called A and B unmerged even though git records PR #2
inside PR #1 and both in main. The handoff also mixed historical test counts. I checked the
history and reran the gate before recording the current count. Next time I will distinguish
merged code, a local passing gate and live deployment evidence at every checkpoint.

I also found that the live probes print raw errors, stderr or model replies. In particular,
the security probe prints its reply before checking for leaked credentials. I have not changed
the probes. Their execution needs protected output and a disposable database; I must not ask
someone to paste raw probe output or infer that an exit code alone proves a probe passed.

The installed SDK describes its budget cutoff as stopping after the budget is exceeded.
That is not evidence of a strict billing ceiling. I have made the limitation an explicit
spec decision instead of writing a test for fake costs and calling the real spending cap
proven. Next time I will distinguish admission accounting, observed cost and provider-side
spending controls before promising a hard budget.

## 2026-10-06: a restricted role does not cancel PUBLIC database access

I checked the local Postgres ACLs before building eval isolation. `kirana` and `postgres`
use default database ACLs, so a new restricted role still inherits PUBLIC CONNECT. Revoking
CONNECT from that role alone cannot override the PUBLIC grant. I will use a disposable
dedicated Postgres instance for the isolation tests and make the harness reject unsuitable
admin connections. I will not change grants on the existing shop database.

I also inspected SDK 0.3.220: it forwards `maxBudgetUsd` only when provided. The first two
cost probe queries and the session-store probe omit it. Exporting AGENT_MAX_BUDGET_USD in
a launcher cannot bound direct SDK calls that never read that variable. The protected
output/database work can proceed, but the paid launcher must wait for query-level budget
accounting rather than advertise an ineffective cap.

## 2026-10-06: eval expectations must agree with the product's skills

I initially proposed a valid empty deck as an eval outcome. The documents skill explicitly
tells the model not to generate a deck without sales. I corrected that scenario to require
a grounded no-data response with no artifact and retained chart inspection for the nonempty
case. Next time I will check the skill's instructions before treating a tool's technical
ability to produce a file as the expected agent behaviour.

During this review I found an unrelated existing issue in `src/repositories/products.ts`:
`adjustStock` accepts a reason but does not persist it, and unlike `receiveStock` it does
not check unit dimensions. The tool converts the supplied unit before calling it. I have
not changed this behaviour in the eval phase; a separate correctness fix needs its own
scope and invariant tests.

## 2026-10-06: preserve ownership proof through partial database setup

The first sandbox review found that a database can exist before its ownership comment does.
Cleanup must track the creation boundary independently and retain evidence whenever catalog
ownership cannot be proved. URL path comparison also misses PostgreSQL's default database
name for pathless URLs. Require explicit names, reject connection overrides, and test effective
identity. A failing test must not leave privilege probes behind: generate and track their names
and attempt every cleanup independently. The corrected implementation keeps an unverified
recovery manifest instead of guessing. Its fix and mutation evidence are in
`evals/results/task-1a-fix-*`.

## 2026-10-06: stderr is an output channel, not a trusted diagnostic

The first protected-child review caught that masking HTTP(S) URLs still allowed credentials
in PostgreSQL URLs, and ordinary exception text remained exposed in stderr. A value can also
be echoed from an environment variable even when the caller forgot to list it as an exact
secret. Treat stderr as untrusted, cover URL schemes and automatically protect sensitive
allowlisted values before integrating legacy probes. The accepted correction drains and
suppresses stderr and has mutation-checked stdout URI and credential handling.

## 2026-10-06: SDK tool results omit optional success flags

The SDK's `is_error` tool-result flag is optional. Requiring an explicit `false` labels valid
successful tool calls as pending, which would invalidate agent-eval traces. Match tool results
by their call ID and treat an absent error flag as a returned result with unknown error state.
Preserve every assistant model ID and the SDK's modelUsage map for fallback accounting. The SDK
PostToolUse hooks do carry the model call ID and completed response, while the local MCP handler
context does not. The reviewed design uses hooks as the canonical correlated execution evidence
and labels handler observations separately instead of inferring a match from arguments or timing.
# 2026-10-07: pg.Client statement sequencing in eval snapshots

## What broke

An eval snapshot initially issued several statements with `Promise.all` on the same `pg.Client`.
The integration test passed, but `pg` warned that overlapping queries on a client are deprecated
and will be removed in `pg@9`.

## Root cause

`pg.Client` has one connection and serializes its query queue. Parallel promises looked harmless
but relied on that implicit queue behavior.

## What to do next time

Use sequential `await client.query(...)` calls for a single client. Use a pool only when actual
parallel database work is required and its isolation semantics are clear.

## 2026-10-07: grade the artifact itself and validate every reference

The first Task 3 review found that a caller-supplied extracted-text field could make an
incorrect PDF appear correct, a broad string search could mistake unrelated output for
product candidates, and external-change references could point outside the seed. The approved
amendment adds `pdfjs-dist@6.3.289` as an exact development dependency for real file extraction.
The corrected code must validate generated PDF body text and deck XML/chart content, not just
signatures. Clarification checks inspect the actual `get_stock` ambiguous result shape, and
scenario references resolve to seeded records.

## 2026-10-07: localhost 5435 migration check (closed)

During Task 3 amendment work, `pnpm db:migrate` ran without overriding `DATABASE_URL`. The CLI
reported success; I confirmed drizzle-kit loads `.env` and the configured target was localhost
port 5435. With user approval, I later ran one read-only transaction querying only
`drizzle.__drizzle_migrations` on that host. The six IDs and timestamps matched the six entries
in the current migration journal, so the database was at the journal head when checked. This
cannot establish whether the earlier command changed it. No rollback was attempted, and no
credentials were printed. This check is closed with that historical uncertainty recorded; there
is no further action against 5435. For future migration commands, pass an explicit disposable
`DATABASE_URL` and verify the target without printing credentials.

One invoice integration test was also accidentally invoked without URL overrides. It failed with
`connect EPERM` to port 5435 before connecting; no query succeeded.

## 2026-10-07: replay fixtures must follow catalogue uniqueness and close their tool pool

The first replay fixture used two products with the same name to create ambiguity. The real
catalogue has a per-store unique-name constraint, so the fixture must use distinct names that
share a partial query (for example, `Tea Brand A` and `Tea Brand B`). Replay imports production
repositories, whose shared pool must point to the worker's throwaway database before tools
load. Close that pool before dropping the sandbox; otherwise PostgreSQL's termination error can
include connection parameters in a test failure. The replay integration selects the worker URL
before lazy-loading tools and ends the pool before sandbox cleanup.


## 2026-10-07: preserve failed-retry spend in the daily ledger

The runtime attached a conservative charge to `AgentRunFailure`, but the Telegram turn adapter
only persisted charges from successful `runAgent` results. A resumed attempt and fresh retry
could both fail, leaving the daily spend ledger unchanged despite the known worst-case charge.
The turn adapter now records that charge on the error path, while keeping the update uncompleted
for redelivery. A database-backed turn test checks the ledger and was mutation-checked by removing
the error-path recording guard.

## 2026-10-07: replay workers must re-check ownership, not only their initial URL

An independent Task 4 review found that matching the initial worker and pool targets did not
prove the persisted sandbox was still owned before later calls. The child now receives a
non-password proof from the exact sandbox object; it checks the durable manifest before entry
and before every step. The per-step mutation is killed by a test that changes the manifest
after the first handler and asserts the second handler is never called. CI has only the ordinary
Postgres URL, so only the two tests that provision a separate sandbox are skipped there.

## 2026-10-07: reservation settlement must remain usable after rejecting a refund

The synthetic budget ledger initially marked a reservation settled before validating the
reported charge. A rejected negative refund then stranded the reservation and prevented a
valid settlement. I moved settlement state changes after validation; the test now rejects a
negative amount, accepts a valid amount, and rejects only the subsequent duplicate settlement.

## 2026-10-07: responsible-AI implementation decisions approved

Owner identity is the Telegram user who redeemed the invite and is stored on the store. Legacy
stores and group chats fail closed. Confirmation uses a short callback ID backed by a DB row and
binds the current bill-line/price hash plus exact tool arguments; it expires after 10 minutes.
Preferences use enums and strict formats, with catalogue validation for brands. Transcript and
artifact retention is 30 days since last activity; invoice PDFs regenerate from finalized bills
before expiration, and export files are removed after sending. W4 now includes export and customer
pseudonymisation only. Store erasure is not done pending legal review. The owner authorized local
task commits on `responsible-ai` and explicitly prohibited pushes, live model calls, and probes.

## 2026-10-07: prompt-only confirmations and preference values are not enforcement boundaries

Reviewing the responsible-AI scope against the current handlers showed that skill instructions
ask for confirmation before some sensitive actions, while the tool handlers accept boolean
overrides directly. Preference values are also inserted into model context. Treat both as
untrusted inputs: enforce sensitive-action authorization outside the model turn, and validate and
render preference values as data. Current voice transcription uses in-memory buffers; verify the
no-audio-on-disk property with a test before documenting it as a maintained guarantee.

## 2026-10-07: mutation fixtures must exercise the guard, not an earlier rejection

The first callback-owner mutation survived because its test proposal used a fixed timestamp from
earlier in the day, so expiry rejected every callback before the owner predicate ran. The test now
injects its current time and advances only the expiry case. Mutation checks must keep unrelated
guards valid so a failure identifies the intended control. A foreign Telegram callback also needs
an explicit answer; silently stopping the middleware leaves Telegram showing a spinner.

The final W1 review found that a below-cost refusal and its pending callback fingerprint were read
in separate operations. The refusal now returns the hash from its locked line snapshot and the tool
passes that exact hash into the pending row. Confirmation still checks again under the bill lock
before stock or money changes. The regression test makes the bill change between refusal snapshot
and pending-row creation and verifies confirmation is stale.

## 2026-10-07: normalize before both insert and conflict update

W2 review found preference writes validated a normalized catalogue brand but the upsert conflict
path persisted the original whitespace-padded input. Reads normalized it again, which hid the
storage inconsistency. The update now persists the parsed value; a database assertion checks the
stored row itself. Review claims should be checked against the actual persistence path, not only
the read API.

## 2026-10-07: privacy copy must match both configured and fallback paths

W5 review found the disclosure described export requests through a contact even when no contact was
configured and no in-chat export existed. The copy now states the unavailable feature plainly and
uses the exact invite-issuer fallback for privacy requests. Tests assert the literal fallback rather
than importing the constant being tested, so an invented replacement cannot make the test pass.

## 2026-10-07: retention claims must reflect configuration and actual activity clocks

W3 made the privacy response read the configured retention period; a hard-coded “30 days” would have
been false when the owner overrides it. Transcript expiry uses the later of the session update and
its newest mirrored entry. Artifact expiry uses file modification time. Active claims and cleanup
share a store-row lock, and a database race test verifies the cleanup waits. The test role could not
reliably inspect another connection's query text through `pg_stat_activity`; `pg_locks` exposed the
blocked lock requests and gave the test a deterministic condition instead. The transcript mirror
has no store foreign key, so its test fixture explicitly removes its own `project_key` rows between
tests. Prettier has no parser for `.env.example`; format source/docs separately and edit that example
file directly, or the command stops before later validation.

The first W3 full gate also found a Telegram adapter test that still asserted W5's old “no automatic
expiry” wording after the `/privacy` response changed. Update integration assertions when changing
user-facing copy; the unit test alone did not cover the route through the real bot handler.

## 2026-10-07: exports must disclose data that cannot be mapped safely

W4 review found that generated invoice and deck files live in a shared artifact directory with no
store ownership index. Including every file would risk exporting another store's artifact. The JSON
export now states that these files are omitted in its manifest. Adding tenant-aware artifact
ownership would require its own design and migration review; the current slice does not infer
ownership from filenames. Pseudonymisation also treats a khata link to a bill outside the store as
ambiguous and fails closed before changing any row. It does not rewrite past conversation transcripts;
the confirmation preview now states this boundary so the user is not led to expect transcript erasure.

## 2026-10-07: security documentation needs a code-backed status test

W6 added a small offline consistency test after the first test-first run failed on missing documents.
The test now catches a false `implemented` store-erasure status, a missing Telegram parse-mode
threat, an affirmative certification claim, and a broken README link. Reviewing the repository also
found two stale README statements: export was described as unavailable and group members as owners.
Both now reflect the implemented owner-only commands and fail-closed group behavior.
The W6 review also caught statements that went stale after a later schema change. The first
artifact-export assertion matched an explanatory paragraph and let a mutated table row survive;
testing the exact row caught it. Keep consistency checks attached to the narrow claim they guard.

The independent review also found that the initial W3 worker used file modification time for every
artifact and did not invoke invoice regeneration before deleting an indexed invoice. Those W3
behaviors are being corrected before W6 can be completed. The review's statement that one stale
session could delete multiple session rows is not reachable with the current schema because
`sessions.store_id` is its primary key; the delete is narrowed to the agent-session ID anyway. No
legacy artifact backfill is safe because old filenames do not identify a store or bill.
## 2026-10-07: W3 indexed retention correction

- The independent W6 review caught a real retention gap: generated artifact files were not tied to
  authenticated owner activity, and expiring invoice PDFs were not regenerated from their bills.
  Keep retention claims tied to a tested mapping from owner activity to each artifact.
- An active Telegram update claim must protect indexed artifacts from expiry as well as sessions.
  The focused test failed before the worker was corrected and passes after it skips claimed stores.
- The artifact registry changes the export boundary: export store-scoped indexed metadata, omit
  file contents, and separately disclose historical files that cannot be mapped to a store.
- Typecheck caught a bad `billId` binding in the invoice tool; use the schema's actual
  `bill_id` field when recording generated artifacts.
- A documentation guard must assert the relevant table row, not only match equivalent wording in a
  separate paragraph. The first stale-inventory mutation survived because of that loose match; a
  row-scoped assertion then failed on the same mutation as intended.

## 2026-10-07: W7 synthetic replay must execute app behavior

The first W7 draft compared self-authored tool traces and state fingerprints. Fresh review correctly
rejected it: changing the production tool or tenant predicate would not change those supplied
strings. Keep trace-grader tests as grader tests only; acceptance cases must invoke the registered
tools and assert actual database state. Review also caught a spend-abuse fixture that passed repeated
calls and an empty tag selection that returned green. Add tests for those behaviors before restoring
the W7 implementation path. A replay's fixture cap must not be described as a production cost
limit.

During the handler integration test, the first PII assertion treated the customer's requested name
as leaked data. That was a false positive because the handler echoed the query; the protected phone
number is the sensitive value under test. I narrowed the assertion and then the actual handler test
passed. I also verified the owner identity is carried into the synthetic test context so the replay
uses the same owner-scoped code path.

Fresh final review caught an intentionally over-limit trace being reported as a passing safety case
because the grader treated its expected violation as success. Keep safety outcome reports green only
for traces with no violations. Test violation detection by mutating an otherwise safe fixture in a
unit test, and state clearly that the test-only tool-call bound does not constrain production spend.
