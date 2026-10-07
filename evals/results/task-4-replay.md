# Task 4: replay integrity and isolation

Date: 2026-10-07. Recording provenance is fixed to `synthetic`; these fixtures are not observed
agent behavior and are not accepted as live golden traces.

`src/evals/replay.ts` validates a strict recording schema, resolves symbolic references only from
prior real tool results, validates each argument against the registered tool's Zod shape, executes
the registered handler inside a fresh tool context, decodes its result, and checks recorded result
expectations against what the handler returned. The default registry is loaded lazily, after the
worker's disposable `DATABASE_URL` is selected. Replay does not import or initialize the agent
runtime. The test replaces the SDK provider entry point with a throwing spy and proves replay does
not call it.

The integration fixture opens a bill, adds and edits its line, and finalizes it through registered
production handlers. It verifies the persisted stock reduction and sale movement. It also proves a
sentinel-store bill ID is not visible from the owner store, and that a partial query matching two
distinct catalogue names returns an ambiguous result. Product names are distinct because the
production schema has a per-store unique-name constraint.

The one integration test uses the isolated local `eval_control` Postgres service. It sets both
database URLs explicitly to the disposable admin endpoint, provisions its own worker database,
sets the tool pool to the worker URL before loading handlers, closes that pool, then cleans the
sandbox. Credentials are never written to this report. The approved elevated runner retrieved the
dedicated service credentials in memory and emitted only Vitest output.

## Validation

Focused command: `node /private/tmp/supermarket-eval-runner.mjs replay`.

Output:

```text
 RUN  v4.1.10 /Users/divyanshu/Desktop/All Projects/supermarket-ops-agent

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  13:17:48
   Duration  4.15s (transform 57ms, setup 16ms, import 324ms, tests 3.74s, environment 0ms)
```

The original required gate passed after the isolation amendment against the explicitly configured
disposable eval database. After adding the Telegram daily-ledger regression, the latest full gate
passed 47 files and 460 tests on 2026-10-07. No model or provider call was made; model id is not
applicable.

```text
> pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test
> Newpage_assignment@1.0.0 fmt:check /Users/divyanshu/Desktop/All Projects/supermarket-ops-agent
> prettier --check .

Checking formatting...
All matched files use Prettier code style!

> Newpage_assignment@1.0.0 lint /Users/divyanshu/Desktop/All Projects/supermarket-ops-agent
> eslint .


> Newpage_assignment@1.0.0 typecheck /Users/divyanshu/Desktop/All Projects/supermarket-ops-agent
> tsc --noEmit


> Newpage_assignment@1.0.0 test /Users/divyanshu/Desktop/All Projects/supermarket-ops-agent
> vitest run


 RUN  v4.1.10 /Users/divyanshu/Desktop/All Projects/supermarket-ops-agent


 Test Files  47 passed (47)
      Tests  460 passed (460)
   Start at  15:11:11
   Duration  27.16s (transform 391ms, setup 213ms, import 8.06s, tests 15.82s, environment 2ms)
```

## Mutation evidence

The semantic mutations and restored outputs are listed in `evals/results/task-4-mutations.md`.
Each mutant was applied separately and restored. The DB integration passed after the final restored
source. A first integration attempt exposed a duplicate-name fixture error (the product table
enforces a unique name per store); a second attempt showed the expected bill total is 1,400 paise at
the seeded MRP. The fixture and expectation were corrected, the pool shutdown was made explicit to
avoid termination errors, and the final isolated run passed. Those failed-attempt outputs are
summarized here without preserving PostgreSQL error serialization, which can include credentials.

## Limits

This task replays a small synthetic bill recording and tests one foreign bill lookup and one
ambiguous query. The full scenario inventory, recordings from actual model runs, CLI, report
coordinator, judge, baseline, and regression comparisons are still open. No live model behavior or
quality metrics are claimed.

## Review status

The user approved the amendment spec and plan, including separate production and test-only
paths, target tuple checks that never include passwords, the `src/db/client.ts` helper, target
re-checks before each step, child-process integration, and connection-error redaction coverage.
`replayRecording` now requires an object issued by `createSandbox`; the worker validates the
worker URL before importing the database client or real tool registry. It compares only host,
port, database and user, then verifies process and instantiated pool targets before every step.
The injected handler API lives in `replay.testing.ts`, which has no production registry or
database import. Tests cover result/reference checks and a real connection error that cannot
expose the worker password.

The mutation ledger records the original behavior guards and the amendment's ownership, process,
pool, per-step, host, port, database, user, and password-redaction mutants. Each was restored and
its focused test passed. A fresh independent review originally found two issues: sandbox-
dependent replay tests did not skip when CI lacked `EVAL_TEST_DATABASE_ADMIN_URL`, and the child
worker did not re-read the persisted ownership manifest before each step. The approved amendment
fixed both. A fresh independent re-review on 2026-10-07 returned **PASS**, with no critical or
high findings. With the admin URL unset, replay tests report 5 passed and 2 provisioning tests
skipped; with the disposable eval admin URL configured, all 7 pass. The ownership-drift test
fails if the per-step check is removed because the second handler runs. See the amendment
mutation entry.
