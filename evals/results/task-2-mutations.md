# Task 2 mutation record

Date: 2026-10-06 UTC. Checkout HEAD at start: `b6ac0af`. No model calls were made, so no
model id or live cost applies. Each red run below mutated production code temporarily, ran the
listed focused test, then restored the code. The final focused suite passed 28/28.

| Behavior guard | Deliberate mutation | Red evidence | Restored evidence |
| --- | --- | --- | --- |
| Observer captures the actual result | Omitted `result: redact(result)` from the event | `pnpm exec vitest run src/tools/observe.test.ts -t 'keeps identical calls distinct'` failed: expected the returned content object, received `undefined` | Same command passed 1 test, 4 skipped |
| Handler result is unchanged despite sink failure | Returned `undefined` instead of the original result | `pnpm exec vitest run src/tools/observe.test.ts -t 'preserves the exact returned object'` failed: expected original object, received `undefined` | Same command passed 1 test, 4 skipped |
| Sink failures do not replace business behavior | Removed catches around observer callbacks | `pnpm exec vitest run src/tools/observe.test.ts -t 'sink throws'` failed both result and throw-preservation tests; sink error replaced the original outcome | Restored implementation; final focused suite passed |
| Context sinks stay isolated | Forced context observer lookup to `undefined` | `pnpm exec vitest run src/tools/observe.test.ts -t 'observes only the context'` failed: expected 1 event, received 0 | Restored implementation; final focused suite passed |
| No-sink calls preserve the original behavior | Returned `undefined` on the no-observer path | `pnpm exec vitest run src/tools/observe.test.ts -t 'no-sink calls unchanged'` failed: expected original result, received `undefined` | Restored implementation; final focused suite passed |
| Identical tool calls stay distinguishable | Replaced random call IDs with one constant | `pnpm exec vitest run src/tools/observe.test.ts -t 'keeps identical calls distinct'` failed because both IDs were `constant-call-id` | Same command passed 1 test, 4 skipped |
| Event boundaries are ordered | Set the returned event end order equal to its start order | Same repeated-call command failed: `expected 1 to be less than 1` | Restored implementation; final focused suite passed |
| Model tool attempts are captured | Disabled insertion of assistant tool-use blocks | `pnpm exec vitest run src/agent/runtime.test.ts -t 'keeps repeated registered tool names distinct'` failed: expected two calls, received an empty list | Restored implementation; final focused suite passed |
| Missing SDK tool result remains visible | Initialized calls as `returned` instead of `pending` | Same repeated-tool test failed because the call without a result was marked returned | Restored implementation; final focused suite passed |
| Built-in attempts are classified separately | Classified all tool-use blocks as MCP calls | `pnpm exec vitest run src/agent/runtime.test.ts -t 'forbidden built-in attempt'` failed: expected `builtin`, received `mcp` | Same command passed 1 test, 22 skipped |
| Failed-resume spend survives a fresh retry | Removed `failedAttemptCharge` from returned turn cost | `pnpm exec vitest run src/agent/runtime.test.ts -t 'retains failed-resume attempt evidence'` failed: expected $0.25, received $0.20 | Same command passed 1 test, 22 skipped |

The no-result resume-start case has unknown SDK usage. Runtime accounting charges the configured
per-run cap conservatively for that failed attempt; the attempt evidence keeps actual SDK `costUsd`
as `null`. This is a budget charge, not a claim about provider-reported cost.

Final task check:

```text
pnpm exec prettier --check <8 affected files>  # All matched files use Prettier code style!
pnpm exec eslint <8 affected files>            # exit 0
pnpm exec vitest run src/tools/observe.test.ts src/agent/runtime.test.ts
 Test Files  2 passed (2)
      Tests  28 passed (28)
pnpm typecheck                                  # exit 0
```

## Follow-up fixes after review

I added guards for tool results that omit `is_error`, explicit model attribution from assistant
messages and `modelUsage`, SDK hook execution outcomes by `tool_use_id`, and preserved evidence if
both a resumed run and its fresh retry fail. I ran these deliberate mutations on the updated code:

| Guard | Mutation | Red output | Restored output |
| --- | --- | --- | --- |
| A tool result without `is_error` still marks the matching attempt returned | Required `is_error` to exist before matching the result | `pnpm exec vitest run src/agent/runtime.test.ts -t 'keeps repeated registered tool names'` failed: expected `resultState: returned`, received `pending` | Same focused test passed after restoring the optional-field guard |
| Model attribution retains all model IDs in a fallback attempt | Removed insertion into `modelIds` | `pnpm exec vitest run src/agent/runtime.test.ts -t 'retains explicit model IDs'` failed: expected primary and fallback IDs, received `[]` | Same focused test passed after restoration |
| Hook outcomes arriving before streamed assistant blocks remain correlated by SDK ID | Dropped pending hook outcomes when no attempt block was present yet | `pnpm exec vitest run src/agent/runtime.test.ts -t 'records completed same-name calls'` failed: both calls remained pending | Same focused test passed after restoration |
| Failed resumed and retry attempts retain a conservative total charge | Replaced the summed attempt charge with zero | `pnpm exec vitest run src/agent/runtime.test.ts -t 'preserves both attempts'` failed: expected `$1`, received `$0` | Same focused test passed after restoration |

The SDK's declared `PostToolUseHookInput` provides `tool_use_id`, `tool_response`, and optional
`duration_ms`; its `PostToolUseFailureHookInput` also provides `tool_use_id` and optional duration.
The installed SDK implementation runs a registered MCP handler and then supplies the handler's
response to the PostToolUse hook. Runtime evidence joins these outcomes to model attempts using the
SDK ID, including repeated same-name calls. The local wrapped-handler observer does not receive
that ID. Its random `callId` remains a separate, unjoined observation; I do not infer a mapping by
argument equality or callback timing.

The retry-failure error now exposes both attempt records and
`conservativelyChargedTurnCostUsd`. This is worst-case budget accounting when either failed attempt
has unknown usage, not a claim about actual provider cost.

Restored focused verification:

```text
pnpm exec prettier --check src/agent/runtime.ts src/agent/runtime.test.ts
Checking formatting...
All matched files use Prettier code style!

pnpm exec vitest run src/agent/runtime.test.ts
 Test Files  1 passed (1)
      Tests  25 passed (25)

pnpm typecheck
exit 0
```

### Follow-up precedence corrections

The PostToolUse success and PostToolUseFailure hook states need different precedence. The SDK
failure hook remains authoritative over a contradictory non-error protocol block, while explicit
protocol `is_error: true` upgrades a PostToolUse success to failed.

| Guard | Mutation | Red output | Restored output |
| --- | --- | --- | --- |
| Preserve PostToolUseFailure against a non-error protocol block | Removed the `sdkExecutionFailed` guard so protocol data always overwrites hook state | `pnpm exec vitest run src/agent/runtime.test.ts -t 'preserves a PostToolUseFailure'` failed: expected failed/true, received returned/false | Same focused test passed after restoration |
| Allow explicit protocol error to override PostToolUse success | Allowed protocol override only when no SDK execution exists | `pnpm exec vitest run src/agent/runtime.test.ts -t 'lets explicit protocol is_error'` failed: expected failed/true, received returned/false | Same focused test passed after restoration |

After restoring both guards, `pnpm exec vitest run src/agent/runtime.test.ts` passed 27/27,
`pnpm typecheck` exited 0, `pnpm exec eslint src/agent/runtime.ts src/agent/runtime.test.ts`
exited 0, and `pnpm exec prettier --check src/agent/runtime.ts src/agent/runtime.test.ts`
reported all matched files formatted.
