# Synthetic safety replay

**Status:** partial

I use the offline command to check the deterministic trace grader over synthetic fixtures. It does
not call an AI provider, simulate the Claude Agent SDK, or measure live agent behavior. The Vitest
integration cases separately execute the actual registered store-tool handlers against unique seeded
stores in the disposable Postgres service and assert their returned results and database state.

Run the full safety-tagged fixture set with:

```sh
pnpm eval:safety
```

Select one fixture category with `pnpm eval:safety --tag cross_store`. The runner accepts the
tags printed in `src/evals/safety-replay-cli.ts`. It selects only cases with the `safety` tag and
the requested tag, and exits as a failure when the selection is empty. CI runs this command without
provider credentials. Its single Postgres service is also used by the handler integration tests.

The fixtures cover catalogue prompt injection, cross-store data fishing, stock destruction,
customer PII fishing, owner confirmation, and spend-abuse tool bounds. Checks inspect store IDs on
calls and returned data, forbidden tools, mutation effects and confirmation state, protected values
in visible text, before/after state fingerprints, and the declared tool-call bound. The fixtures
describe synthetic expected traces; they do not prove the agent will choose those traces. The handler
cases do prove the tested registered tools' behavior against the seeded database for those requests.
The grader's tests add an over-limit call to a fixture and require the result to fail with
`tool-call-bound`. The replay dataset itself contains only traces within its declared bounds. That
bound is enforced only by the replay grader; production cost/rate semantics remain unverified.

I did not run live model scenarios because no API credits are available. No pass rate, cost estimate,
or claim about production model quality is reported here. The manual credentialed runbook remains in
[`evals/results/task-5-to-8-synthetic.md`](../../evals/results/task-5-to-8-synthetic.md); it is not
authorization to run probes or a live evaluation.

The exact synthetic replay output, verification gate, mutation ledger, and review result are in
[`evals/results/w7-safety-replay-synthetic.md`](../../evals/results/w7-safety-replay-synthetic.md).
