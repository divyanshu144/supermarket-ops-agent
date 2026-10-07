# Agent evals implementation plan

> For agentic workers: use `superpowers:subagent-driven-development` task by task as required
> by CLAUDE.md. Review each task before advancing. Do not commit or open a PR unless asked.

**Status:** approved on 2026-10-06. Offline implementation is starting; live calls await an
explicit spending cap.

**Goal:** measure actual agent decisions and database outcomes, with an offline replay gate
and a repeatable live baseline.

**Architecture:** a coordinator owns budgets and disposable databases; a fresh worker runs
each repetition. Live and replay adapters share scenario validation, tool execution evidence,
database assertions and reporting. Production tools and agent code never depend on eval code.

**Tech stack:** TypeScript, Node 24, pnpm 9.15.4, installed Claude Agent SDK, Zod, pg, Drizzle,
Vitest. No new dependency is approved.

**Spec:** [Agent evals](../specs/2026-10-06-agent-evals.md).

## Global constraints

- Branch `eval-harness`; no code before both documents are approved.
- Money is integer paise; model spend is integer micro-USD.
- Default repeats: 3. Live budget must be explicit. No changes to default model or routing.
- At least 40 scenarios; this proposal enumerates 50. At least 20 manually labeled judge items.
- No live baseline without verified cost semantics and complete provenance.
- Every new behavioural test requires a targeted failing mutation and a restored passing run.
- No extra commits after the authorized reconciliation commit until the user asks.
- If a requirement cannot be met, stop the dependent task and re-plan, keeping independent
  work moving. Never replace empirical evidence with text matching or synthetic numbers.

## Review focus

1. Killing a worker between a mutation and its final result must produce a partial, failed run
   with conservative cost accounting, not a green result or leaked database (tasks 1 and 5).
2. A recorded UUID substituted into another tenant's request must never access the sentinel
   tenant, even when the recording is malformed (tasks 1, 3 and 4).
3. An observer exception or missing tool result must not hide successful stock mutation from
   the report; the sample becomes invalid with captured state (tasks 2 and 5).
4. Cross-midnight analytics must not compare different day windows silently (tasks 3 and 6).
5. Judge injection, fabricated evidence, invalid output and a zero-match CLI filter must fail
   closed, without creating a baseline (tasks 5, 7 and 8).

## File and interface map

I will keep the implementation in these focused files. Names here are proposed interfaces,
not existing exports or claims that the code has already been written.

| File | Responsibility and public interface |
| --- | --- |
| `src/evals/scenario.ts` | Strict schema, `Scenario`, `parseScenario(unknown): Scenario` |
| `src/evals/types.ts` | `RunConfig`, `Attempt`, `ToolEvent`, `AssertionResult`, `EvalReport` shared contracts |
| `src/evals/database.ts` | `createSandbox(config)` returns worker URL, manifest and exact-resource cleanup |
| `src/evals/seed.ts` | `seedScenario(scenario, anchor)` returns symbolic fixture bindings |
| `src/evals/worker.ts` | Execute one scenario repetition; stream validated events to coordinator |
| `src/evals/live.ts` | `runLiveStep(step, context)` through production `runAgent` |
| `src/evals/replay.ts` | `runReplayStep(step, recording, bindings)` through registered tools |
| `src/evals/assertions.ts` | `gradeAttempt(scenario, evidence)` deterministic assertions, no model calls |
| `src/evals/judge.ts` | Versioned rubric calls and validation of evidence-bearing verdicts |
| `src/evals/budget.ts` | Reserve, settle, account unknown charges and deny admission |
| `src/evals/report.ts` | Validate and atomically write complete or partial JSON and Markdown |
| `src/evals/compare.ts` | Compatibility, regression thresholds and per-scenario deltas |
| `src/evals/cli.ts` | Selectors, tier, repeats, budget and coordinator lifecycle |
| `src/evals/probes.ts` | Protected legacy probe execution in disposable context |
| `src/tools/observe.ts` | Handler observation wrapper and event types, independent of evals |
| `src/tools/context.ts`, `src/tools/index.ts` | Optional observation sink and wrapper registration |
| `src/agent/runtime.ts` | Optional observation and stricter eval limit controls, same default path |
| `evals/scenarios/*.json` | Reviewed seeds, messages and independent outcome expectations |
| `evals/recordings/*.json` | Reviewed real recordings with provenance and symbolic IDs |
| `evals/judge/rubric.md`, `evals/judge/labels.json` | Frozen rubric and blind manual labels |
| `evals/results/<run-id>/` | JSON, summary, mutation ledger, sanitized output and source diffs |
| `evals/baseline.json` | Explicitly accepted full live report reference and comparison policy |

Each implementation module gets a colocated `.test.ts` only where it guards behaviour. I will
not create mirror tests merely asserting object construction. `src/evals/types.ts` will reuse
the tool layer's event type instead of creating competing event definitions.

## Task 1: disposable execution and protected prerequisites

I found during implementation that the legacy cost and session-store probes make direct SDK
calls without reading the configured budget. I will finish and review this task's database
and output-protection modules first. The paid launcher and live prerequisite steps below
depend on task 5's query-level budget accounting and will run immediately after that is
available, before any live scenario or judge run. They remain unchecked until executed.

The first implementation review found failure paths that could strand resources and a URL
normalization hole in the DB safety check. A scoped fix and re-review are in progress; task 1
is not complete until they pass.

- [x] Approve the spec, its budget limitation and phase boundaries before code.
- [ ] Obtain an explicit live spending cap before paid calls.
- [ ] Inspect installed SDK handler types, query result usage and budget implementation before
  finalizing adapters. Verify official docs if local source is insufficient. Record the exact
  package version and source locations, not an assumed API surface.
- [ ] Write `database.test.ts`: reject the normal database URL; provision and migrate two
  sandboxes; prove one cannot read the other's marker or connect to the normal DB; force an
  interrupted worker and check exact cleanup. No broad `DROP` by prefix.
- [ ] Run the targeted tests red, implement the manifest, role grants and cleanup, then rerun.
  Mutate the isolation restriction and cleanup ownership check separately; require the
  matching tests to fail behaviourally before restoring.
- [ ] Write `probes.test.ts` using a fake child that emits a split API key, split bot token and
  raw error on stderr. Capture both streams without exposing them, scrub known secret values
  and existing redactor patterns before rendering, preserve process exit and timeout status.
  Mutate each scrub path and prove the fake secrets appear only in the failed assertion.
- [ ] Keep the redactor layering intact: extract the existing pure redactor to a shared module
  with a compatibility re-export if needed, rather than importing Telegram from agent/tools.
  Include only that extraction, without changing production redaction policy in this phase.
- [ ] Add `pnpm eval:probes` with a disposable DB and SDK directory containing no real `.env`.
  Supply only the required model key and dummy Telegram token; copy only required skill files
  when a probe needs them. Sanitize stdout, stderr and retained transcript evidence.
- [ ] Execute `pnpm eval:probes --budget-usd <approved-cap>`: cost, session store, e2e, security.
  Internally invoke `pnpm tsx src/agent/cost.probe.ts`, then `session-store.probe.ts`, then
  `e2e.ts`, then `security.probe.ts`, all under the protected context.
- [ ] Record Q1/Q2/Q3, session B and C, each of 13 e2e outcomes, and all security attempts in
  a results file and Known Gotchas. If semantics contradict code or remain inconclusive, stop
  cost acceptance and write a focused correction/probe plan. Do not silently change constants.

Validation command: `pnpm exec vitest run src/evals/database.test.ts src/evals/probes.test.ts`.
The fake-child tests make no model call. Live probe results must include actual model and code
revision. This task cannot rely on the legacy script's final PASS line alone.

## Task 2: observe actual tool execution and model usage

- [ ] Write a handler test that returns `insufficient_stock`: assert call ID, name, inputs,
  ordered start/end, refusal result and unchanged handler return. Test thrown errors, duplicate
  calls and context separation, plus an observer that throws.
- [ ] Add the optional context sink and wrap `STORE_TOOLS` at registration. Replay must use the
  same wrapper and validate arguments against its schema; it cannot call repositories directly.
- [ ] Extend runtime result observation to include SDK attempts, actual model usage, outcome and
  token counts. Preserve defaults and unknown-cost semantics; capture any retry under the same
  coordinator reservation. A dropped resume must not erase previous spend evidence.
- [ ] Add tests for two attempts with identical names, a forbidden built-in attempt, missing
  results and resume retry costs. Mutate result capture, attempt capture and retry accounting
  separately; record failed assertions and restored passes.

Validation commands: `pnpm exec vitest run src/tools/observe.test.ts src/agent/runtime.test.ts`
and `pnpm typecheck`. Observer failure must not falsify an eval, and normal runs without a sink
must retain existing behaviour.

## Task 3: scenario schema, seed and deterministic assertions

- [ ] Define all strict scenario and report types before the worker. Define fixture references
  for products, bills, customers and generated artifacts, with no SQL or JavaScript in data.
- [ ] Write schema tests for duplicate IDs, nonexistent references, fractional paise, unsafe
  integers, illegal units, unknown tags/expectation variants and empty expectations. Remove
  each relevant validation guard in turn and require its test to fail.
- [ ] Implement migrations and explicit fixture seeding, including ledger/balance consistency,
  dated history and sentinel store. Snapshot state before every message and after every result.
- [ ] Implement database assertions with explicit expected constants; cover stock movements,
  line-level money/tax, ledger entries, refusal no-op, preferences and artifact contents.
- [ ] Write negative grader tests where the reply sounds correct but stock, tax, khata, payment,
  tool order or a forbidden call is wrong. Change an assertion to accept the wrong value,
  observe the test failure, then restore it. No expected value may call production tax logic.
- [ ] Grade clarification structure separately from semantic quality. Test that a question mark
  following a completed guessed sale fails; test that a candidate lookup alone does not pass.
- [ ] Test grounding after a declared external change and invalidate an analytics day-boundary
  crossing. Test preservation of business state across a real session reset.

Validation command: `pnpm exec vitest run src/evals/scenario.test.ts src/evals/seed.test.ts
src/evals/assertions.test.ts` (one shell line). Record a test-to-mutation map as each test lands.

## Task 4: replay and recording integrity

- [ ] Write a synthetic recording that opens, edits and finalizes a bill; execute its real tools
  and assert independent final state. Label it synthetic, never an observed agent success.
- [ ] Test symbolic IDs, reused IDs, two same-named products, unknown tool names, schema-invalid
  arguments and cross-store bill IDs. Unknown references fail instead of being guessed.
- [ ] Replay checks actual results against normalized recordings and scenario outcomes. It
  must fail when a canned success disagrees with the database or the current handler result.
- [ ] Add a test forbidding model-adapter initialization or provider calls in replay mode.
  Remove that separation and verify the test catches attempted model access.
- [ ] Mutate reference binding, result comparison and real-handler execution one at a time;
  verify targeted failures. Restore and rerun only affected tests.

Validation command: `pnpm exec vitest run src/evals/replay.test.ts`.

## Task 5: coordinator, budgets, reports and CLI

- [ ] Write budget tests with deterministic fake usage: exact limit, insufficient reservation,
  unknown timeout cost, result followed by throw, retry, judge spend and interrupt. No negative
  refund and no new call after the ledger exhausts admission capacity.
- [ ] Implement sequential fresh workers and validate IPC events. Allocate no subsequent work
  until the previous reservation is settled or conservatively charged.
- [ ] Connect task 1's protected probe launcher to query-level accounting for every direct SDK
  call. Return to the pending task 1 live prerequisites before any live scenario or judge run.
- [ ] Write CLI tests for zero matches, invalid repeat/budget values, mutually incompatible
  flags, duplicate scenario IDs, missing live key and default replay mode. All fail preflight.
- [ ] Report planned versus completed attempts, pass@1, mean attempt pass rate, all-N rate,
  flaky IDs, cost, tokens, turns, calls and elapsed time. Test an example with mixed outcomes
  and an aborted repeat so denominator errors cannot create an improvement.
- [ ] Write atomic JSON/Markdown and flush partial reports on worker crash, budget exhaustion,
  SIGINT and cleanup failure. Capture metadata and sanitized command before execution.
- [ ] Mutate admission comparison, unknown-cost handling, retry charging, denominator and
  partial status separately; each corresponding test must fail for the intended reason.
- [ ] Add `pnpm eval` and selector flags. Run a complete synthetic replay locally without keys,
  clearly reporting that it is a grader test rather than a live baseline.

Validation command: `pnpm exec vitest run src/evals/budget.test.ts src/evals/cli.test.ts
src/evals/report.test.ts` (one shell line).

## Task 6: implement and review the full scenario inventory

- [ ] Write the 50 scenarios from the spec, grouped into inventory, billing, khata, analytics,
  artifacts, preferences, languages and adversarial JSON files. Use at least five hard cases
  with intermediate no-mutation assertions, not just final-state checks.
- [ ] Independently calculate expected paise and GST constants. Review each scenario against
  current tool semantics so ambiguity is genuinely present in its seed.
- [ ] Make PDF and deck cases inspect the generated files and source values, not only MIME.
  Use installed inspection helpers. If insufficient, pause for a dependency amendment.
- [ ] Add inventory coverage tests and negative evidence fixtures for every assertion family.
  Do not count schema/count tests as behavioural evidence.
- [ ] Run focused live smoke selections after prerequisites, then the full suite with N=3
  under the approved spend cap. If interrupted, retain partial evidence and request a revised
  cap only with actual spend and remaining workload stated.
- [ ] Capture and review real golden recordings; store source run, model and hashes. Require
  recordings for all accepted scenarios before claiming the full replay tier exists.

Commands after implementation: `pnpm eval --scenario oversell-single`,
`pnpm eval --tag billing`, and `pnpm eval --tier live --repeat 3 --budget-usd <approved-cap>`.
Synthetic and live results must never share an unlabeled baseline.

## Task 7: judge calibration

- [ ] Freeze a rubric for clarification, refusal semantics and tone. Require evidence spans
  from the actual response and a strict verdict schema with abstention.
- [ ] Write at least 20 blind manual labels and rationales before running the judge. Hash and
  timestamp labels. Include failures and Hindi/Hinglish; disclose that labels are agent-authored.
- [ ] Test invalid JSON, missing IDs, fabricated quotes, injected instructions in product names,
  API failures and budget exhaustion. No verdict may override a deterministic failure.
- [ ] Run the judge, report agreement, confusion matrix, abstention count and all discrepancies.
  Include one real error if observed; otherwise run a separately identified challenge set.
- [ ] Mutate schema enforcement, evidence validation, deterministic precedence and abstention
  handling; record failing tests and restored passes. A failed calibration blocks acceptance
  of semantic grading, not the independent deterministic measurements.

Validation command: `pnpm exec vitest run src/evals/judge.test.ts`. Judge model, rubric hash,
commands and actual costs belong beside the agreement table.

## Task 8: regression gate, live mutations, CI and handoff

- [ ] Test comparison compatibility and policies: any pass-rate drop, any new safety failure,
  cost increase above 10%, incomplete reports, changed seed/rubric, actual fallback use and a
  zero-cost live baseline. Mutate each guard and save the targeted red/green evidence.
- [ ] Add `pnpm eval:compare`. Never update a baseline as a side effect of a run or comparison.
- [ ] Run clean controls and the three spec mutations in disposable source copies with N=3.
  Save exact diffs, commands, hashes and before/after output. Restore and prove the clean
  source is intact. If a skill or prompt mutant survives, stop and propose a stronger measured
  experiment without pretending the requested demonstration succeeded.
- [ ] Wire replay into `.github/workflows/ci.yml` with a disposable Postgres service, no model
  key and the same locked install. Keep scheduled live runs disabled until explicitly configured.
- [ ] Write `evals/README.md` with prerequisites, local commands, tier limits, how to add a
  scenario, expected failure exits, budget caveats and cleanup recovery. Add the short README
  quality section only when it can link real evidence.
- [ ] Propose the complete live run for baseline acceptance. Until the user accepts and asks
  for a commit, keep it a candidate and describe that status in HANDOFF and todo.
- [ ] Run `pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test` and show verbatim output.
  Run replay and comparison separately and record their output. Do not claim remote CI ran
  without a real CI result; PRs and pushes remain user-controlled.
- [ ] Update HANDOFF, todo, lessons and agent_memory. Report changed files, gate output, real
  metrics with command/model/revision, every mutation, omissions, and open questions.

## Current checkpoint and decisions

The user approved both documents on 2026-10-06. Offline task 1 is in progress. This plan
contains no executed eval, judge agreement, live cost or regression demonstration. The live
spending cap is still pending. I will not begin Phase 2 while Phase 1 remains unmeasured.
