# Replay isolation amendment plan

> Status: user approved the replay-isolation additions on 2026-10-07. The fresh independent
> review of both corrections passed on 2026-10-07 with no critical or high findings.

**Spec:** [Replay isolation amendment](../specs/2026-10-07-replay-isolation-amendment.md).

## Work sequence

1. Split replay into a real-handler entry point and a test-only injected-tools path. Ensure the
   injected path cannot import or reach production repositories.
2. Add unforgeable ownership tracking for sandbox objects returned by `createSandbox()` and
   expose a read-only validation helper that checks manifest/worker URL identity without exposing
   credentials.
3. In `src/db/client.ts`, expose only the pool's non-secret target tuple: host, port, database,
   and user. Compare this tuple with the sandbox worker URL. Never compare or log a password.
4. Require the real-handler API to receive an owned sandbox. Compare the process URL before
   loading tools, then compare the instantiated pool target. Re-check all target fields and
   sandbox ownership immediately before each recorded tool step. Fail before invoking any handler
   on mismatch.
5. Run the real integration test in a spawned child process initialized with the worker URL.
   Add a test that induces a sandbox connection error and asserts the rendered error never
   contains the worker password.
6. Add tests for missing/forged sandbox, process URL mismatch, pool target mismatch, per-step
   target drift, provider calls, references, and handler results. Prove rejected paths execute no
   handler.
7. Mutation-check sandbox ownership, URL check, pool tuple check, per-step re-check, and password
   redaction separately. Record each mutant and restored result.
8. Run replay integration and the full verification gate with both URLs explicitly bound to the
   disposable `eval_control` service. Obtain fresh independent review.

## Stop conditions

- If the pool's effective target cannot be checked without exposing credentials, stop and revise.
- If the child process can inherit a non-sandbox URL or a mismatched pool, refuse to run handlers.
- Never fall back to the environment's default database target.

## Revised follow-up after independent review

The independent reviewer found that sandbox provisioning tests do not skip in single-Postgres
CI, and that the worker cannot revalidate ownership of the persisted sandbox manifest before each
step. The spec has a proposed correction; implement only after the user approves this re-plan.

1. Split the sandbox-dependent replay tests into a `describe.skipIf(!adminUrl)` block. Keep pure
   and injected-tool tests outside it.
2. Derive a worker-verifiable, non-secret ownership proof from the parent process's exact sandbox
   object and private ownership registry. Include the manifest path plus immutable binding fields
   or an equivalent integrity value. Do not include the worker URL or password.
3. In the worker, validate the persisted manifest and ready state alongside process/pool target
   tuples before the first handler and immediately before every later handler.
4. Test ownership drift between steps and assert the second handler is not invoked. Temporarily
   remove the worker ownership recheck and verify that focused test fails.
5. In the CI-like configuration (`DATABASE_URL` points to its single Postgres service and
   `EVAL_TEST_DATABASE_ADMIN_URL` is unset), run replay tests and report exact pass/skip counts.
   Then run dedicated-service integration and the full gate.
6. Obtain a fresh independent review. Task 5 must not use the replay API until this review passes.
