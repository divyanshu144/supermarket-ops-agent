# Agent evals: proposed design

Status: approved on 2026-10-06 with “looks good, goahead”. Offline implementation is starting;
the explicit live spending cap is still pending.
Branch: `eval-harness`. Inspected code: `4359796`; reconciliation commit: `b6ac0af`.

## Intent and boundaries

I want evidence that the agent keeps a shop's books correct across messy conversations. I will
grade database changes and the actual tool trace before judging prose. I will keep TypeScript,
Node 24, Postgres, Drizzle, Zod, Vitest and the Claude Agent SDK. I will preserve the default
model, effort, skills and tool allowlist. I will not add routing, retrieval, tracing or subagents
in this phase. Those get separate specs and approvals after this baseline exists.

The recorded metrics will describe runs I execute, not forecasts. The thresholds and counts
below are proposed acceptance policies, not measured results. I will record omissions and
inconclusive experiments rather than invent a passing result.

## Approaches considered

1. I recommend a native TypeScript runner with a live adapter and a recorded-trace adapter.
   Both use real tools, a disposable Postgres database and one deterministic grader. This adds
   little infrastructure and preserves the existing agent path.
2. I could make every scenario a live Vitest test. That would couple CI to credentials, latency
   and model variance, and would make partial budget reports awkward. I reject it.
3. I could replay replies and canned database snapshots only. That would test JSON comparison
   without testing whether tools still produce those database outcomes. I reject it.

## What I found in the current code

- `src/agent/runtime.ts` exports `runAgent`, but exposes only tool names, reply, cost, turns,
  session and outcome. I need actual inputs and results, including refusals and errors.
- `src/tools/index.ts` registers tool definitions in `STORE_TOOLS`. I will wrap their handlers
  at registration, keeping schemas and business logic unchanged, and observe through the turn
  context. Tools must not import `src/evals/` or Telegram.
- `src/db/client.ts` creates a process-wide pool when imported. I will use a separate worker
  process per repetition with its database URL set before imports, rather than redirect a
  shared pool while scenarios run.
- `src/agent/e2e.ts` uses fixed store IDs and several weak assertions. It is a prerequisite
  probe, not the new baseline. I will leave its business flow intact.
- `src/agent/limits.ts` marks both cost and budget cumulative semantics unverified. I must
  settle these before accepting cost numbers. An inconclusive probe is not confirmation.
- The installed SDK declaration says `maxBudgetUsd` stops a query when the budget is
  **exceeded** (`sdk.d.ts`, lines 1679 onward). This does not promise a strict provider billing
  ceiling. I cannot honestly promise that an in-flight request never crosses a dollar limit.

## Scenario contract

I will define a strict, versioned Zod schema in `src/evals/scenario.ts`, infer its TypeScript
types, and reject unknown fields, duplicate IDs, unsafe integers, unknown fixture references,
invalid units and empty expectation lists before connecting to a database or calling a model.
Scenario files will be JSON under `evals/scenarios/`.

Each scenario has an ID, description, tags, difficulty, seed version, products, initial stock,
khata accounts and ledger entries, preferences, optional dated sales history, and ordered
steps. Products use integer paise, integer base quantities and integer GST basis points.
Products and bills have fixture keys independent of UUIDs. Expectations use independently
calculated constants, never the production GST function to calculate its own expected result.

A step is an owner message, a `/new` boundary, or an explicitly declared external state change
between messages. The last is necessary to test stale-memory grounding: another sale or ledger
entry changes state after the agent has read it. External changes are recorded separately from
agent actions. `/new` calls the same persistence operations as the command adapter and clears
the session transcript and cumulative cost while preserving stock, bills, khata and preferences.
This is an eval control operation, not a new intent router.

Step and final expectations cover:

- Exact product stock and catalogue cardinality, movements, draft/finalized/void bill counts,
  line quantities and prices, subtotal, CGST, SGST, round-off, total and payment mode/reference.
- Khata balances and ledger deltas, including no account or entry created by an unknown
  settlement. Refusal scenarios assert unchanged business state, not just nonnegative stock.
- Tool presence, absence, counts, argument predicates, result status and partial ordering.
  I will require lookup before the dependent action and confirmation before an override, not
  one arbitrary total order for independent product lookups.
- Refusal codes in tool results and localized response evidence conveying the refusal.
  Codes need not appear verbatim in owner-facing prose. Unsupported paraphrases are marked
  for review, not silently passed. Semantic ambiguity goes to the calibrated judge.
- Grounding within the current owner turn, with preference recall explicitly exempt because
  preferences are injected. Previously observed state does not satisfy fresh grounding.
- Artifact MIME, actual file signature, invoice text/totals, and native PPTX chart entries.
  Queuing a filename alone is insufficient.
- Clarification before mutation. A question mark alone cannot earn a pass. Deterministic
  checks establish no premature mutation and candidate lookup; the judge evaluates whether
  the question resolves the actual ambiguity.

## Initial scenario inventory

I will implement these 48 scenarios. They are a coverage contract, not claims of passes.
Each has step-level assertions in addition to final state. Hard cases are marked H.

| IDs | Owner behaviour and principal checks |
| --- | --- |
| receive-packets, receive-loose, receive-hinglish | Receive packaged stock, convert loose units, parse Hinglish; exact stock and receipt movements |
| receive-unknown | Unknown SKU does not silently create a product |
| new-product-complete, new-product-missing-tax | Complete product persists; missing GST causes clarification before creation |
| bill-mixed-tax, bill-loose-rounding, bill-tax-rounding | Mixed slabs, loose units and line-total rounding; independent totals and tax constants |
| bill-edit-remove, bill-edit-quantity, bill-repeat-line | Multi-turn changes preserve a draft until payment; exact final lines and stock |
| bill-draft-no-decrement, bill-finalize-twice | Draft leaves stock alone; repeat finalize has one invoice and one decrement |
| oversell-single, oversell-duplicate-lines | Refusal with no sale, invoice or ledger change |
| below-cost-refuse, below-cost-confirm, above-mrp-refuse | No premature override; explicit below-cost confirmation works; above MRP never overrides |
| khata-charge-existing, khata-charge-new, khata-settle | Exact ledger and balance changes |
| khata-unknown-settle, khata-overpay, bill-to-khata | Refusals leave state unchanged; credit bill produces exactly one charge |
| ambiguity-atta-H, ambiguity-add-H, ambiguity-bill-reference-H | Competing SKUs, unclear action, multiple bills; sensible question and no guessed mutation |
| ambiguity-unit-H, ambiguity-customer-H | Missing quantity unit and insufficient customer identity; question before money or stock changes |
| reorder-threshold, reorder-velocity, daily-close, daily-close-empty | Grounded reports with exact result data and no mutations |
| invoice-pdf, invoice-ambiguous-H, analysis-deck, analysis-empty | Correct nonempty artifact and source data, disambiguation; empty sales produce a grounded no-data response without a deck, as the documents skill requires |
| preference-payment-new, preference-brand-new, preference-cash-override | Persist through real session clearing; explicit payment beats default |
| hindi-stock, hinglish-bill, hindi-khata | English catalogue resolution with Hindi/Hinglish messages and exact outcomes |
| injection-product-name, cross-store-request, delete-stock-request, shell-request | Stored-name injection does not become instructions; sentinel tenant unchanged; no destructive or built-in execution |

I will also add `grounding-changed-balance-H` and `grounding-changed-stock-H` as explicit
multi-turn external-change cases, giving 50 scenarios in the initial acceptance set. A count
test checks this inventory and its required tags, but is not evidence of behavioural quality.
The delete request will explicitly ask to erase records without an audit trail, distinguishing
it from a legitimate signed stock adjustment.

Implementation review correction, 2026-10-06: I initially expected an empty deck artifact.
The documents skill explicitly forbids generating one without sales, so I corrected the
`analysis-empty` oracle to match the intended owner-facing behaviour. I will still verify
native charts and source values in the nonempty deck scenario.

## Isolation and lifecycle

I will require `EVAL_DATABASE_ADMIN_URL`, separate from `DATABASE_URL`, and reject a non-local
host unless the operator explicitly opts into a dedicated eval server. I will create a random
database and a restricted role per scenario repetition. That role can access only its database,
cannot create roles/databases and cannot connect to the normal store database. Provisioning
must fail if those privileges cannot be enforced. The worker receives only its database URL,
synthetic fixture inputs, a dummy Telegram token and the model key for live mode. The database
administrator credential stays in the coordinator and is never passed to the SDK child.

I will apply committed Drizzle migrations, seed the scenario store and a sentinel second store,
then execute the steps. Each repetition gets fresh DB state, SDK config/session files, and an
artifact directory. I will close workers before dropping only the exact database and role
created for that repetition, verified against a run manifest. Interrupts write partial reports
and attempt cleanup; failed cleanup records resource names and explicit cleanup commands without
connection strings. A crash cannot cause a broad prefix-based drop or reuse a dirty database.

I will pin the seed's calendar anchor to an explicit run timestamp and record its timezone.
Daily scenarios will use explicit dates where the tool supports them. If a relative-date case
crosses its day boundary during execution, the runner invalidates that sample instead of
mistaking a time change for a model regression. All repeats use the same seed values.

## Trace and replay

I will add an optional observation callback to `ToolContext`, with call ID, name, start/end,
validated arguments, result and error classification. The registered handler wrapper feeds it
without changing results. SDK observations separately capture attempted built-in calls, model
usage, actual model IDs and owner-turn boundaries. Missing or unmatched events invalidate the
sample. Tool observers must not turn an observer failure into a successful eval.

Live mode runs the existing `runAgent` path. Small optional runtime controls will accept a
stricter remaining budget and observation sink; production defaults remain unchanged. The
runner loads preferences and handles sessions using existing persistence APIs.

Recorded traces bind generated IDs to symbolic references and retain ordered owner steps,
tool calls/results, replies, source run metadata and artifact expectations. Replay invokes
the same registered, schema-validated tool handlers against fresh seeds, resolves references,
and compares newly produced results and DB state with the recording and independent scenario
expectations. It never applies a recorded database snapshot as the result of a tool call.

I will commit reviewed recordings captured from actual live runs. Until available, authored
fixtures may test the grader but must be labeled synthetic and cannot be called golden agent
traces. CI will require recordings for the accepted scenario inventory and run replay with no
provider credentials. No network model adapter may be imported in replay mode. Replay proves
grading/tool compatibility; it cannot prove a new prompt still chooses the right tools.

## Deterministic and judged grading

Deterministic failures always fail the scenario. A judge can never override wrong stock, money,
tool execution or tenant isolation. I will judge only tone, clarification relevance, and refusal
meaning that bounded multilingual matching cannot establish reliably.

The judge will use a fixed versioned rubric, pinned model ID, separate stateless SDK query,
no tools, no project skills and a strict structured output schema. It returns rubric ID,
item ID, pass/fail/abstain, evidence quotations and a reason. Invalid JSON, fabricated
evidence, API failure and abstention cannot count as a pass. Replies and product names are
untrusted quoted data within the rubric. Judge calls share the total budget and timeout policy.

Before viewing judge verdicts, I will hand-label at least 20 distinct items covering sensible
and bad questions, Hindi/Hinglish, terse refusals, hostile language and fluent but irrelevant
answers. I will write the labels and rationales to a hashed file first. These are my manual
labels as an AI coding agent, not independent human annotation; the report will say so.
I will report the confusion matrix, raw agreement, abstentions and exact disagreements.
The proposed calibration gate is at least 85% agreement with abstentions counted as errors.
If it fails, judged results stay advisory and the live baseline is not accepted as fully graded.

I will include one actual judge error with label, verdict and evidence. If the initial set has
none, I will evaluate an additional, separately reported challenge set without changing the
first set's denominator. If none is found, I will report that limitation, not fabricate one.
Rubric revisions require a fresh held-out validation set; I will not tune and score on the same
20 items without disclosing it.

## Variance, cost and budgets

Default repetition count is 3, configurable as a positive integer. I define pass@1 as the
number of scenarios passing their first repetition divided by all selected scenarios. I will
also report mean per-attempt pass rate, all-N pass rate, and scenarios with both passing and
failing repetitions. Skipped, aborted and infrastructure-invalid attempts are visible and
cannot disappear from denominators or produce an accepted baseline.

Every attempt records owner turns, SDK `num_turns`, tool-call count, monotonic wall time,
tokens by model, reported cost and conservative budget reservation. No reported result means
unknown actual cost, not zero. I will separate judge cost from agent cost and include both
in total spend. USD accounting uses integer micro-USD; store money stays integer paise.

Proposed configuration: explicit `--budget-usd` required for live mode, no paid default; 3
repeats; current runtime turn/time limits. The coordinator runs sequentially, reserves each
query's maximum permitted spend, admits no call without room, includes retries and judge calls,
and flushes a partial report on budget exhaustion. I will test this with a fake model.

**Decision needed:** I can enforce a hard admission ceiling and stop once reported spend hits
it. The SDK's documented stop-after-exceed behaviour cannot establish a strict provider-charge
ceiling. Before implementation I need acceptance of that stated limitation, or a provider-side
hard spending control verified for this account. I will not label a soft SDK ceiling a hard
billing guarantee. Live spending also needs an explicit dollar cap in the approval.

## Commands, reports and baseline comparison

- `pnpm eval` runs replay by default; `--scenario <id>` and `--tag <tag>` filter either tier.
- `pnpm eval --tier live --repeat 3 --budget-usd <approved-cap>` runs live. Unknown selectors,
  zero matches, incompatible flags and missing credentials fail before work starts.
- `pnpm eval:compare --baseline evals/baseline.json --report <report.json>` compares runs.

I will write atomic JSON and Markdown reports under `evals/results/<run-id>/`. They contain
UTC date, exact sanitized command, commit, dirty diff hash, SDK version, model and effort,
fallback use, scenario/seed/prompt/skill/rubric hashes, all attempts, assertion evidence,
metrics, failures, cost provenance, completion state and cleanup status. JSON encodes bigint
IDs as strings. Reports never contain credentials or DB URLs. Full synthetic transcripts may
be committed after redaction and review; real Telegram messages are outside this harness.

The committed baseline identifies the last explicitly accepted complete live run. It is never
created from replay, an incomplete selection, or a guessed number. Acceptance and committing
remain explicit user actions. Comparison rejects incompatible scenario sets, repeats, models,
rubrics, seeds or unverified cost semantics. Prompt/skill/code differences are allowed and
reported, since those are what regression evaluation measures.

Proposed failure thresholds: any pass@1 or all-N pass-rate decrease, any new deterministic
safety failure, or total agent-plus-judge cost more than 10% above the baseline on the same
workload. A zero-cost baseline is invalid for live comparison. A partial or invalid report
fails comparison rather than yielding a misleading improvement. Thresholds are configurable
but recorded in the comparison output. I will include per-scenario changes and p50/p95 wall
time, and explain that three repetitions are a limited sample, not statistical certainty.

## Mutation evidence

For every new behavioural test I will temporarily break the exact guarded path, run the
targeted test, save its failing output, restore it and save the passing output. A syntax or
import error is not a successful behavioural mutation. A surviving mutant means the test
must be improved before it counts. The results ledger maps tests to mutations and evidence.

The three requested live regressions run in disposable source copies and eval databases:

1. Replace the prompt-visible `finalize_bill` insufficient-stock response with a false success,
   leaving DB constraints intact. Force a multi-turn draft/finalize attempt with a controlled
   stock reduction before payment. Assert the raw refusal status and unchanged state. Merely
   deleting a prompt sentence would not remove a tool-layer guard.
2. Weaken the billing skill's draft/payment instructions so it encourages finalizing an
   unfinished draft. Run draft and mid-build-edit scenarios. Record the exact diff and whether
   the live model actually regresses; replay alone cannot prove skill sensitivity.
3. Remove the system prompt's fresh-grounding rule. Run the external-change balance/stock
   scenarios and require a new read plus the updated answer.

I will run clean controls and mutants with identical seeds and N. I will show commands,
model IDs, costs and before/after outputs. If a mutant survives, I will say so and stop to
re-plan the experiment. I will not claim the suite caught it because a static text check failed.

## Prerequisites and phased acceptance

I will first run cost, session-store, e2e and security probes, in that order, in a disposable
database with all stdout/stderr sanitized before display or storage. The session probe's B
must pass and C must be recorded; e2e needs all 13 outcomes `ok`; security needs each attack
to run successfully before a no-breach verdict counts. An auth error is not a security pass.
Probe output currently permits raw secrets, so a protected launcher belongs in the approved
scope. It must avoid piping unsanitized chunks straight to the terminal.

I will add no dependency in this phase. Existing Zod, SDK, pg, Drizzle, Vitest and Node APIs
cover the runner. Existing archive/PDF inspection patterns will be reused. If they cannot
verify artifact contents adequately, I will stop with a pinned dependency proposal and Node 24
evidence rather than quietly add one.

I will run `pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test`, show its output, wire
replay into CI and document live as manual initially. Scheduled live runs remain off until
credentials and an approved spending policy exist. README gets a short section linking the
actual baseline, results, mutations and tier limitations. HANDOFF, todo, lessons and memory
will be updated at each checkpoint.

Phase 1 is not done until the suite runs end to end, replay is wired into CI, regression and
test-mutation evidence exists, judge validation is honest, and an accepted live baseline is
recorded or a precise blocked-live runbook is handed to the operator. I will not describe
unimplemented or unmeasured later phases as complete.
