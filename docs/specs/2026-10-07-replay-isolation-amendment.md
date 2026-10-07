# Replay isolation amendment

Status: approved by the user on 2026-10-07; both review corrections received a fresh
independent PASS on 2026-10-07.

## Finding

The first Task 4 review approved replay behavior except for a critical isolation gap:
`replayRecording()` can load the production tool registry and call repositories through the
process-wide database pool. Its integration test selected a disposable database, but the API did
not require that boundary. Another caller could replay against whatever `DATABASE_URL` is active.

## Proposed correction

I will split the API into a real-handler replay entry point and a test-only injected-tools path.
Real-handler replay requires a sandbox returned by `createSandbox()` and rejects a missing or
unowned sandbox. Before loading handlers, it proves that `DATABASE_URL` targets that sandbox.
After loading the repository pool, it compares only host, port, database, and user against the
sandbox worker URL. It never compares, logs, or reports passwords. If the pool was initialized for
another target, replay fails before any handler runs. `src/db/client.ts` will expose the small,
read-only helper needed to return the pool's non-secret connection target; repository behavior
does not change.

Real-handler replay re-checks sandbox ownership, process URL, and pool target immediately before
every recorded step. The eval worker runs one scenario repetition in a fresh child process initialized
with the worker URL. Replays stay serial within that child, and the coordinator owns sandbox
creation and cleanup. A recording contains no connection string. Missing, forged, stale, and
mismatched sandbox bindings must fail before handlers. The provider-call trap and result/reference
checks remain.

The integration test will spawn a child process with the worker URL instead of changing
`DATABASE_URL` in the test runner. A separate redaction test forces a sandbox connection error and
asserts its text never contains the worker password. Captured errors expose a fixed safe message
and error class/code only.

## Boundaries

This stays inside Phase 1 replay isolation. It does not add a coordinator, alter business rules,
relax the dedicated-Postgres requirement, or allow replay against the normal database. No database
URL or credential is written to a recording or report.

## Validation

I will mutation-check sandbox ownership, active URL comparison, pool-target comparison, and the
per-step re-check separately. Each bypass must execute no handler and fail its focused test. Then
I will rerun the child-process synthetic bill, foreign bill lookup, schema/reference checks,
provider-call trap, connection-error password check, and the required full gate against the
explicitly named disposable `eval_control` service. A fresh independent review will check the
boundary before Task 5 consumes replay.

## Fresh review follow-up: revised boundary

An independent review on 2026-10-07 returned **block** with two findings. First, the two tests
that provision a sandbox currently run unconditionally, but CI has only one ordinary Postgres
service and does not set `EVAL_TEST_DATABASE_ADMIN_URL`. Second, the child worker rechecks the
process and pool target before every step but cannot recheck that the sandbox's persisted
ownership manifest is still live. The parent checks its private `WeakMap` binding only once.

The amendment must be revised before more replay code is changed. I propose to:

1. Put only the real sandbox connection-error and registered-handler integration tests behind a
   `skipIf` guard for absent `EVAL_TEST_DATABASE_ADMIN_URL`. Keep schema, target-comparison,
   redaction, and injected-tool tests running in CI.
2. Pass a non-secret worker-verifiable sandbox binding from the parent to the child, derived only
   from the exact `createSandbox()` object in the private ownership map. Before each step, the
   worker must re-read and validate the persisted manifest's ready state and bound database/role,
   alongside process and pool targets. Never put the worker password into this proof or its
   diagnostics.
3. Add a test where the ownership manifest becomes invalid after the first step and prove that
   the second handler is never called. Mutation-check that guard separately.
4. Run the replay test file with the CI-like single-service environment: `DATABASE_URL` set and
   `EVAL_TEST_DATABASE_ADMIN_URL` unset. Verify provider-free tests pass and only database-bound
   cases skip. Then run the dedicated-service child integration and full gate.

The previous implementation and its Task 4 gate remain an interim result only. Do not consume
replay from Task 5 until the revised plan is approved, these checks pass, and a fresh independent
review gives a non-blocking verdict.
