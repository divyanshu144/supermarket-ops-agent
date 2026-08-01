# Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three correctness gaps in the shipped agent, cut turn latency, and add Hindi and
voice input — without touching the verified §4 invariants.

**Architecture:** Additive throughout. One behaviour-preserving extraction (the Telegram turn
body) enables the voice handler. No schema migrations except Task 10. The oversell guard, the
finalize transaction and the GST arithmetic are not touched by any task.

**Tech Stack:** Node 24, TypeScript 5.9, grammY, Drizzle + Postgres 16, Zod, Vitest,
Claude Agent SDK, OpenAI Whisper (voice only).

**Source spec:** `docs/specs/2026-08-01-improvements-design.md`

## Global Constraints

- **The §4 invariant suite must pass unchanged.** `src/repositories/bills.invariants.test.ts` is
  never edited by any task in this plan. If a task appears to require editing it, stop and
  escalate.
- The verification gate is `pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test` and must
  be green before any task is reported DONE. Current baseline: **203 tests passing**.
- Money is integer paise, quantities integer base units, GST rates basis points. No floats.
- `storeId` is never a tool parameter — it comes from `requireContext()`. No task adds one.
- New tools must be added to a `*_TOOLS` **and** `*_TOOL_NAMES` array, or they fail silently
  (see `src/tools/index.ts:50-52`).
- TypeScript is pinned at `^5.9`. Do not run bare `pnpm add -D typescript`.
- Commit after each task. Never commit on `main` — this plan runs on a branch.
- Repository tests hit a real Postgres. `pnpm db:up` must be running.

---

## File Structure

**Created:**
- `src/telegram/redact.ts` — recursive secret redaction for error logging
- `src/telegram/redact.test.ts`
- `src/telegram/turn.ts` — the shared turn body, extracted from `bot.ts`
- `src/observability/log.ts` — structured turn logging
- `src/observability/log.test.ts`
- `src/media/download.ts` — Telegram file fetch
- `src/media/transcribe.ts` — speech-to-text provider surface
- `src/media/transcribe.test.ts`
- `.claude/skills/hindi/SKILL.md`
- `src/seed/catalogue.test.ts`

**Modified:**
- `src/seed/catalogue.ts` — add loose atta
- `src/telegram/bot.ts` — `bot.catch`, command guards, voice handler, use extracted turn
- `src/tools/index.ts` — `alwaysLoad: true`
- `src/config/env.ts` — `LOG_MESSAGE_TEXT`, `OPENAI_API_KEY`
- `src/repositories/bills.ts` — draft age filter, keyed `openBill`
- `src/tools/billing.ts` — expose the age filter, pass the idempotency key
- `src/repositories/analytics.ts` — `reorderSuggestions()`
- `src/tools/analytics.ts` — `reorder_suggestions` tool
- `.env.example`, `README.md`

---

### Task 1: The loose atta seed row

The resolver's ambiguity path is already correct and already unit-tested
(`src/repositories/products.test.ts:64-68`, against its own "Loose Atta" fixture). What is
missing is the same product in the **seed catalogue**, so the live bot and `src/agent/e2e.ts`
cannot demonstrate the brief's own headline example. `findStock('atta')` against a seeded store
returns exactly one row today.

**Files:**
- Modify: `src/seed/catalogue.ts`
- Create: `src/seed/catalogue.test.ts`

**Interfaces:**
- Consumes: `SeedProduct` from `src/seed/catalogue.ts:3-15`
- Produces: nothing later tasks depend on

- [ ] **Step 1: Write the failing test**

Create `src/seed/catalogue.test.ts`. This is a pure test — no database, no fixtures.

```typescript
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from './catalogue.js';

describe('seed catalogue', () => {
  // The brief's own example is "add atta -> which one, Aashirvaad 5kg or loose?". That
  // clarifying question can only happen if the seeded shop actually stocks two attas.
  it('stocks two products matching "atta" so the ambiguity path is reachable', () => {
    const matches = CATALOGUE.filter((p) => /atta/i.test(p.name) || /atta/i.test(p.brand ?? ''));
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('offers a loose atta alongside the branded pack', () => {
    const loose = CATALOGUE.find((p) => /atta/i.test(p.name) && p.isLoose === true);
    expect(loose).toBeDefined();
    // Loose, unbranded staples are GST-exempt; the branded pack is 5%.
    expect(loose!.gstRateBps).toBe(0);
    expect(loose!.unit).toBe('kg');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run src/seed/catalogue.test.ts`
Expected: FAIL — the first test finds 1 match, the second finds `undefined`.

- [ ] **Step 3: Add the row**

In `src/seed/catalogue.ts`, insert this entry into `CATALOGUE` immediately after the
`Toor Dal (loose)` entry (before the closing `];` on line 141):

```typescript
  {
    name: 'Atta (loose)',
    unit: 'kg',
    isLoose: true,
    // Same HSN as the branded pack; loose and unbranded, so GST-exempt rather than 5%.
    hsnCode: '11010000',
    gstRateBps: 0,
    costPricePaise: 3200,
    mrpPaise: 4000,
    openingBase: 25_000,
    reorderLevelBase: 8_000,
  },
```

- [ ] **Step 4: Verify it passes and nothing regressed**

Run: `pnpm vitest run src/seed/catalogue.test.ts && pnpm test`
Expected: both new tests PASS; full suite still green.

- [ ] **Step 5: Commit**

```bash
git add src/seed/catalogue.ts src/seed/catalogue.test.ts
git commit -m "fix: seed a loose atta so the clarifying-question path is reachable"
```

---

### Task 2: Error handling and secret redaction

Two defects in the same file. `src/telegram/bot.ts` installs **no `bot.catch`**, so grammY's
default handler is live: it logs the error, calls `await this.stop()`, and rethrows. That means
(a) any unhandled error stops the bot, and (b) the rethrown `BotError` carries `ctx.api.token`
into the log through Node's unhandled-rejection printer.

The four command handlers (`bot.ts:31-53`) have no try/catch, so a DB blip in `provisionStore`
reaches that default handler.

**Files:**
- Create: `src/telegram/redact.ts`, `src/telegram/redact.test.ts`
- Modify: `src/telegram/bot.ts`

**Interfaces:**
- Produces: `redact(value: unknown): unknown` — used by Task 3's logger too.

- [ ] **Step 1: Write the failing test**

Create `src/telegram/redact.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { redact } from './redact.js';

const TOKEN = '7891234560:AAHkq2LpXvBn3RtYw8ZcQe1FgH5JmNoPqRs';

describe('redact', () => {
  it('removes a value under a token-ish key', () => {
    const out = JSON.stringify(redact({ api: { token: TOKEN } }));
    expect(out).not.toContain(TOKEN);
    expect(out).toContain('[redacted]');
  });

  it('removes a bot token appearing as a bare string anywhere', () => {
    const out = JSON.stringify(redact({ message: `failed calling ${TOKEN}` }));
    expect(out).not.toContain(TOKEN);
  });

  it('removes a bot token embedded in a file-download URL', () => {
    // Telegram's getFile URL is https://api.telegram.org/file/bot<TOKEN>/path — voice input
    // would otherwise reintroduce the leak through a different property.
    const url = `https://api.telegram.org/file/bot${TOKEN}/voice/file_1.oga`;
    const out = JSON.stringify(redact({ url }));
    expect(out).not.toContain(TOKEN);
    expect(out).toContain('api.telegram.org');
  });

  it('removes Anthropic and OpenAI style keys', () => {
    const out = JSON.stringify(
      redact({ a: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345', b: 'sk-proj-abcdefghijklmno' }),
    );
    expect(out).not.toContain('sk-ant-');
    expect(out).not.toContain('sk-proj-');
  });

  it('survives a circular structure', () => {
    // BotError holds ctx, ctx holds api, and grammY objects reference back. A naive
    // recursive walk stack-overflows here instead of redacting.
    const a: Record<string, unknown> = { token: TOKEN };
    a.self = a;
    expect(() => JSON.stringify(redact(a))).not.toThrow();
  });

  it('preserves ordinary values', () => {
    expect(redact({ updateId: '42', nested: { ok: true } })).toEqual({
      updateId: '42',
      nested: { ok: true },
    });
  });

  it('keeps an Error readable', () => {
    const out = redact(new Error('boom')) as Record<string, string>;
    expect(out.message).toBe('boom');
    expect(out.name).toBe('Error');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run src/telegram/redact.test.ts`
Expected: FAIL — `Cannot find module './redact.js'`.

- [ ] **Step 3: Implement the redactor**

Create `src/telegram/redact.ts`:

```typescript
/**
 * Strips credentials out of anything bound for a log.
 *
 * This exists because grammY's `BotError` holds the whole context: `error.ctx.api.token` is the
 * bot token, and Node's unhandled-rejection printer walks that chain. Logging an error
 * unredacted puts full control of the bot into log retention.
 */

const SECRET_KEY = /^(token|api_?key|authorization|secret|password)$/i;

const SECRET_PATTERNS: RegExp[] = [
  // Telegram bot token: numeric id, colon, then a long opaque string. Matches it standalone
  // and inside a URL such as https://api.telegram.org/file/bot<TOKEN>/...
  /\d{6,}:[A-Za-z0-9_-]{30,}/g,
  // Anthropic and OpenAI keys.
  /sk-[A-Za-z0-9-]{8,}/g,
];

const REDACTED = '[redacted]';
const MAX_DEPTH = 8;

function scrubString(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';

  // grammY contexts reference themselves; without this the walk never terminates.
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      stack: value.stack ? scrubString(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : redact(item, depth + 1, seen);
  }
  return out;
}
```

- [ ] **Step 4: Verify it passes**

Run: `pnpm vitest run src/telegram/redact.test.ts`
Expected: all seven PASS.

- [ ] **Step 5: Install `bot.catch` and guard the commands**

In `src/telegram/bot.ts`, add the import beside the existing ones:

```typescript
import { redact } from './redact.js';
```

Add this helper immediately after the `WELCOME` constant (after line 29):

```typescript
/**
 * Wraps a command handler so a failure replies instead of propagating.
 *
 * Without this, an error inside provisionStore reaches grammY's default handler, which calls
 * bot.stop() — a single database blip would take the bot down mid-review.
 */
function guarded(handler: (ctx: CommandContext<Context>) => Promise<void>) {
  return async (ctx: CommandContext<Context>): Promise<void> => {
    try {
      await handler(ctx);
    } catch (error) {
      console.error(redact({ scope: 'command', chatId: String(ctx.chat.id), error }));
      await ctx.reply('Something went wrong on my side. Try that again?');
    }
  };
}
```

Widen the grammY import on line 1 to bring in the types the helper needs:

```typescript
import { Bot, type CommandContext, type Context } from 'grammy';
```

Wrap each of the four command registrations. For example `start` becomes:

```typescript
bot.command(
  'start',
  guarded(async (ctx) => {
    await provisionStore(BigInt(ctx.chat.id));
    await ctx.reply(WELCOME);
  }),
);
```

Apply the same wrapping to `help`, `new` and `reset`, keeping each body exactly as it is today.

Then add this at the very end of the file, after the `message:text` handler:

```typescript
/**
 * Replaces grammY's default handler, which logs the error, calls bot.stop() and rethrows.
 * Keeping the bot alive matters more than surfacing the failure loudly, and the redactor is
 * what keeps ctx.api.token out of the log.
 */
bot.catch((error) => {
  console.error(redact({ scope: 'bot', error }));
});
```

- [ ] **Step 6: Run the gate**

Run: `pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test`
Expected: green, 203 + 7 tests.

- [ ] **Step 7: Commit**

```bash
git add src/telegram/redact.ts src/telegram/redact.test.ts src/telegram/bot.ts
git commit -m "fix: catch bot errors instead of stopping, and redact secrets from logs"
```

---

### Task 3: Structured turn logging

The app logs only errors, so a reported problem has to be reconstructed from database state — which
shows what the agent did but never which tools it chose or why a turn took 21 seconds.

Message text is **not** logged by default. It carries customer names and amounts; the debugging
value was always in tool choice and duration.

**Files:**
- Create: `src/observability/log.ts`, `src/observability/log.test.ts`
- Modify: `src/config/env.ts`, `src/telegram/bot.ts`, `.env.example`

**Interfaces:**
- Consumes: `redact` from Task 2
- Produces: `logTurn(entry: TurnLog): void` — Task 7's voice handler reuses it via Task 6's
  extracted turn body, so no separate call is needed there.

- [ ] **Step 1: Write the failing test**

Create `src/observability/log.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logTurn } from './log.js';

let written: string[];

beforeEach(() => {
  written = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void written.push(line));
});

afterEach(() => vi.restoreAllMocks());

const base = {
  updateId: 42n,
  storeId: 7n,
  tools: ['mcp__store__get_stock'],
  durationMs: 1234,
  outcome: 'ok' as const,
};

describe('logTurn', () => {
  it('writes one line of JSON with bigints stringified', () => {
    logTurn(base);
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0]!);
    expect(parsed.update_id).toBe('42');
    expect(parsed.store_id).toBe('7');
    expect(parsed.duration_ms).toBe(1234);
    expect(parsed.tools).toEqual(['mcp__store__get_stock']);
    expect(parsed.outcome).toBe('ok');
    expect(typeof parsed.ts).toBe('string');
  });

  it('omits message text unless logging text is enabled', () => {
    logTurn({ ...base, text: 'Ramesh owes 485' }, { includeText: false });
    expect(written[0]).not.toContain('Ramesh');
  });

  it('includes message text when enabled', () => {
    logTurn({ ...base, text: 'Ramesh owes 485' }, { includeText: true });
    expect(JSON.parse(written[0]!).text).toBe('Ramesh owes 485');
  });

  it('redacts secrets that reach the error field', () => {
    logTurn({
      ...base,
      outcome: 'error',
      error: new Error('failed with 7891234560:AAHkq2LpXvBn3RtYw8ZcQe1FgH5JmNoPqRs'),
    });
    expect(written[0]).not.toContain('AAHkq2LpXvBn3RtYw8ZcQe1FgH5JmNoPqRs');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run src/observability/log.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the logger**

Create `src/observability/log.ts`:

```typescript
import { redact } from '../telegram/redact.js';

export interface TurnLog {
  updateId: bigint;
  storeId: bigint;
  tools: string[];
  durationMs: number;
  outcome: 'ok' | 'error';
  text?: string;
  error?: unknown;
}

export interface LogOptions {
  includeText: boolean;
}

/**
 * One JSON line per turn, to stdout, where Railway indexes it.
 *
 * Message text is opt-in: it carries customer names and amounts, and what debugging actually
 * needs is which tools ran and how long the turn took.
 */
export function logTurn(entry: TurnLog, options: LogOptions = { includeText: false }): void {
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    update_id: String(entry.updateId),
    store_id: String(entry.storeId),
    tools: entry.tools,
    duration_ms: entry.durationMs,
    outcome: entry.outcome,
  };

  if (options.includeText && entry.text !== undefined) line.text = entry.text;
  if (entry.error !== undefined) line.error = redact(entry.error);

  console.log(JSON.stringify(line));
}
```

- [ ] **Step 4: Verify it passes**

Run: `pnpm vitest run src/observability/log.test.ts`
Expected: four PASS.

- [ ] **Step 5: Add the env switch**

In `src/config/env.ts`, add this line to the schema object after `NODE_ENV`:

```typescript
  LOG_MESSAGE_TEXT: z.enum(['true', 'false']).optional(),
```

Then add this exported helper at the end of the file:

```typescript
/**
 * Message text is logged in development and withheld in production unless explicitly enabled,
 * so a deployed shop does not write customer names to a log aggregator by default.
 */
export function shouldLogMessageText(env: Env): boolean {
  if (env.LOG_MESSAGE_TEXT !== undefined) return env.LOG_MESSAGE_TEXT === 'true';
  return env.NODE_ENV !== 'production';
}
```

Add to `.env.example`:

```
# Log inbound message text. Defaults on in development, off in production.
LOG_MESSAGE_TEXT=false
```

- [ ] **Step 6: Verify and commit**

Run: `pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test`
Expected: green. (`bot.ts` is wired to the logger in Task 6, where the turn body is extracted —
doing it here would mean editing the same block twice.)

```bash
git add src/observability src/config/env.ts .env.example
git commit -m "feat: structured per-turn logging, message text off by default in production"
```

---

### Task 4: Remove the tool-search hop

`ToolSearch` fires before nearly every store tool. The SDK defers MCP tools behind tool search by
default; `alwaysLoad` turns that off for one server. Verified in
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:495-502`.

**Do not consolidate tools.** The brief grades the tool surface directly, and the skills name
tools verbatim with no test tying the two together.

**Files:**
- Modify: `src/tools/index.ts`

- [ ] **Step 1: Record the baseline**

Run three representative messages through the deployed or local bot and note `duration_ms` from
Task 3's log lines: a stock query, a two-item bill build, and a daily close. Write the three
numbers into the commit message. Without a before, there is no after.

- [ ] **Step 2: Set the flag**

In `src/tools/index.ts`, change the server construction (lines 30-34) to:

```typescript
export const storeToolServer = createSdkMcpServer({
  name: STORE_SERVER_NAME,
  version: '0.1.0',
  tools: STORE_TOOLS,
  // Without this the SDK defers these tools behind ToolSearch, which fires an extra model
  // round-trip before nearly every call. The set is small and entirely relevant to every turn,
  // so there is nothing to search. Costs a blocking connect at startup, capped at 5s.
  alwaysLoad: true,
});
```

- [ ] **Step 3: Verify the tool surface is unchanged**

Run: `pnpm test`
Expected: green — in particular the allowlist/registration tests in `src/tools/index.test.ts`.

- [ ] **Step 4: Measure again**

Repeat the three messages from Step 1. Record the new `duration_ms` values.

**If latency did not improve materially, say so in the commit message and stop.** Do not pursue
tool consolidation. The next lever is `AGENT_EFFORT` (`src/config/env.ts:7`, currently `medium`),
which is a config change requiring no code.

- [ ] **Step 5: Commit**

```bash
git add src/tools/index.ts
git commit -m "perf: load store tools eagerly instead of behind ToolSearch

Before: <three numbers>. After: <three numbers>."
```

---

### Task 5: The Hindi skill

Translation stays in the model. **No `aliases` column, no migration, no change to `findStock`** —
partial alias coverage teaches the model that Hindi strings are valid tool input and then fails on
the words that have no alias, and `findStock` is the single funnel for every mutating repository
call.

**Files:**
- Create: `.claude/skills/hindi/SKILL.md`

- [ ] **Step 1: Read an existing skill for house style**

Read `.claude/skills/billing/SKILL.md`. Match its frontmatter shape, its register and its length.
Skills teach how to run a shop; they do not restate tool schemas.

- [ ] **Step 2: Write the skill**

Create `.claude/skills/hindi/SKILL.md`:

```markdown
---
name: hindi
description: Use when the owner writes or speaks in Hindi, Hinglish or romanised Hindi — translating shop vocabulary to catalogue terms and replying in the language they used
---

# Hindi and Hinglish

Kirana owners code-switch constantly. "Do kilo cheeni aur ek Aashirvaad atta, Ramesh ke khaate
mein" is one ordinary sentence, not an edge case.

## Reply in the language you were spoken to

Hindi in, Hindi out. Hinglish in, Hinglish out. Romanised script in, romanised script back — do
not switch to Devanagari because the words are Hindi. Keep the same terse register you use in
English: no preamble, no translation notes, no explaining that you understood.

**Numbers and money always stay in digits.** "₹485", never "chaar sau pachaasi". "2kg", never
"do kilo". The owner is reading amounts at a counter.

## Shop vocabulary

Translate the owner's words into a catalogue query yourself, then let the tool resolve it. These
are this shop's common terms:

| Owner says | Means |
|---|---|
| cheeni, chini, shakkar | sugar |
| chawal, chaawal | rice |
| daal, dal, toor, arhar | toor dal |
| atta, aata, gehun | atta (ambiguous — see below) |
| namak | salt |
| tel | cooking oil |
| makkhan | butter |
| biskut, biscuit | biscuits |
| sabun, surf, detergent | detergent |
| doodh | milk |

This table is a starting point, not a limit. Translate any Hindi product word the same way — it
is your judgement, not a lookup.

## Numbers and quantities

ek 1 · do 2 · teen 3 · chaar 4 · paanch 5 · chhe 6 · saat 7 · aath 8 · nau 9 · das 10 ·
pav ¼ · aadha ½ · dedh 1½ · dhai 2½ · sawa 1¼ · bees 20 · pachaas 50 · sau 100

**"Do" (2) and "das" (10) sound alike and differ by a factor of five.** On a voice message, if
the quantity is at all unclear, ask before billing. A wrong quantity on a bill is worse than one
extra question.

## Shop phrases

- "khaate mein", "udhaar", "likh do" → put it on that customer's khata
- "kitna bacha hai", "kitna stock hai" → stock query
- "bill banao", "parchi banao" → open or finalize a bill
- "hisaab", "din ka hisaab" → daily close
- "kitna hua" → the running total of the current bill
- "chukta", "jama", "de diya" → a khata payment

## Ambiguity is still the tool's job

Translating "atta" gives you the English word, not the product. The shop stocks both Aashirvaad
Atta 5kg and loose atta, so `get_stock` returns candidates — ask which one, in the language the
owner used. Never pick for them because the query was in Hindi.
```

- [ ] **Step 3: Verify the skill loads**

Run: `pnpm tsx src/agent/e2e.ts`
Expected: still passes. Skills load from `.claude/skills/` via `settingSources: ['project']`; a
malformed frontmatter block makes the skill silently absent rather than erroring, so confirm the
run is clean.

- [ ] **Step 4: Try it live**

With `pnpm dev` running, send: `do kilo cheeni aur ek atta, Ramesh ke khaate mein`.
Expected: the agent resolves sugar 2kg, asks which atta, and replies in romanised Hindi.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/hindi/SKILL.md
git commit -m "feat: hindi/hinglish skill"
```

---

### Task 6: Extract the turn body

`bot.ts:55-90` carries the verified dedupe claim, the AsyncLocalStorage context, the reply and the
artifact drain. Task 7 needs the same sequence for voice. Extract it rather than duplicating it —
a second copy is a second place for the idempotency claim to drift.

This task is **behaviour-preserving**. The existing tests are the guard.

**Files:**
- Create: `src/telegram/turn.ts`
- Modify: `src/telegram/bot.ts`

**Interfaces:**
- Consumes: `logTurn`, `shouldLogMessageText` (Task 3); `redact` (Task 2)
- Produces: `handleTurn(ctx: Context, text: string): Promise<void>` — Task 7 calls this with a
  transcript.

- [ ] **Step 1: Create the module**

Create `src/telegram/turn.ts` by moving the body of the `message:text` handler verbatim, with the
message text taken as a parameter instead of read from `ctx.message.text`:

```typescript
import { InputFile, type Context } from 'grammy';
import { runAgent } from '../agent/runtime.js';
import { provisionStore } from '../repositories/stores.js';
import { claimUpdate, completeUpdate, getSessionId, setSessionId } from '../repositories/updates.js';
import { readPreferences } from '../tools/preferences.js';
import { newToolContext, toolContext } from '../tools/context.js';
import { logTurn } from '../observability/log.js';
import { loadEnv, shouldLogMessageText } from '../config/env.js';
import { redact } from './redact.js';

const env = loadEnv();

/**
 * One owner turn, whatever modality it arrived as.
 *
 * Text and voice share this because it holds the update claim and the artifact drain — the two
 * things a second copy would silently let drift.
 */
export async function handleTurn(ctx: Context, text: string): Promise<void> {
  const updateId = BigInt(ctx.update.update_id);
  const storeId = BigInt(ctx.chat!.id);
  const startedAt = Date.now();

  // Claim, don't mark done. See repositories/updates.ts for why the difference matters.
  const claim = await claimUpdate(updateId, storeId);
  if (claim === 'duplicate') return;

  await provisionStore(storeId);
  await ctx.replyWithChatAction('typing');

  try {
    const sessionId = await getSessionId(storeId);
    const preferences = await readPreferences(storeId);

    const turnContext = newToolContext(storeId, updateId);
    const result = await toolContext.run(turnContext, () =>
      runAgent({ text, sessionId, preferences }),
    );

    if (result.sessionId) await setSessionId(storeId, result.sessionId);
    await ctx.reply(result.reply || 'Sorry, I could not work that out.');

    // Files the tools produced this turn go out after the reply, so the owner reads the answer
    // first and the document lands underneath it.
    for (const artifact of turnContext.artifacts) {
      await ctx.replyWithDocument(new InputFile(artifact.path, artifact.filename));
    }

    await completeUpdate(updateId);

    logTurn(
      {
        updateId,
        storeId,
        text,
        tools: result.toolsUsed,
        durationMs: Date.now() - startedAt,
        outcome: 'ok',
      },
      { includeText: shouldLogMessageText(env) },
    );
  } catch (error) {
    console.error(redact({ updateId: String(updateId), storeId: String(storeId), error }));
    logTurn(
      {
        updateId,
        storeId,
        text,
        tools: [],
        durationMs: Date.now() - startedAt,
        outcome: 'error',
        error,
      },
      { includeText: shouldLogMessageText(env) },
    );
    await ctx.reply('Something went wrong on my side. Try that again?');
    // Deliberately NOT completed: the claim goes stale and a retry can reprocess it.
  }
}
```

- [ ] **Step 2: Reduce the handler in `bot.ts`**

Replace the whole `bot.on('message:text', …)` block (lines 55-90) with:

```typescript
bot.on('message:text', async (ctx) => {
  await handleTurn(ctx, ctx.message.text);
});
```

Add `import { handleTurn } from './turn.js';` and delete the imports `bot.ts` no longer uses:
`runAgent`, `claimUpdate`, `completeUpdate`, `getSessionId`, `setSessionId`, `readPreferences`,
`InputFile`, `newToolContext`, `toolContext`. Keep `provisionStore`, `clearSession` and
`reseedStore` — the commands still use them.

- [ ] **Step 3: Verify nothing changed**

Run: `pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test`
Expected: green. `pnpm lint` catches any import left dangling.

- [ ] **Step 4: Confirm end to end**

Run: `pnpm tsx src/agent/e2e.ts`
Expected: all thirteen beats pass, as before the extraction.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/turn.ts src/telegram/bot.ts
git commit -m "refactor: extract the turn body so voice can share it, and log each turn"
```

---

### Task 7: Voice input

```
voice note -> download -> transcribe() -> handleTurn()
```

Voice converges into the existing text path, so `runAgent` is unchanged.

**Files:**
- Create: `src/media/download.ts`, `src/media/transcribe.ts`, `src/media/transcribe.test.ts`
- Modify: `src/telegram/bot.ts`, `src/config/env.ts`, `.env.example`

**Interfaces:**
- Consumes: `handleTurn` (Task 6)
- Produces: `transcribe(audio: Buffer, mimeType: string): Promise<string>`

- [ ] **Step 1: Add the key to config**

In `src/config/env.ts`, add to the schema:

```typescript
  OPENAI_API_KEY: z.string().optional(),
```

Optional deliberately: the bot must still boot and serve text without it. Add
`OPENAI_API_KEY=` to `.env.example` with a comment that voice input is disabled when unset.

- [ ] **Step 2: Write the failing test**

Create `src/media/transcribe.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest';
import { transcribe } from './transcribe.js';

afterEach(() => vi.unstubAllGlobals());

const audio = Buffer.from('fake-ogg-bytes');

describe('transcribe', () => {
  it('posts the audio and returns the text', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ text: 'do kilo cheeni' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(transcribe(audio, 'audio/ogg', 'test-key')).resolves.toBe('do kilo cheeni');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('throws a clear error when the provider fails', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    await expect(transcribe(audio, 'audio/ogg', 'test-key')).rejects.toThrow(/transcription failed/i);
  });

  it('refuses without an API key rather than calling out', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(transcribe(audio, 'audio/ogg', undefined)).rejects.toThrow(/not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm vitest run src/media/transcribe.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement transcription**

Create `src/media/transcribe.ts`:

```typescript
const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

/**
 * Speech to text. The entire provider surface is this one function, so swapping Whisper for
 * anything else touches this file and nothing above it.
 */
export async function transcribe(
  audio: Buffer,
  mimeType: string,
  apiKey: string | undefined,
): Promise<string> {
  if (!apiKey) throw new Error('Voice input is not configured (no OPENAI_API_KEY).');

  const form = new FormData();
  form.append('file', new Blob([audio], { type: mimeType }), 'voice.oga');
  form.append('model', 'whisper-1');

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    throw new Error(`Transcription failed (${response.status}).`);
  }

  const body = (await response.json()) as { text?: string };
  return (body.text ?? '').trim();
}
```

- [ ] **Step 5: Verify it passes**

Run: `pnpm vitest run src/media/transcribe.test.ts`
Expected: three PASS.

- [ ] **Step 6: Add the download helper**

Create `src/media/download.ts`:

```typescript
import type { Context } from 'grammy';

/**
 * Fetches a file the owner sent. The download URL embeds the bot token, which is why the
 * redactor matches tokens inside URLs — an error here would otherwise log it.
 */
export async function downloadTelegramFile(ctx: Context, token: string): Promise<Buffer> {
  const file = await ctx.getFile();
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download the file (${response.status}).`);

  return Buffer.from(await response.arrayBuffer());
}
```

- [ ] **Step 7: Wire the voice handler**

In `src/telegram/bot.ts`, add after the `message:text` handler:

```typescript
/** Voice notes are ~60s of Opus at most; anything longer is a mis-tap, not a shop instruction. */
const MAX_VOICE_SECONDS = 60;

bot.on('message:voice', async (ctx) => {
  // Guard on the metadata Telegram already sent, before spending a download.
  if (ctx.message.voice.duration > MAX_VOICE_SECONDS) {
    await ctx.reply(`That is a long one — keep voice notes under ${MAX_VOICE_SECONDS} seconds.`);
    return;
  }

  let transcript: string;
  try {
    const audio = await downloadTelegramFile(ctx, env.TELEGRAM_BOT_TOKEN);
    transcript = await transcribe(audio, ctx.message.voice.mime_type ?? 'audio/ogg', env.OPENAI_API_KEY);
  } catch (error) {
    console.error(redact({ scope: 'voice', chatId: String(ctx.chat.id), error }));
    await ctx.reply('I could not make out that voice note. Try again, or type it?');
    return;
  }

  if (!transcript) {
    await ctx.reply('That sounded empty — say it again?');
    return;
  }

  // Echo before acting. "Do" (2) and "das" (10) differ by one phoneme, and a misheard quantity
  // silently becomes a wrong bill. This does NOT wait for confirmation — it makes the mistake
  // visible in the same turn the money moves.
  await ctx.reply(`Heard: ${transcript}`);
  await handleTurn(ctx, transcript);
});
```

Add the imports: `downloadTelegramFile` from `../media/download.js` and `transcribe` from
`../media/transcribe.js`.

- [ ] **Step 8: Run the gate**

Run: `pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test`
Expected: green.

- [ ] **Step 9: Try it live**

With `pnpm dev` and a real `OPENAI_API_KEY`, send a voice note saying "do kilo cheeni Ramesh ke
khaate mein".
Expected: an echo line, then the agent building the bill. Also send one with no `OPENAI_API_KEY`
set and confirm the reply is the friendly message, not a stack trace.

- [ ] **Step 10: Commit**

```bash
git add src/media src/telegram/bot.ts src/config/env.ts .env.example
git commit -m "feat: voice input with an echo-before-acting transcript"
```

---

### Task 8: Draft age filter

An abandoned draft sits forever and keeps surfacing in `find_bills`. `/reset` already deletes
every bill (`src/seed/index.ts:138-143`), so only the filter is missing.

**Files:**
- Modify: `src/repositories/bills.ts`, `src/tools/billing.ts`
- Test: `src/repositories/bills.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/repositories/bills.test.ts`, inside the existing `findBills` describe block (match the
surrounding fixture style):

```typescript
it('hides drafts older than a day but keeps old finalized bills', async () => {
  const stale = await openBill(STORE, { customerName: 'Stale' });
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
  await db.update(bills).set({ createdAt: twoDaysAgo }).where(eq(bills.id, stale.billId));

  const found = await findBills(STORE, { limit: 50 });
  expect(found.map((b) => b.id)).not.toContain(stale.billId);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run src/repositories/bills.test.ts -t 'hides drafts'`
Expected: FAIL — the stale draft is returned.

- [ ] **Step 3: Add the filter**

In `src/repositories/bills.ts`, extend the `findBills` signature and conditions. Change the input
type to add the flag, and insert the condition after the existing `since` handling:

```typescript
export async function findBills(
  storeId: bigint,
  input: {
    customer?: string;
    since?: Date;
    limit?: number;
    includeStaleDrafts?: boolean;
  } = {},
): Promise<BillSummary[]> {
```

```typescript
  // An abandoned draft holds no stock, but it clutters every "which bill?" lookup. A draft the
  // owner has not touched in a day is not the bill they mean.
  if (!input.includeStaleDrafts) {
    const cutoff = new Date(Date.now() - 86_400_000);
    conditions.push(
      or(ne(bills.status, 'draft'), gte(bills.createdAt, cutoff))!,
    );
  }
```

`src/repositories/bills.ts:1` currently imports
`{ and, asc, desc, eq, gte, ilike, inArray, sql }` — **both `ne` and `or` are missing** and must
be added.

- [ ] **Step 4: Verify**

Run: `pnpm vitest run src/repositories/bills.test.ts`
Expected: green, including the existing `findBills` tests.

- [ ] **Step 5: Expose it on the tool**

In `src/tools/billing.ts`, add the parameter to `findBillsTool` (line 171) so the model can ask
for everything when it needs to:

```typescript
    include_stale_drafts: z
      .boolean()
      .optional()
      .describe('Include drafts older than a day. Off by default — they are usually abandoned.'),
```

and pass it through:

```typescript
    const bills = await findBills(storeId, { customer, since, limit, includeStaleDrafts: include_stale_drafts });
```

- [ ] **Step 6: Run the gate and commit**

```bash
pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test
git add src/repositories/bills.ts src/tools/billing.ts src/repositories/bills.test.ts
git commit -m "feat: hide abandoned drafts from bill lookup"
```

---

### Task 9: Reorder suggestions from sales velocity

Brief §7 item 3. `stock_movements` already holds every sale. Pure read — no invariant touched.

**Files:**
- Modify: `src/repositories/analytics.ts`, `src/tools/analytics.ts`
- Test: `src/repositories/analytics.test.ts` (create if absent)

**Interfaces:**
- Produces: `reorderSuggestions(storeId: bigint, daysBack?: number): Promise<ReorderSuggestion[]>`

- [ ] **Step 1: Write the failing test**

Add to `src/repositories/analytics.test.ts`, following the fixture style already used in
`src/repositories/bills.test.ts` (insert a store, a product, then `stockMovements` rows directly):

```typescript
it('ranks by days of cover, not by absolute stock', async () => {
  // Fast mover: 60 sold over 30 days = 2/day, 10 left -> 5 days of cover.
  // Slow mover: 30 sold over 30 days = 1/day, 40 left -> 40 days of cover.
  const suggestions = await reorderSuggestions(STORE, 30);

  const fast = suggestions.find((s) => s.name === 'Maggi 70g');
  const slow = suggestions.find((s) => s.name === 'Parle-G 100g');

  expect(fast!.daysOfCover).toBeCloseTo(5, 1);
  expect(slow!.daysOfCover).toBeCloseTo(40, 1);
  expect(suggestions[0]!.name).toBe('Maggi 70g');
});

it('reports products with no sales without dividing by zero', async () => {
  const suggestions = await reorderSuggestions(STORE, 30);
  const idle = suggestions.find((s) => s.name === 'Tata Salt 1kg');
  expect(idle!.unitsPerDay).toBe(0);
  expect(idle!.daysOfCover).toBeNull();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run src/repositories/analytics.test.ts`
Expected: FAIL — `reorderSuggestions` is not exported.

- [ ] **Step 3: Implement it**

Add to `src/repositories/analytics.ts`:

```typescript
export interface ReorderSuggestion {
  productId: string;
  name: string;
  unit: string;
  quantityBase: number;
  reorderLevelBase: number;
  unitsPerDay: number;
  /** Null when nothing sold in the window — cover is undefined, not infinite. */
  daysOfCover: number | null;
}

/**
 * What to order next, ranked by how soon it runs out.
 *
 * A flat below-reorder-level list treats a slow-moving SKU sitting at its threshold the same as
 * a fast mover about to go empty. Velocity is what the owner actually needs to decide.
 */
export async function reorderSuggestions(
  storeId: bigint,
  daysBack = 30,
): Promise<ReorderSuggestion[]> {
  const since = new Date(Date.now() - daysBack * 86_400_000);

  const rows = await db
    .select({
      productId: products.id,
      name: products.name,
      unit: products.unit,
      quantityBase: products.quantityBase,
      reorderLevelBase: products.reorderLevelBase,
      // Sale deltas are negative; negate to get units sold. Movements outside the window and
      // non-sale kinds contribute 0 rather than dropping the product from the report.
      soldBase: sql<number>`
        coalesce(sum(
          case when ${stockMovements.kind} = 'sale'
                and ${stockMovements.createdAt} >= ${since}
               then -${stockMovements.qtyBaseDelta}
               else 0 end
        ), 0)::int
      `,
    })
    .from(products)
    .leftJoin(stockMovements, eq(stockMovements.productId, products.id))
    .where(eq(products.storeId, storeId))
    .groupBy(
      products.id,
      products.name,
      products.unit,
      products.quantityBase,
      products.reorderLevelBase,
    );

  return rows
    .map((r) => {
      const unitsPerDay = r.soldBase / daysBack;
      return {
        productId: r.productId,
        name: r.name,
        unit: r.unit,
        quantityBase: Number(r.quantityBase),
        reorderLevelBase: Number(r.reorderLevelBase),
        unitsPerDay,
        daysOfCover: unitsPerDay > 0 ? Number(r.quantityBase) / unitsPerDay : null,
      };
    })
    .sort((a, b) => {
      // Never-selling stock sorts last: it is not urgent, however little is left.
      if (a.daysOfCover === null) return b.daysOfCover === null ? 0 : 1;
      if (b.daysOfCover === null) return -1;
      return a.daysOfCover - b.daysOfCover;
    });
}
```

Ensure `products`, `stockMovements`, `eq` and `sql` are imported in that file.

- [ ] **Step 4: Verify**

Run: `pnpm vitest run src/repositories/analytics.test.ts`
Expected: both PASS.

- [ ] **Step 5: Add the tool**

In `src/tools/analytics.ts`:

```typescript
export const reorderSuggestionsTool = tool(
  'reorder_suggestions',
  'What to order next, ranked by how soon it runs out. Uses actual sales velocity from the ' +
    'last N days, so a fast mover about to go empty ranks above a slow one sitting at its ' +
    'reorder level. Answers "what should I order?".',
  {
    days_back: z.number().int().positive().max(90).optional().describe('Sales window. Defaults to 30.'),
    limit: z.number().int().positive().max(20).optional().describe('Defaults to 10.'),
  },
  async ({ days_back, limit }) => {
    const { storeId } = requireContext();
    const suggestions = await reorderSuggestions(storeId, days_back ?? 30);
    return toolResult({
      window_days: days_back ?? 30,
      suggestions: suggestions.slice(0, limit ?? 10).map((s) => ({
        name: s.name,
        in_stock: formatQuantity(s.quantityBase, s.unit as Unit),
        sells_per_day: Number(s.unitsPerDay.toFixed(2)),
        days_of_cover: s.daysOfCover === null ? 'no recent sales' : Number(s.daysOfCover.toFixed(1)),
        below_reorder_level: s.quantityBase <= s.reorderLevelBase,
      })),
    });
  },
);
```

Import `reorderSuggestions` from `../repositories/analytics.js`, and `formatQuantity` / `Unit`
from `../domain/units.js`.

**Register it in both arrays** at the bottom of the file — `ANALYTICS_TOOLS` and
`ANALYTICS_TOOL_NAMES` (add `'reorder_suggestions'`). A tool in one but not the other fails
silently.

- [ ] **Step 6: Mention it in the analytics skill**

Add one line to `.claude/skills/analytics/SKILL.md` describing when to reach for
`reorder_suggestions` over `stock_health`: velocity and urgency versus a flat threshold list.

- [ ] **Step 7: Run the gate and commit**

```bash
pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test
git add src/repositories/analytics.ts src/tools/analytics.ts src/repositories/analytics.test.ts .claude/skills/analytics/SKILL.md
git commit -m "feat: reorder suggestions ranked by sales velocity"
```

---

### Task 10: Idempotency layer 2 for `open_bill`

`README.md:128-137` presents three idempotency layers as shipped. Layer 2 is not wired:
`idempotencyKeys` appears only in `src/db/schema.ts:213` and its schema test, no tool takes a key,
and `IdempotencyIssuer.next()` is called only from `src/tools/context.test.ts`. `openBill`
(`bills.ts:284-296`) is a plain insert, so a reprocessed turn opens a second draft.

**Scope: `open_bill` only.** That is the path the original spec named and the one whose duplicate
does real damage.

**Files:**
- Modify: `src/repositories/bills.ts`, `src/tools/billing.ts`
- Test: `src/repositories/bills.test.ts`

**Interfaces:**
- Consumes: `idempotencyKeys` (`src/db/schema.ts:213-225`), `requireContext().idempotency`
  (`src/tools/context.ts`)

- [ ] **Step 1: Write the failing test**

```typescript
it('returns the same bill when the same idempotency key is replayed', async () => {
  const key = 'update-1:open_bill:abc:0';
  const first = await openBill(STORE, { customerName: 'Ramesh', idempotencyKey: key });
  const second = await openBill(STORE, { customerName: 'Ramesh', idempotencyKey: key });

  expect(second.billId).toBe(first.billId);

  const drafts = await findBills(STORE, { customer: 'Ramesh', limit: 50 });
  expect(drafts.filter((b) => b.id === first.billId)).toHaveLength(1);
});

it('opens separate bills for different keys', async () => {
  const a = await openBill(STORE, { idempotencyKey: 'k1' });
  const b = await openBill(STORE, { idempotencyKey: 'k2' });
  expect(a.billId).not.toBe(b.billId);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run src/repositories/bills.test.ts -t 'idempotency key is replayed'`
Expected: FAIL — two different bill ids.

- [ ] **Step 3: Implement**

Replace `openBill` in `src/repositories/bills.ts`:

```typescript
/** Opens an empty draft. Several drafts may be open per store at once, by design. */
export async function openBill(
  storeId: bigint,
  input: { customerName?: string; idempotencyKey?: string } = {},
): Promise<{ billId: string }> {
  const customerName = input.customerName?.trim();

  if (!input.idempotencyKey) {
    const [row] = await db
      .insert(bills)
      .values({ storeId, customerName: customerName ? customerName : null })
      .returning({ id: bills.id });
    return { billId: row!.id };
  }

  return db.transaction(async (tx) => {
    // Insert-first: the unique constraint IS the enforcement. Checking then writing leaves a
    // window in which a redelivered update opens a second draft.
    const claimed = await tx
      .insert(idempotencyKeys)
      .values({
        storeId,
        key: input.idempotencyKey!,
        operation: 'open_bill',
        result: {},
      })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });

    if (claimed.length === 0) {
      const [existing] = await tx
        .select({ result: idempotencyKeys.result })
        .from(idempotencyKeys)
        .where(
          and(eq(idempotencyKeys.storeId, storeId), eq(idempotencyKeys.key, input.idempotencyKey!)),
        );
      return { billId: (existing!.result as { billId: string }).billId };
    }

    const [row] = await tx
      .insert(bills)
      .values({ storeId, customerName: customerName ? customerName : null })
      .returning({ id: bills.id });

    await tx
      .update(idempotencyKeys)
      .set({ result: { billId: row!.id } })
      .where(
        and(eq(idempotencyKeys.storeId, storeId), eq(idempotencyKeys.key, input.idempotencyKey!)),
      );

    return { billId: row!.id };
  });
}
```

Add `idempotencyKeys` to the schema import at the top of the file.

- [ ] **Step 4: Verify**

Run: `pnpm vitest run src/repositories/bills.test.ts`
Expected: green.

- [ ] **Step 5: Pass the key from the tool**

In `src/tools/billing.ts`, in `openBillTool`'s handler, take the issuer off the context and pass a
key:

```typescript
    const { storeId, idempotency } = requireContext();
    const result = await openBill(storeId, {
      customerName: customer_name,
      idempotencyKey: idempotency.next('open_bill', { customer_name }),
    });
```

The signature is `next(toolName: string, args: unknown): string`
(`src/tools/context.ts:35`), so the call above is correct as written. The issuer is constructed
per turn, so a replayed turn producing the same call sequence regenerates the same keys — which
is exactly what makes this work.

- [ ] **Step 6: Update the README**

`README.md:128-137` can now stand. Adjust the layer-2 wording so it says what is true: keys are
issued per turn and enforced by the unique constraint on `open_bill`, with the other mutating
tools relying on layers 1 and 3. Do not leave it claiming more than the code does.

- [ ] **Step 7: Run the gate and commit**

```bash
pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test
git add src/repositories/bills.ts src/tools/billing.ts src/repositories/bills.test.ts README.md
git commit -m "fix: wire idempotency layer 2 for open_bill"
```

---

## After the plan

Not tasks in this plan — they need judgement, not execution:

1. **Packaging (reserve a day).** README to ~1 page with depth moved to `docs/DESIGN.md`; decide
   what `.gitignore` should exclude before the repo goes public; record the 4–5 minute demo.
2. **Rotate both credentials.** The Railway CLI echoed `TELEGRAM_BOT_TOKEN` and
   `ANTHROPIC_API_KEY` to stdout, and the bot token reached deployment logs before Task 2. Task 2
   stops the leak; it does not undo it.
3. **Move the FEFO analysis into the README's "what I'd do differently"** — it is already listed
   under edge cases not handled.
4. **Photo input**, only if time remains after packaging. Verify the
   `prompt: AsyncIterable<SDKUserMessage>` mode switch against `resume` empirically before
   building on it.

## Self-review

**Spec coverage:** Package 0 → Task 1. A1/A2 → Task 2. A3 → Tasks 3 and 6. B → Task 4. C → Task 5.
D → Tasks 6 and 7. E → Task 8. F → Task 9. G → Task 10. Packaging and photo are listed above as
non-tasks, matching the spec's treatment. FEFO appears only as a README item, as the spec requires.

**Type consistency:** `handleTurn(ctx, text)` is produced in Task 6 and consumed in Task 7.
`redact` is produced in Task 2 and consumed in Tasks 3, 6 and 7. `logTurn`/`shouldLogMessageText`
are produced in Task 3 and consumed in Task 6. `transcribe(audio, mimeType, apiKey)` has the same
three-argument shape in its test, its implementation and its call site. `reorderSuggestions`
returns `ReorderSuggestion[]` and the tool reads exactly the fields defined on it.

**Ordering:** Task 3 defines the logger but does not wire it, because Task 6 rewrites the same
block — wiring it twice would guarantee a conflict. Task 6 must land before Task 7.

**Known soft spots for implementers:** Task 8's `or(...)` may need a non-null assertion to satisfy
Drizzle's types. Task 9's `sql` template uses a bound `Date`; if Drizzle renders it awkwardly,
compute the cutoff in SQL instead. Task 10 depends on `IdempotencyIssuer.next`'s real signature —
read it rather than trusting the snippet.
