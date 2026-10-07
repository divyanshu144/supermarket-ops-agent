# Tasks 5–8 offline checkpoint

Every result in this file is synthetic or a local test result. I did not call a model, read
`.env`, run a probe, contact Telegram/Railway, or accept a baseline. SDK cost semantics remain
unverified.

## What is implemented

- `EvalBudget` admits integer micro-USD reservations and charges the full reservation when
  usage is unknown. Its unit tests cover exact-cap admission, exhausted admission, invalid
  refunds, and duplicate settlement.
- `summarizeAttempts` keeps missing repetitions in the all-N denominator and labels reports
  `synthetic`; it reports pass@1, all-N, flaky IDs and synthetic cost fields.
- `compareWithBaseline` and `pnpm eval:compare` refuse comparison before reading either file.
  There is no accepted baseline and no synthetic report can become one.
- Task 4 review amendments have a fresh independent PASS. The CI-shaped run of the replay
  tests passed 5 and skipped 2 tests requiring `EVAL_TEST_DATABASE_ADMIN_URL`.

## What remains incomplete

The fake budget/report tests are not a sequential coordinator, do not execute an end-to-end
scenario suite, and do not supply a live CLI. The 50 reviewed scenarios, tool-backed synthetic
replay inventory, artifact assertions over scenarios, 20 blind judge labels, judge agreement,
real judge error, and three requested model/prompt/skill mutation demonstrations are not
implemented or measured here. CI already runs the repository test suite, including replay
unit tests; I did not add a separate replay workflow command because there is not yet a full
scenario replay CLI. Therefore Tasks 5–8 are not complete and there is no honest pass-rate or
judge metric to publish.

## Synthetic test output

Command: `pnpm exec vitest run src/evals/budget.test.ts src/evals/report.test.ts src/evals/compare.test.ts src/evals/replay.test.ts`

```text
Test Files  4 passed (4)
     Tests  9 passed | 2 skipped (11)
```

Date: 2026-10-07. Model: none. Source revision: working tree based on `bb5ab8e` (uncommitted).
These are local test counts, not agent quality metrics.

## Complete verification gate

The repository gate passed on 2026-10-07 against the local Postgres test service. Command:

```sh
DATABASE_URL=postgres://kirana:kirana@localhost:5435/kirana pnpm fmt:check && DATABASE_URL=postgres://kirana:kirana@localhost:5435/kirana pnpm lint && DATABASE_URL=postgres://kirana:kirana@localhost:5435/kirana pnpm typecheck && DATABASE_URL=postgres://kirana:kirana@localhost:5435/kirana pnpm test
```

```text
Checking formatting...
All matched files use Prettier code style!

> eslint .
> tsc --noEmit
> vitest run

Test Files  50 passed (50)
     Tests  452 passed | 13 skipped (465)
  Start at  15:30:34
  Duration  21.11s (transform 353ms, setup 230ms, import 8.01s, tests 9.58s, environment 2ms)
```

Model: none. Revision: uncommitted worktree based on `bb5ab8e`. I used no provider credentials.

## Mutation checks

- Budget exact-cap guard changed from `>` to `>=`: targeted test failed, 2 failed. Restored;
  targeted test passed in the full synthetic command above.
- All-N completeness check removed: report test failed with expected 0, received 0.5. Restored;
  targeted test passed in the full synthetic command above.
- Baseline refusal replaced with a resolved promise: comparison test failed because the promise
  resolved. Restored; targeted test passed in the full synthetic command above.
- Task 4 ownership verification removed before each step: the replay drift test failed because
  the second handler ran. Restored; see `task-4-mutations.md`.

## Live runbook after credits are available

Do not run the following until credits exist and the operator has set an aggregate cap. Run
from the repository root, with the actual credentials already configured in the local shell;
never paste credentials. Capture sanitized output only.

1. Confirm the active branch and clean source revision with `git status --short --branch` and
   `git rev-parse HEAD`.
2. Run in order, stopping on the first failure:

   ```sh
   pnpm tsx src/agent/cost.probe.ts
   pnpm tsx src/agent/session-store.probe.ts
   pnpm tsx src/agent/e2e.ts
   pnpm tsx src/agent/security.probe.ts
   ```

   Paste the sanitized Q1/Q2/Q3 cost output, session-store B and C output, all 13 e2e beat
   outcomes, and each security attempt/result. Do not paste keys, bot tokens, raw environment,
   or unredacted logs. A failed or inconclusive cost probe means stop: there is no live eval
   command to run yet and no comparison/baseline acceptance.
3. Once cost semantics are documented and a live coordinator exists, run one attempt each for
   five reviewed scenarios: one stock or money refusal, a multi-step bill, ambiguity, preference
   persistence across `/new`, and Hindi/Hinglish. Configure an aggregate cap of **$0.25** for
   this smoke, with a per-attempt reservation no larger than **$0.05**, and stop if the runner
   cannot enforce both before each provider query. This cap is an operator proposal for a future
   smoke, not authorization to run now and not a guarantee of provider billing.
4. Paste the sanitized JSON and Markdown reports, selected scenario IDs, `N=1`, model ID,
   source commit, actual reported spend, conservative reserved spend, wall time, turns, tool
   calls, and any partial/aborted status. Do not call this a baseline. The current branch does
   not yet implement this runner command; finish and review Tasks 5–8 offline before attempting
   step 3. A baseline remains prohibited until cost semantics are verified and the full live
   acceptance set runs with N=3 under a separately approved cap.
