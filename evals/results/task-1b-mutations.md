# Task 1b mutation record

Date: 2026-10-06. Repository HEAD before this task: `b6ac0aff4d092f761525be4897c684f1d1d7d845`. The working tree was already dirty with approved Phase 1 docs, Task 1a changes, and an unrelated untracked `Claude outputs/` directory. I did not edit or inspect that directory. Model id: not applicable; this task used no model/provider calls.

I mutation-checked each new behavioral test by temporarily removing or weakening its named guard in the implementation, ran only that test, observed a semantic assertion failure, and restored the guard. These edits were temporary and are not present in the final source. Commands used for every red run:

```sh
pnpm exec vitest run src/evals/probes.test.ts -t '<test name below>'
```

| Test | Temporary mutation | Red output (assertion excerpt) |
| --- | --- | --- |
| `redacts API keys split between writes` | Removed `String(redact(safe))` from the sanitizer. | `AssertionError: expected "sk-ant-api03-abcdefghijklmnop café" not to contain "sk-ant-"`. |
| `decodes UTF-8 characters split between output chunks` | Decoded each Buffer independently before joining instead of concatenating bytes first. | `AssertionError: expected 'caf\\ufffd\\ufffd' to be 'café'`. |
| `redacts Telegram tokens split between writes` | Replaced the Telegram token expression with a nonmatching marker. | **Invalid evidence, superseded below.** The original test wrote the token to stderr, which the protected runner discards by policy; that test could not detect a broken token redactor. |
| `redacts exact opaque configured secrets even when split between writes` | Removed literal configured-secret replacement. | Expected `receipt [redacted] done`; received `receipt opaque::secret/with?symbols done`. |
| `sanitizes stderr URLs and does not return raw exception text` | Returned the sanitized string without masking URLs. | Assertion expected `[redacted-url]`; received stderr containing `https://user:pass@example.invalid/path?token=abc`. |
| `reports a nonzero exit with captured sanitized output` | Replaced observed exit code assignment with `null`. | `AssertionError: expected null to be 7`. |
| `terminates on timeout and returns no partial diagnostics` | Added 500 ms to the requested timeout. The test child exits naturally at 300 ms. | `AssertionError: expected 'completed' to be 'timeout'`. |
| `terminates on interruption and returns no partial diagnostics` | Changed the abort handler to a no-op. The test child exits naturally at 300 ms. | `AssertionError: expected 'completed' to be 'interrupted'`. |
| `terminates on output limit and discards all captured output` | Disabled the output-size comparison. The test child exits naturally at 300 ms. | `AssertionError: expected 'completed' to be 'output-limit'`. |
| `classifies spawn failure without exposing the command or raw error` | Changed the child `error` event to leave status as `completed`. | `AssertionError: expected 'completed' to be 'spawn-error'`. |
| `copies only explicitly allowlisted environment keys` | Initialized the child environment from `{ ...process.env }`. | Expected only `{ allowed: 'visible-marker' }`; actual output also contained the deliberately set `TELEGRAM_BOT_TOKEN` and `DATABASE_ADMIN_URL` dummy values. |

After restoring every mutation, this command passed:

```sh
pnpm exec vitest run src/evals/probes.test.ts src/telegram/redact.test.ts
```

```text
 Test Files  2 passed (2)
      Tests  18 passed (18)
   Start at  23:00:54
   Duration  580ms (transform 24ms, setup 20ms, import 24ms, tests 390ms, environment 0ms)
```

No mutation caused a syntax or import failure. No mutation remains in the source.

## Review follow-up

Date: 2026-10-06. HEAD remains `b6ac0aff4d092f761525be4897c684f1d1d7d845`; the repository is dirty with the pre-existing Phase 1 work and these uncommitted task 1b files. Model id: not applicable. No live provider calls were made.

The review identified three additional leak guards. I mutation-checked each guard with the focused command shown below, restored it, and then ran the full focused suite.

| Test | Temporary mutation | Red output (assertion excerpt) |
| --- | --- | --- |
| `redacts PostgreSQL URLs with credentials from stdout` | Narrowed the URI matcher to `https?://`, leaving PostgreSQL schemes unmatched. | `AssertionError: expected 'db=postgresql://worker:super-secret@db.example.invalid:5432/store' to be 'db=[redacted-url]'`. The same output visibly retained the dummy credential and host. |
| `suppresses raw stderr exception text and URLs` | Replaced the empty stderr result with a fixed diagnostic marker on successful exit. | `AssertionError: expected '[raw stderr would escape]' to be ''`. The fixture writes an exception and a credential-bearing HTTPS URL to stderr, and neither is returned after restoration. |
| `redacts values of allowlisted credential environment variables` | Changed the sensitive-name matcher to a regex that never matches. The fixture's database URL variable contains an opaque non-URL marker so URI filtering cannot satisfy this guard. | `AssertionError: expected 'opaque-eval-password-marker' to be '[redacted]'`. |

Commands used for each red run:

```sh
pnpm exec vitest run src/evals/probes.test.ts -t 'redacts PostgreSQL URLs with credentials from stdout'
pnpm exec vitest run src/evals/probes.test.ts -t 'suppresses raw stderr exception text and URLs'
pnpm exec vitest run src/evals/probes.test.ts -t 'redacts values of allowlisted credential environment variables'
```

After restoring all three guards:

```sh
pnpm exec prettier --write src/evals/probes.ts src/evals/probes.test.ts && pnpm exec vitest run src/evals/probes.test.ts src/telegram/redact.test.ts && pnpm lint && pnpm typecheck
```

```text
 Test Files  2 passed (2)
      Tests  20 passed (20)
   Start at  23:05:18
   Duration  618ms (transform 25ms, setup 20ms, import 25ms, tests 437ms, environment 0ms)

> Newpage_assignment@1.0.0 lint /Users/divyanshu/Desktop/All Projects/supermarket-ops-agent
> eslint .

> Newpage_assignment@1.0.0 typecheck /Users/divyanshu/Desktop/All Projects/supermarket-ops-agent
> tsc --noEmit
```

No mutation remains in the source. The stderr policy is suppression, not text sanitization: the child stderr pipe is drained and counted toward the output cap but never retained or returned.

## Telegram redaction evidence correction

The original Telegram-token row above was vacuous because the fixture wrote to stderr. I changed the fixture to write one token across two stdout chunks and assert that the actual returned stdout is exactly `token=[redacted]`. I then replaced the Telegram-token regex in `src/shared/redact.ts` with `/NEVER_MATCH_TELEGRAM_TOKEN/g` and ran:

```sh
pnpm exec vitest run src/evals/probes.test.ts -t 'redacts Telegram tokens split between stdout writes'
```

It failed on the behavioral assertion, returning the full dummy token:

```text
 FAIL  src/evals/probes.test.ts > runProtectedChild > redacts Telegram tokens split between stdout writes
AssertionError: expected 'token=7891234560:AAHkq2LpXvBn3RtYw8Zc…' to be 'token=[redacted]'
Expected: "token=[redacted]"
Received: "token=7891234560:AAHkq2LpXvBn3RtYw8ZcQe1FgH5JmNoPqRs"
```

I restored the regex and reran the focused test. It passed:

```text
 ✓ src/evals/probes.test.ts (13 tests | 12 skipped) 32ms
 Test Files  1 passed (1)
      Tests  1 passed | 12 skipped (13)
   Start at  23:07:26
   Duration  137ms (transform 19ms, setup 15ms, import 17ms, tests 32ms, environment 0ms)
```
