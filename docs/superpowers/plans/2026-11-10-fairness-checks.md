# Customer name and language behavior measurements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic synthetic name-invariance checks, a budget-gated live language/name eval, release freshness checks, and privacy-limited runtime counters.

**Architecture:** Keep business decisions identity-free and test the registered handlers against disposable Postgres. Add a separate offline grading/report module and a live runner that refuses without a configured cap and owned sandbox. Reuse existing observer, replay, report, and database sandbox patterns.

**Tech Stack:** TypeScript, Zod, Vitest, Drizzle/Postgres, pnpm scripts, existing CI.

**Spec:** `docs/safety/fairness-plan.md` and the user-provided fairness prompt.

## Global Constraints

- Synthetic names only; do not add demographic labels or log customer text/names.
- No live model call without explicit positive `FAIRNESS_BUDGET_USD`; do not run it during this task.
- Never fall back to production Postgres or live Telegram.
- Keep all thresholds fixed before a live evaluation; report observed Wilson and Newcombe intervals.
- No claims that the system is fair, unbiased, or production-validated.

## Review Focus

- Identity must not affect amounts, confirmation, or state: handler tests compare persisted outcomes.
- Live runner must not start without budget and verified disposable DB ownership.
- Corpus edits must invalidate hash-bound reports and release gate.
- Runtime metrics must never contain customer names or message text.
- Missing, stale, malformed, or threshold-failing results must fail closed.

---

### Task 1: Identity-free business decision boundaries

**Files:** inspect tool/domain implementations and tests; add identity-free input types and focused tests.

- [ ] Add regression tests proving decision outcomes do not accept name fields and name swaps preserve outcomes.
- [ ] Run tests and verify they fail before implementation.
- [ ] Extract only the minimal identity-free decision helpers required by actual handlers; keep account selection at repository boundaries.
- [ ] Run focused tests and full suite; record exact counts.

### Task 2: Synthetic deterministic invariance harness

**Files:** `evals/fairness/corpus.json`, `src/evals/fairness*.ts`, `src/evals/fairness*.test.ts`.

- [ ] Add schema-validated synthetic corpus with at least 24 names, five business scenarios, three languages, three repeats, and `human_reviewed: false` translation metadata.
- [ ] Add hash, normalization, Wilson interval, Newcombe difference interval, comparison, and redaction tests.
- [ ] Mutation-check identity-dependent outcome and corrupt-hash paths.

### Task 3: Budgeted live runner and release check

**Files:** `src/evals/fairness-cli.ts`, report module/tests, `package.json`, CI workflow.

- [ ] Add offline runner tests for budget refusal, estimate-over-cap refusal, checkpoint/resume, and sanitized reports.
- [ ] Add live CLI requiring explicit cap and owned disposable DB; default to no live call in CI.
- [ ] Add release-check command rejecting missing, stale, wrong-hash, malformed, or below-threshold report.
- [ ] Verify corpus/report consistency in CI without provider calls.

### Task 4: Runtime aggregate counters

**Files:** observer/context/turn implementation and tests.

- [ ] Add tests that declared language buckets record only counts, durations, tool errors and clarification signals.
- [ ] Wire metrics only where language is already declared; otherwise use `unknown`; do not add detection.
- [ ] Assert emitted records cannot include inputs, results, customer text, or names.

### Task 5: Governance, verification, and PR

**Files:** safety docs, README, `CLAUDE.md`, `HANDOFF.md`, `decisions.md`, mutation ledger, todo.

- [ ] Document scope, limitations, status, thresholds, budget gate, privacy, and NOT RUN live status.
- [ ] Run mutations, focused tests, full test suite, format, lint, typecheck.
- [ ] Review diff, commit in small units, push `feat/fairness-checks`, and open a PR; do not merge or deploy.
