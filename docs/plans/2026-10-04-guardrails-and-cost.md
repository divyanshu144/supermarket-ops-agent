# Guardrails and Cost Implementation Plan (sub-project A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only invited shops can use the bot, and no single turn, store or chat can run up unbounded model spend.

**Architecture:** A grammY access gate sits in front of every handler and only lets through chats that already own a store, plus the one `/start <code>` command that can create one. Invite codes live hashed in Postgres and are redeemed with a single conditional `UPDATE`. Each agent run gets turn, budget and time limits from env; the final SDK result message feeds a per-store daily `usage` table and a per-chat in-memory rate limiter. Command logic moves out of `bot.ts` into plain functions so it can be tested against the real database.

**Tech Stack:** TypeScript, grammY, Drizzle + Postgres, Claude Agent SDK (`maxTurns`, `maxBudgetUsd`, `fallbackModel`, `abortController`), Vitest.

**Spec:** `docs/specs/2026-10-04-production-hardening-design.md` §A.

## Global Constraints

- Agent-first. No regex or keyword intent router. The access gate is authorization and only inspects whether the chat owns a store and whether the text is the `/start` command.
- Defaults (all env-overridable): `AGENT_MAX_TURNS` 15; `AGENT_MAX_BUDGET_USD` 0.50; `AGENT_TURN_TIMEOUT_MS` 90000; `STORE_DAILY_BUDGET_USD` 5.00; `RATE_LIMIT_TURNS` 20 per `RATE_LIMIT_WINDOW_S` 600; `AGENT_MODEL` default `claude-opus-5`; optional `AGENT_FALLBACK_MODEL`.
- Money in the shop is integer paise. Model spend is a separate estimate and is stored as integer **micro-USD** to avoid float accumulation.
- `/reset` with no argument changes nothing; `/reset confirm` performs it.
- Every guard gets a test that fails without it. Gate: `pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test`.
- Layering: `domain/` pure; `repositories/` own SQL; `agent/` knows nothing of Telegram; `telegram/` is glue. Business rules are not put in the system prompt.
- Tests run with `fileParallelism: false` (see `vitest.config.ts`); keep it. Use chat IDs in the `9991xxxxx` range for new tests.
- Work on branch `production-hardening`. Never commit to `main`.
- SDK facts verified against the Agent SDK docs on 2026-10-04: `maxTurns`, `maxBudgetUsd`, `fallbackModel` (throws if equal to `model`), `abortController` are `query()` options. A single-shot `query()` **yields the error result and then throws** on `error_max_turns` / `error_max_budget_usd`. `total_cost_usd` is on every result subtype and, on a resumed session, **includes the session's earlier spend**.

## Review Focus

Failure modes the spec implies but no obvious test covers. Each has a test in the owning task.

1. **Owner retries after a timeout and double-bills.** The abort can land after a mutation. The timeout reply must tell the owner to check what went through before repeating. (Task 6 test.)
2. **Invite code typed on a phone.** Mixed case and stray spaces must still redeem. Codes are lowercase and the lookup is case-insensitive. (Task 3 test.)
3. **`/start <code>` in a group chat** (negative chat ID). Must redeem and later pass the gate. (Task 3 and Task 8 tests.)
4. **Stranger sends a voice note, photo or sticker** (no `message.text`). Must get the private-bot reply, with no download and no transcription. (Task 8 test.)
5. **Spend exactly at the daily cap, and a failed provisioning after a code is claimed.** At-cap must block; a failed provision must release the code instead of burning it. (Task 4 and Task 3 tests.)

---

## File Structure

| File | Responsibility |
|---|---|
| `src/config/env.ts` | Adds the limit and model env vars, validated at boot |
| `src/db/schema.ts` + new migration | `invite_codes`, `usage`, `sessions.cost_micro_usd` |
| `src/repositories/access.ts` | `hasStore`, `createInvite`, `redeemInvite`, `revokeInvite`, `listInvites` |
| `src/repositories/usage.ts` | `recordUsage`, `spentTodayMicroUsd` (IST day) |
| `src/repositories/updates.ts` | `getSessionCostMicroUsd`; `setSessionId` stores cumulative cost |
| `src/telegram/rate-limit.ts` | `SlidingWindowLimiter` and the `turnLimiter` singleton |
| `src/telegram/messages.ts` | All fixed owner-facing strings in one place |
| `src/telegram/commands.ts` | `startCommand`, `newCommand`, `resetCommand` — plain functions |
| `src/telegram/gate.ts` | `isStartCommand`, `decideAccess`, `accessGate` middleware |
| `src/telegram/bot.ts` | `createBot(token, botInfo?)`; wires gate and thin handlers |
| `src/telegram/turn.ts` | Rate limit, daily cap, cost recording, richer log |
| `src/agent/limits.ts` | Pure helpers: limits from env, result classification, cost maths, outcome replies |
| `src/agent/runtime.ts` | Applies limits, timeout abort, returns cost, turns and outcome |
| `src/agent/cost.probe.ts` | One-off probe: does the budget cap count resumed-session spend? |
| `src/observability/log.ts` | Logs cost, turn count and the wider outcome set |
| `src/scripts/invite.ts` | `create` / `list` / `revoke` CLI |

---

### Task 1: Environment configuration

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/config/env.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `Env` gains `AGENT_MODEL: string`, `AGENT_FALLBACK_MODEL?: string`, `AGENT_MAX_TURNS: number`, `AGENT_MAX_BUDGET_USD: number`, `AGENT_TURN_TIMEOUT_MS: number`, `STORE_DAILY_BUDGET_USD: number`, `RATE_LIMIT_TURNS: number`, `RATE_LIMIT_WINDOW_S: number`.

- [ ] **Step 1: Write the failing tests** — append to `src/config/env.test.ts`:

```ts
describe('loadEnv limits', () => {
  it('applies the documented defaults', () => {
    const env = loadEnv(valid);
    expect(env.AGENT_MODEL).toBe('claude-opus-5');
    expect(env.AGENT_FALLBACK_MODEL).toBeUndefined();
    expect(env.AGENT_MAX_TURNS).toBe(15);
    expect(env.AGENT_MAX_BUDGET_USD).toBe(0.5);
    expect(env.AGENT_TURN_TIMEOUT_MS).toBe(90_000);
    expect(env.STORE_DAILY_BUDGET_USD).toBe(5);
    expect(env.RATE_LIMIT_TURNS).toBe(20);
    expect(env.RATE_LIMIT_WINDOW_S).toBe(600);
  });

  it('coerces numeric strings from the environment', () => {
    expect(loadEnv({ ...valid, AGENT_MAX_TURNS: '7' }).AGENT_MAX_TURNS).toBe(7);
    expect(loadEnv({ ...valid, AGENT_MAX_BUDGET_USD: '1.25' }).AGENT_MAX_BUDGET_USD).toBe(1.25);
  });

  it('rejects a non-positive limit', () => {
    expect(() => loadEnv({ ...valid, AGENT_MAX_BUDGET_USD: '0' })).toThrow(/AGENT_MAX_BUDGET_USD/);
    expect(() => loadEnv({ ...valid, RATE_LIMIT_TURNS: '-3' })).toThrow(/RATE_LIMIT_TURNS/);
  });

  it('rejects a fallback model equal to the primary', () => {
    expect(() =>
      loadEnv({ ...valid, AGENT_MODEL: 'claude-opus-5', AGENT_FALLBACK_MODEL: 'claude-opus-5' }),
    ).toThrow(/AGENT_FALLBACK_MODEL/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/config/env.test.ts`
Expected: FAIL — the new properties are `undefined`.

- [ ] **Step 3: Implement** — in `src/config/env.ts`, replace the `const schema = z.object({...});` declaration with:

```ts
const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const positiveNumber = (fallback: number) => z.coerce.number().positive().default(fallback);

const schema = z
  .object({
    DATABASE_URL: z.string().url(),
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    ANTHROPIC_API_KEY: z.string().min(1),
    OPENAI_API_KEY: z.string().optional(),
    AGENT_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_MESSAGE_TEXT: z.enum(['true', 'false']).optional(),

    AGENT_MODEL: z.string().min(1).default('claude-opus-5'),
    // Empty string is treated as unset by agent/limits.ts, so `AGENT_FALLBACK_MODEL=` in a
    // dotenv file does not break boot.
    AGENT_FALLBACK_MODEL: z.string().optional(),
    AGENT_MAX_TURNS: positiveInt(15),
    AGENT_MAX_BUDGET_USD: positiveNumber(0.5),
    AGENT_TURN_TIMEOUT_MS: positiveInt(90_000),
    STORE_DAILY_BUDGET_USD: positiveNumber(5),
    RATE_LIMIT_TURNS: positiveInt(20),
    RATE_LIMIT_WINDOW_S: positiveInt(600),
  })
  .refine((e) => !e.AGENT_FALLBACK_MODEL || e.AGENT_FALLBACK_MODEL !== e.AGENT_MODEL, {
    path: ['AGENT_FALLBACK_MODEL'],
    message: 'must differ from AGENT_MODEL (the SDK throws at startup otherwise)',
  });
```

- [ ] **Step 4: Document the variables** — append to `.env.example` (numeric lines stay commented because an empty value would coerce to 0 and fail validation):

```
# Agent limits and cost controls. Defaults shown; uncomment to override.
# AGENT_MODEL=claude-opus-5
# AGENT_FALLBACK_MODEL=
# AGENT_MAX_TURNS=15
# AGENT_MAX_BUDGET_USD=0.5
# AGENT_TURN_TIMEOUT_MS=90000
# STORE_DAILY_BUDGET_USD=5
# RATE_LIMIT_TURNS=20
# RATE_LIMIT_WINDOW_S=600
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run src/config/env.test.ts && pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/config .env.example
git commit -m "feat: env-configurable agent limits, daily budget and rate limit"
```

---

### Task 2: Schema and migration

**Files:**
- Modify: `src/db/schema.ts`
- Create: generated `src/db/migrations/0004_*.sql` and `meta/` updates
- Test: `src/db/schema.access.test.ts`

**Interfaces:**
- Produces: tables `inviteCodes` (`id`, `codeHash`, `createdAt`, `usedByChat`, `usedAt`, `revokedAt`), `usage` (`storeId`, `day`, `costMicroUsd`, `turns`), and column `sessions.costMicroUsd`.

- [ ] **Step 1: Write the failing test** — create `src/db/schema.access.test.ts`:

```ts
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from './client.js';
import { inviteCodes, sessions, stores, usage } from './schema.js';

const CHAT = 999100001n;

afterAll(async () => {
  await db.delete(stores).where(eq(stores.id, CHAT));
  await db.delete(inviteCodes).where(eq(inviteCodes.codeHash, 'schema-test-hash'));
  await pool.end();
});

describe('access and usage schema', () => {
  it('enforces a unique invite code hash', async () => {
    await db.insert(inviteCodes).values({ codeHash: 'schema-test-hash' });
    await expect(db.insert(inviteCodes).values({ codeHash: 'schema-test-hash' })).rejects.toThrow();
  });

  it('keys usage by store and day, and cascades on store delete', async () => {
    await db.delete(stores).where(eq(stores.id, CHAT));
    await db.insert(stores).values({ id: CHAT, name: 'S', gstin: '27AAAAA0000A1Z5' });
    await db.insert(usage).values({ storeId: CHAT, day: sql`current_date`, costMicroUsd: 5 });
    await expect(
      db.insert(usage).values({ storeId: CHAT, day: sql`current_date`, costMicroUsd: 9 }),
    ).rejects.toThrow();

    await db.delete(stores).where(eq(stores.id, CHAT));
    expect(await db.select().from(usage).where(eq(usage.storeId, CHAT))).toHaveLength(0);
  });

  it('defaults a session cost to zero', async () => {
    await db.delete(stores).where(eq(stores.id, CHAT));
    await db.insert(stores).values({ id: CHAT, name: 'S', gstin: '27AAAAA0000A1Z5' });
    await db.insert(sessions).values({ storeId: CHAT, agentSessionId: 'x' });
    const [row] = await db.select().from(sessions).where(eq(sessions.storeId, CHAT));
    expect(row!.costMicroUsd).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/db/schema.access.test.ts`
Expected: FAIL — `inviteCodes` / `usage` are not exported.

- [ ] **Step 3: Implement** — in `src/db/schema.ts` add `date` to the `drizzle-orm/pg-core` import list, add the column to `sessions`, and append the two tables.

In `sessions`, after `agentSessionId`:

```ts
  // Cumulative model spend for this conversation, in micro-USD. The SDK reports a resumed
  // session's total_cost_usd including earlier turns, so the per-turn cost is the difference.
  costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }).notNull().default(0),
```

Append at the end of the file:

```ts
/**
 * Single-use invite codes. Only a hash is stored; the plaintext is shown once at creation.
 * `used_at` and `revoked_at` are both set by conditional UPDATEs, so a code can be redeemed
 * at most once even under concurrent redemption.
 */
export const inviteCodes = pgTable('invite_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  codeHash: text('code_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  usedByChat: bigint('used_by_chat', { mode: 'bigint' }),
  usedAt: timestamp('used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

/**
 * Model spend per store per IST day. Micro-USD integers: this is an estimate of API cost, not
 * shop money, but it is still never accumulated as a float.
 */
export const usage = pgTable(
  'usage',
  {
    storeId: bigint('store_id', { mode: 'bigint' })
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }).notNull().default(0),
    turns: integer('turns').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.day] })],
);
```

- [ ] **Step 4: Generate and apply the migration**

Run: `pnpm db:up && pnpm db:generate && pnpm db:migrate`
Expected: a new `0004_*.sql` containing `CREATE TABLE "invite_codes"`, `CREATE TABLE "usage"` and `ALTER TABLE "sessions" ADD COLUMN "cost_micro_usd"`. Read the SQL before committing; it must not drop or alter anything else.

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run src/db && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db
git commit -m "feat: invite_codes and usage tables, session cost column"
```

---

### Task 3: Access repository (invite codes)

**Files:**
- Create: `src/repositories/access.ts`
- Test: `src/repositories/access.test.ts`
- Test: `src/repositories/access.release.test.ts`

**Interfaces:**
- Consumes: `provisionStore(chatId: bigint)` from `./stores.js`.
- Produces:
  - `hasStore(chatId: bigint): Promise<boolean>`
  - `createInvite(): Promise<{ id: string; code: string }>`
  - `redeemInvite(code: string, chatId: bigint): Promise<'redeemed' | 'invalid'>`
  - `revokeInvite(id: string): Promise<boolean>` — true only if an **unredeemed** code was revoked
  - `listInvites(): Promise<InviteRow[]>` where `InviteRow = { id: string; createdAt: Date; usedByChat: bigint | null; usedAt: Date | null; revokedAt: Date | null }`

- [ ] **Step 1: Write the failing tests** — create `src/repositories/access.test.ts`:

```ts
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { inviteCodes, stores } from '../db/schema.js';
import {
  createInvite,
  hasStore,
  listInvites,
  redeemInvite,
  revokeInvite,
} from './access.js';

const A = 999100002n;
const B = 999100003n;
const GROUP = -999100004n; // Telegram group chat ids are negative
const made: string[] = [];

async function invite() {
  const created = await createInvite();
  made.push(created.id);
  return created;
}

afterEach(async () => {
  await db.delete(stores).where(inArray(stores.id, [A, B, GROUP]));
});

afterAll(async () => {
  if (made.length) await db.delete(inviteCodes).where(inArray(inviteCodes.id, made));
  await db.delete(stores).where(inArray(stores.id, [A, B, GROUP]));
  await pool.end();
});

describe('hasStore', () => {
  it('is false before provisioning and true after redemption', async () => {
    expect(await hasStore(A)).toBe(false);
    const { code } = await invite();
    await redeemInvite(code, A);
    expect(await hasStore(A)).toBe(true);
  });
});

describe('createInvite', () => {
  it('stores only a hash, never the plaintext code', async () => {
    const { id, code } = await invite();
    const [row] = await db.select().from(inviteCodes).where(eq(inviteCodes.id, id));
    expect(row!.codeHash).not.toContain(code);
    expect(row!.codeHash).toHaveLength(64);
  });

  it('issues a lowercase code with no ambiguous characters', async () => {
    const { code } = await invite();
    expect(code).toMatch(/^[a-hj-km-np-z2-9]{12}$/);
  });
});

describe('redeemInvite', () => {
  it('provisions a store and records who used the code', async () => {
    const { id, code } = await invite();
    expect(await redeemInvite(code, A)).toBe('redeemed');
    expect(await hasStore(A)).toBe(true);
    const [row] = await db.select().from(inviteCodes).where(eq(inviteCodes.id, id));
    expect(row!.usedByChat).toBe(A);
    expect(row!.usedAt).not.toBeNull();
  });

  it('refuses a second redemption and creates no second store', async () => {
    const { code } = await invite();
    await redeemInvite(code, A);
    expect(await redeemInvite(code, B)).toBe('invalid');
    expect(await hasStore(B)).toBe(false);
  });

  it('lets exactly one of two simultaneous redemptions win', async () => {
    const { code } = await invite();
    const results = await Promise.all([redeemInvite(code, A), redeemInvite(code, B)]);
    expect([...results].sort()).toEqual(['invalid', 'redeemed']);
    const owners = [await hasStore(A), await hasStore(B)].filter(Boolean);
    expect(owners).toHaveLength(1);
  });

  it('rejects an unknown code', async () => {
    expect(await redeemInvite('zzzzzzzzzzzz', A)).toBe('invalid');
    expect(await hasStore(A)).toBe(false);
  });

  it('rejects a revoked code', async () => {
    const { id, code } = await invite();
    expect(await revokeInvite(id)).toBe(true);
    expect(await redeemInvite(code, A)).toBe('invalid');
    expect(await hasStore(A)).toBe(false);
  });

  it('accepts a code typed in upper case with stray spaces', async () => {
    const { code } = await invite();
    expect(await redeemInvite(`  ${code.toUpperCase()} `, A)).toBe('redeemed');
  });

  it('works from a group chat with a negative id', async () => {
    const { code } = await invite();
    expect(await redeemInvite(code, GROUP)).toBe('redeemed');
    expect(await hasStore(GROUP)).toBe(true);
  });
});

describe('revokeInvite', () => {
  it('does not revoke a code that was already redeemed', async () => {
    const { id, code } = await invite();
    await redeemInvite(code, A);
    expect(await revokeInvite(id)).toBe(false);
    expect(await hasStore(A)).toBe(true);
  });
});

describe('listInvites', () => {
  it('lists codes without any code material', async () => {
    const { id } = await invite();
    const rows = await listInvites();
    const row = rows.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(Object.keys(row!)).not.toContain('codeHash');
  });
});
```

Create `src/repositories/access.release.test.ts` (separate file because it mocks `./stores.js`):

```ts
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { inviteCodes } from '../db/schema.js';

vi.mock('./stores.js', () => ({
  provisionStore: vi.fn().mockRejectedValue(new Error('database blip')),
}));

const { createInvite, redeemInvite } = await import('./access.js');

const ids: string[] = [];

afterAll(async () => {
  for (const id of ids) await db.delete(inviteCodes).where(eq(inviteCodes.id, id));
  await pool.end();
});

describe('redeemInvite when provisioning fails', () => {
  it('releases the code instead of burning it', async () => {
    const { id, code } = await createInvite();
    ids.push(id);

    await expect(redeemInvite(code, 999100005n)).rejects.toThrow('database blip');

    const [row] = await db.select().from(inviteCodes).where(eq(inviteCodes.id, id));
    expect(row!.usedAt).toBeNull();
    expect(row!.usedByChat).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/repositories/access`
Expected: FAIL — `./access.js` does not exist.

- [ ] **Step 3: Implement** — create `src/repositories/access.ts`:

```ts
import { createHash, randomInt } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { inviteCodes, stores } from '../db/schema.js';
import { provisionStore } from './stores.js';

// Lowercase, no 0/o/1/i/l: a code gets read off one phone and typed into another.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LENGTH = 12;

function normalise(code: string): string {
  return code.trim().toLowerCase();
}

function hashCode(code: string): string {
  return createHash('sha256').update(normalise(code)).digest('hex');
}

function generateCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** A chat is allowed to use the bot exactly when it owns a store. */
export async function hasStore(chatId: bigint): Promise<boolean> {
  const rows = await db
    .select({ id: stores.id })
    .from(stores)
    .where(eq(stores.id, chatId))
    .limit(1);
  return rows.length > 0;
}

/** Returns the plaintext code once. Only its hash is persisted. */
export async function createInvite(): Promise<{ id: string; code: string }> {
  const code = generateCode();
  const [row] = await db
    .insert(inviteCodes)
    .values({ codeHash: hashCode(code) })
    .returning({ id: inviteCodes.id });
  return { id: row!.id, code };
}

export type RedeemResult = 'redeemed' | 'invalid';

/**
 * Redeems a code and provisions the caller's store.
 *
 * The claim is one conditional UPDATE, so two simultaneous redemptions cannot both succeed —
 * not a read-then-write. If provisioning then fails, the code is released: a database blip
 * must not cost the owner their only invite.
 */
export async function redeemInvite(code: string, chatId: bigint): Promise<RedeemResult> {
  const claimed = await db
    .update(inviteCodes)
    .set({ usedByChat: chatId, usedAt: sql`now()` })
    .where(
      and(
        eq(inviteCodes.codeHash, hashCode(code)),
        isNull(inviteCodes.usedAt),
        isNull(inviteCodes.revokedAt),
      ),
    )
    .returning({ id: inviteCodes.id });

  if (claimed.length === 0) return 'invalid';

  try {
    await provisionStore(chatId);
  } catch (error) {
    await db
      .update(inviteCodes)
      .set({ usedByChat: null, usedAt: null })
      .where(eq(inviteCodes.id, claimed[0]!.id));
    throw error;
  }
  return 'redeemed';
}

/**
 * Revokes an unredeemed code. A code that has already created a store is left alone: revoking
 * it must not silently orphan a shop that is mid-use. Returns whether anything was revoked.
 */
export async function revokeInvite(id: string): Promise<boolean> {
  const rows = await db
    .update(inviteCodes)
    .set({ revokedAt: sql`now()` })
    .where(
      and(eq(inviteCodes.id, id), isNull(inviteCodes.usedAt), isNull(inviteCodes.revokedAt)),
    )
    .returning({ id: inviteCodes.id });
  return rows.length > 0;
}

export interface InviteRow {
  id: string;
  createdAt: Date;
  usedByChat: bigint | null;
  usedAt: Date | null;
  revokedAt: Date | null;
}

export async function listInvites(): Promise<InviteRow[]> {
  return db
    .select({
      id: inviteCodes.id,
      createdAt: inviteCodes.createdAt,
      usedByChat: inviteCodes.usedByChat,
      usedAt: inviteCodes.usedAt,
      revokedAt: inviteCodes.revokedAt,
    })
    .from(inviteCodes)
    .orderBy(desc(inviteCodes.createdAt));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/repositories/access && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Prove the guards matter** — temporarily remove `isNull(inviteCodes.usedAt)` from the `redeemInvite` WHERE clause, run `pnpm vitest run src/repositories/access.test.ts`, and confirm the "second redemption" and "simultaneous" tests fail. Restore the line.

- [ ] **Step 6: Commit**

```bash
git add src/repositories/access.ts src/repositories/access.test.ts src/repositories/access.release.test.ts
git commit -m "feat: invite-code access repository with atomic redemption"
```

---

### Task 4: Usage repository and session cost

**Files:**
- Create: `src/repositories/usage.ts`
- Test: `src/repositories/usage.test.ts`
- Modify: `src/repositories/updates.ts`
- Modify: `src/repositories/updates.test.ts`

**Interfaces:**
- Produces:
  - `recordUsage(storeId: bigint, costMicroUsd: number): Promise<void>` — adds cost and one turn to today's IST row.
  - `spentTodayMicroUsd(storeId: bigint): Promise<number>`
  - `getSessionCostMicroUsd(storeId: bigint): Promise<number>`
  - `setSessionId(storeId: bigint, agentSessionId: string, costMicroUsd?: number): Promise<void>` (third argument defaults to 0, so existing callers compile)

- [ ] **Step 1: Write the failing tests** — create `src/repositories/usage.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { stores, usage } from '../db/schema.js';
import { recordUsage, spentTodayMicroUsd } from './usage.js';

const A = 999100010n;
const B = 999100011n;

beforeEach(async () => {
  await db.delete(stores).where(inArray(stores.id, [A, B]));
  for (const id of [A, B]) {
    await db.insert(stores).values({ id, name: 'S', gstin: '27AAAAA0000A1Z5' });
  }
});

afterAll(async () => {
  await db.delete(stores).where(inArray(stores.id, [A, B]));
  await pool.end();
});

describe('usage', () => {
  it('is zero for a store that has spent nothing', async () => {
    expect(await spentTodayMicroUsd(A)).toBe(0);
  });

  it('accumulates cost within the day', async () => {
    await recordUsage(A, 120_000);
    await recordUsage(A, 30_000);
    expect(await spentTodayMicroUsd(A)).toBe(150_000);
    const [row] = await db.select().from(usage).where(eq(usage.storeId, A));
    expect(row!.turns).toBe(2);
  });

  it('keeps stores separate', async () => {
    await recordUsage(A, 500_000);
    expect(await spentTodayMicroUsd(B)).toBe(0);
  });

  it("ignores a previous day's spend", async () => {
    await db
      .insert(usage)
      .values({ storeId: A, day: sql`(now() at time zone 'Asia/Kolkata')::date - 1`, costMicroUsd: 9_000_000 });
    expect(await spentTodayMicroUsd(A)).toBe(0);
  });
});
```

Append to `src/repositories/updates.test.ts` inside its existing `describe`-level structure (new `describe` at the end of the file; the file already imports `setSessionId`, `getSessionId`, `clearSession`, `db`, `stores`, `CHAT`):

```ts
import { getSessionCostMicroUsd } from './updates.js';

describe('session cost', () => {
  it('is zero when there is no session', async () => {
    expect(await getSessionCostMicroUsd(CHAT)).toBe(0);
  });

  it('stores and updates the cumulative cost with the session id', async () => {
    await setSessionId(CHAT, 's1', 400_000);
    expect(await getSessionCostMicroUsd(CHAT)).toBe(400_000);
    await setSessionId(CHAT, 's1', 650_000);
    expect(await getSessionCostMicroUsd(CHAT)).toBe(650_000);
  });

  it('resets when the conversation is cleared with /new', async () => {
    await setSessionId(CHAT, 's1', 400_000);
    await clearSession(CHAT);
    expect(await getSessionCostMicroUsd(CHAT)).toBe(0);
  });
});
```

(Move the `getSessionCostMicroUsd` import into the file's existing `import { … } from './updates.js'` block rather than adding a second import.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/repositories/usage.test.ts src/repositories/updates.test.ts`
Expected: FAIL — missing exports.

- [ ] **Step 3: Implement** — create `src/repositories/usage.ts`:

```ts
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { usage } from '../db/schema.js';

// A shop's day is an Indian day. UTC would roll the budget over at 05:30 in the morning.
const TODAY_IST = sql`(now() at time zone 'Asia/Kolkata')::date`;

/** Adds one turn's estimated model cost to the store's row for today (IST). */
export async function recordUsage(storeId: bigint, costMicroUsd: number): Promise<void> {
  await db
    .insert(usage)
    .values({ storeId, day: TODAY_IST, costMicroUsd, turns: 1 })
    .onConflictDoUpdate({
      target: [usage.storeId, usage.day],
      set: {
        costMicroUsd: sql`${usage.costMicroUsd} + ${costMicroUsd}`,
        turns: sql`${usage.turns} + 1`,
      },
    });
}

export async function spentTodayMicroUsd(storeId: bigint): Promise<number> {
  const rows = await db
    .select({ cost: usage.costMicroUsd })
    .from(usage)
    .where(and(eq(usage.storeId, storeId), sql`${usage.day} = ${TODAY_IST}`))
    .limit(1);
  return rows[0]?.cost ?? 0;
}
```

In `src/repositories/updates.ts`, replace `setSessionId` and add the getter:

```ts
export async function getSessionCostMicroUsd(storeId: bigint): Promise<number> {
  const rows = await db
    .select({ cost: sessions.costMicroUsd })
    .from(sessions)
    .where(eq(sessions.storeId, storeId))
    .limit(1);
  return rows[0]?.cost ?? 0;
}

export async function setSessionId(
  storeId: bigint,
  agentSessionId: string,
  costMicroUsd = 0,
): Promise<void> {
  await db
    .insert(sessions)
    .values({ storeId, agentSessionId, costMicroUsd })
    .onConflictDoUpdate({
      target: sessions.storeId,
      set: { agentSessionId, costMicroUsd, updatedAt: sql`now()` },
    });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/repositories/usage.test.ts src/repositories/updates.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/repositories
git commit -m "feat: per-store daily usage and cumulative session cost"
```

---

### Task 5: Rate limiter

**Files:**
- Create: `src/telegram/rate-limit.ts`
- Test: `src/telegram/rate-limit.test.ts`

**Interfaces:**
- Produces: `class SlidingWindowLimiter { constructor(limit: number, windowMs: number, now?: () => number); tryConsume(key: string): boolean }` and `export const turnLimiter: SlidingWindowLimiter` built from env.

- [ ] **Step 1: Write the failing tests** — create `src/telegram/rate-limit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SlidingWindowLimiter } from './rate-limit.js';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('SlidingWindowLimiter', () => {
  it('allows up to the limit and then blocks', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(3, 1000, c.now);
    expect([1, 2, 3, 4].map(() => limiter.tryConsume('chat'))).toEqual([true, true, true, false]);
  });

  it('tracks each key separately', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(1, 1000, c.now);
    expect(limiter.tryConsume('a')).toBe(true);
    expect(limiter.tryConsume('b')).toBe(true);
    expect(limiter.tryConsume('a')).toBe(false);
  });

  it('frees capacity as old hits leave the window', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(2, 1000, c.now);
    limiter.tryConsume('chat');
    limiter.tryConsume('chat');
    c.advance(1001);
    expect(limiter.tryConsume('chat')).toBe(true);
  });

  it('does not count blocked attempts, so a spammer is not locked out for longer', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(2, 1000, c.now);
    limiter.tryConsume('chat'); // t=0
    limiter.tryConsume('chat'); // t=0
    c.advance(500);
    expect(limiter.tryConsume('chat')).toBe(false); // blocked at t=500, must not be recorded
    c.advance(501); // t=1001: the two t=0 hits have expired
    expect(limiter.tryConsume('chat')).toBe(true);
    expect(limiter.tryConsume('chat')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/telegram/rate-limit.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** — create `src/telegram/rate-limit.ts`:

```ts
import { loadEnv } from '../config/env.js';

/**
 * Per-key sliding-window limiter, in memory.
 *
 * In memory is correct for the deployment this repo targets — one replica, long-polling — and
 * resets on restart. That is a known limit, documented in DEPLOY.md, not an oversight: a second
 * replica would need this state in Postgres, and a second replica already breaks long-polling.
 */
export class SlidingWindowLimiter {
  readonly #hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit and returns true if the key is within its limit. Blocked attempts are not recorded. */
  tryConsume(key: string): boolean {
    const t = this.now();
    const live = (this.#hits.get(key) ?? []).filter((at) => t - at < this.windowMs);
    if (live.length >= this.limit) {
      this.#hits.set(key, live);
      return false;
    }
    live.push(t);
    this.#hits.set(key, live);
    return true;
  }
}

const env = loadEnv();

/** One shared limiter for owner turns, text and voice alike. */
export const turnLimiter = new SlidingWindowLimiter(
  env.RATE_LIMIT_TURNS,
  env.RATE_LIMIT_WINDOW_S * 1000,
);
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/telegram/rate-limit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/rate-limit.*
git commit -m "feat: per-chat sliding-window rate limiter"
```

---

### Task 6: Agent limits, runtime and cost probe

**Files:**
- Create: `src/agent/limits.ts`
- Test: `src/agent/limits.test.ts`
- Create: `src/agent/cost.probe.ts`
- Modify: `src/agent/runtime.ts`
- Modify: `src/agent/e2e.ts`

**Interfaces:**
- Produces (`limits.ts`):
  - `type AgentOutcome = 'ok' | 'max_turns' | 'max_budget' | 'timeout' | 'error'`
  - `runLimits(env: Env): { model: string; fallbackModel?: string; maxTurns: number; maxBudgetUsd: number; timeoutMs: number }`
  - `classifyResult(result: { subtype: string; is_error: boolean }): AgentOutcome`
  - `microUsd(usd: number | undefined): number`
  - `SDK_COST_IS_CUMULATIVE: boolean`
  - `perRunBudgetUsd(cap: number, priorUsd: number, cumulative?: boolean): number`
  - `turnCostUsd(totalUsd: number, priorUsd: number, cumulative?: boolean): number`
  - `OUTCOME_REPLY: Record<Exclude<AgentOutcome, 'ok'>, string>`
- Produces (`runtime.ts`): `AgentResult` gains `outcome: AgentOutcome`, `totalCostUsd: number`, `turnCostUsd: number`, `numTurns: number`; `runAgent` input gains `priorCostUsd?: number`.

- [ ] **Step 1: Write the failing tests** — create `src/agent/limits.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env.js';
import {
  OUTCOME_REPLY,
  classifyResult,
  microUsd,
  perRunBudgetUsd,
  runLimits,
  turnCostUsd,
} from './limits.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  TELEGRAM_BOT_TOKEN: 't',
  ANTHROPIC_API_KEY: 'k',
  NODE_ENV: 'test',
};

describe('runLimits', () => {
  it('reads the limits from env', () => {
    const limits = runLimits(loadEnv({ ...base, AGENT_MAX_TURNS: '9', AGENT_MAX_BUDGET_USD: '0.25' }));
    expect(limits).toMatchObject({ model: 'claude-opus-5', maxTurns: 9, maxBudgetUsd: 0.25, timeoutMs: 90_000 });
  });

  it('treats an empty fallback model as unset', () => {
    expect(runLimits(loadEnv({ ...base, AGENT_FALLBACK_MODEL: '' })).fallbackModel).toBeUndefined();
  });

  it('passes a configured fallback model through', () => {
    expect(runLimits(loadEnv({ ...base, AGENT_FALLBACK_MODEL: 'claude-sonnet-5' })).fallbackModel).toBe(
      'claude-sonnet-5',
    );
  });
});

describe('classifyResult', () => {
  it('maps the SDK result subtypes', () => {
    expect(classifyResult({ subtype: 'success', is_error: false })).toBe('ok');
    expect(classifyResult({ subtype: 'error_max_turns', is_error: true })).toBe('max_turns');
    expect(classifyResult({ subtype: 'error_max_budget_usd', is_error: true })).toBe('max_budget');
    expect(classifyResult({ subtype: 'error_during_execution', is_error: true })).toBe('error');
  });

  it('treats a success whose final API call failed as an error', () => {
    expect(classifyResult({ subtype: 'success', is_error: true })).toBe('error');
  });
});

describe('cost maths', () => {
  it('converts dollars to integer micro-dollars', () => {
    expect(microUsd(0.1234567)).toBe(123_457);
    expect(microUsd(undefined)).toBe(0);
    expect(microUsd(-1)).toBe(0);
  });

  it('charges only the new spend when the SDK total is cumulative', () => {
    expect(turnCostUsd(0.9, 0.6, true)).toBeCloseTo(0.3);
  });

  it('never reports a negative turn cost (a fresh session after a failed resume)', () => {
    expect(turnCostUsd(0.1, 0.6, true)).toBe(0);
  });

  it('uses the total as-is when the SDK reports per-call cost', () => {
    expect(turnCostUsd(0.3, 0.6, false)).toBeCloseTo(0.3);
  });

  it('extends the budget cap by earlier spend only when totals are cumulative', () => {
    expect(perRunBudgetUsd(0.5, 0.6, true)).toBeCloseTo(1.1);
    expect(perRunBudgetUsd(0.5, 0.6, false)).toBe(0.5);
  });
});

describe('OUTCOME_REPLY', () => {
  it('tells the owner to check what went through after a timeout, before repeating', () => {
    expect(OUTCOME_REPLY.timeout).toMatch(/check/i);
    expect(OUTCOME_REPLY.timeout).toMatch(/before/i);
  });

  it('has a reply for every non-ok outcome', () => {
    for (const key of ['max_turns', 'max_budget', 'timeout', 'error'] as const) {
      expect(OUTCOME_REPLY[key].length).toBeGreaterThan(10);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/agent/limits.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the helpers** — create `src/agent/limits.ts`:

```ts
import type { Env } from '../config/env.js';

export type AgentOutcome = 'ok' | 'max_turns' | 'max_budget' | 'timeout' | 'error';

export interface RunLimits {
  model: string;
  fallbackModel?: string;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
}

export function runLimits(env: Env): RunLimits {
  return {
    model: env.AGENT_MODEL,
    fallbackModel: env.AGENT_FALLBACK_MODEL || undefined,
    maxTurns: env.AGENT_MAX_TURNS,
    maxBudgetUsd: env.AGENT_MAX_BUDGET_USD,
    timeoutMs: env.AGENT_TURN_TIMEOUT_MS,
  };
}

export function classifyResult(result: { subtype: string; is_error: boolean }): AgentOutcome {
  if (result.subtype === 'error_max_turns') return 'max_turns';
  if (result.subtype === 'error_max_budget_usd') return 'max_budget';
  if (result.subtype === 'success') return result.is_error ? 'error' : 'ok';
  return 'error';
}

/** Model spend is kept as integer micro-USD; see schema.ts `usage`. */
export function microUsd(usd: number | undefined): number {
  return Math.max(0, Math.round((usd ?? 0) * 1_000_000));
}

/**
 * Per the Agent SDK docs, `total_cost_usd` on a resumed session includes the session's earlier
 * spend. `src/agent/cost.probe.ts` confirms this and whether `maxBudgetUsd` compares against
 * the same cumulative figure. If the probe shows per-call semantics, flip this to false — the
 * two helpers below are the only code that depends on it.
 */
export const SDK_COST_IS_CUMULATIVE = true;

/** The `maxBudgetUsd` to pass so the cap bounds THIS run, not the whole conversation. */
export function perRunBudgetUsd(
  cap: number,
  priorUsd: number,
  cumulative: boolean = SDK_COST_IS_CUMULATIVE,
): number {
  return cumulative ? cap + priorUsd : cap;
}

/** What this run cost, given the SDK's reported total and what the session had cost before. */
export function turnCostUsd(
  totalUsd: number,
  priorUsd: number,
  cumulative: boolean = SDK_COST_IS_CUMULATIVE,
): number {
  return cumulative ? Math.max(0, totalUsd - priorUsd) : totalUsd;
}

export const OUTCOME_REPLY: Record<Exclude<AgentOutcome, 'ok'>, string> = {
  max_turns: 'That was too much for one go. Try it in smaller steps?',
  max_budget: 'That was too much for one go. Try it in smaller steps?',
  timeout:
    'That took too long and I stopped partway. Check what went through (ask for the last bill or the stock) before repeating it, so nothing is done twice.',
  error: 'Something went wrong on my side. Try that again?',
};
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/agent/limits.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the cost probe** — create `src/agent/cost.probe.ts`. It is a manual probe (needs API credit), like `runtime.smoke.ts`:

```ts
/**
 * Probe: how does the Agent SDK account cost across a resumed session?
 *
 *   pnpm tsx src/agent/cost.probe.ts
 *
 * Two questions, both about `resume`:
 *   1. Does turn 2's total_cost_usd include turn 1's spend?        (cumulative or per-call)
 *   2. Does maxBudgetUsd compare against that cumulative figure?   (turn 3 uses a cap smaller
 *      than turn 1's spend; if it stops with error_max_budget_usd at once, the cap is cumulative)
 *
 * Record the result in tasks/agent_memory.md and set SDK_COST_IS_CUMULATIVE in limits.ts.
 */
import 'dotenv/config';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

async function turn(prompt: string, resume?: string, maxBudgetUsd?: number) {
  let sessionId = resume ?? '';
  let total: number | undefined;
  let subtype = '';
  try {
    for await (const m of query({
      prompt,
      options: {
        model: env.AGENT_MODEL,
        resume,
        maxBudgetUsd,
        maxTurns: 3,
        settingSources: [],
        allowedTools: [],
      },
    })) {
      if (m.type === 'system' && 'session_id' in m) sessionId = String(m.session_id);
      if (m.type === 'result') {
        total = m.total_cost_usd;
        subtype = m.subtype;
      }
    }
  } catch (error) {
    console.log(`  (threw after result: ${(error as Error).message})`);
  }
  console.log(`  subtype=${subtype} total_cost_usd=${total}`);
  return { sessionId, total };
}

console.log('turn 1');
const one = await turn('Reply with the single word: ready');
console.log('turn 2 (resume)');
const two = await turn('Reply with the single word: again', one.sessionId);
console.log(
  `\nQ1 cumulative? turn2 total ${two.total} vs turn1 total ${one.total} -> ` +
    `${(two.total ?? 0) > (one.total ?? 0) ? 'CUMULATIVE (turn 2 >= turn 1)' : 'PER-CALL'}`,
);

console.log('turn 3 (resume, cap below turn 1 spend)');
const tiny = Math.max((one.total ?? 0) / 2, 0.0001);
await turn('Reply with the single word: third', two.sessionId, tiny);
console.log(
  `\nQ2: cap was ${tiny}. If turn 3 ended error_max_budget_usd, the cap is CUMULATIVE; ` +
    'if it ended success, the cap is PER-RUN.',
);
```

- [ ] **Step 6: Run the probe and record the result** (needs API credit)

Run: `pnpm tsx src/agent/cost.probe.ts`
Expected: prints three turns and both answers. Then:
- If Q1 prints CUMULATIVE **and** Q2 says the cap is CUMULATIVE → leave `SDK_COST_IS_CUMULATIVE = true` (the shipped default).
- If Q1 says PER-CALL → set `SDK_COST_IS_CUMULATIVE = false`.
- If Q1 is CUMULATIVE but Q2 says the cap is PER-RUN → stop and re-plan: `perRunBudgetUsd` must pass the bare cap while `turnCostUsd` still subtracts. Split the single constant into two.

Append the observed numbers and the decision under *Known Gotchas* in `tasks/agent_memory.md`.

- [ ] **Step 7: Apply the limits in the runtime** — replace the body of `src/agent/runtime.ts` below the `withPreferences` function. The `SYSTEM_PROMPT` constant and `withPreferences` stay unchanged. New imports at the top:

```ts
import { runLimits, classifyResult, perRunBudgetUsd, turnCostUsd, OUTCOME_REPLY, type AgentOutcome } from './limits.js';
```

Replace `AgentResult` and `runAgent`:

```ts
export interface AgentResult {
  reply: string;
  sessionId: string;
  toolsUsed: string[];
  outcome: AgentOutcome;
  /** SDK-reported total for the session so far (cumulative on a resumed session). */
  totalCostUsd: number;
  /** What this run cost. Feeds the daily budget. */
  turnCostUsd: number;
  numTurns: number;
}

export async function runAgent(input: {
  text: string;
  sessionId?: string;
  preferences?: Record<string, unknown>;
  /** Session spend before this run, so the budget cap and the cost accounting are per-run. */
  priorCostUsd?: number;
}): Promise<AgentResult> {
  const limits = runLimits(env);
  const prior = input.priorCostUsd ?? 0;

  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, limits.timeoutMs);

  const stream = query({
    prompt: input.text,
    options: {
      model: limits.model,
      fallbackModel: limits.fallbackModel,
      maxTurns: limits.maxTurns,
      maxBudgetUsd: perRunBudgetUsd(limits.maxBudgetUsd, prior),
      abortController: abort,
      systemPrompt: withPreferences(input.preferences ?? {}),
      mcpServers: { [STORE_SERVER_NAME]: storeToolServer },
      allowedTools: ALLOWED_TOOLS,
      skills: 'all',
      // 'project' is required for `.claude/skills/` to be discovered at all — with
      // settingSources: [] the skills never load, verified empirically. This does mean
      // project settings are read, so the agent's working directory must not contain
      // development instructions meant for a different audience.
      settingSources: ['project'],
      resume: input.sessionId,
      // Adaptive thinking stays on. `effort` is the latency lever — never disable thinking,
      // which on Opus 5 can emit tool calls as plain text that then silently never run.
      effort: env.AGENT_EFFORT,
    },
  });

  const chunks: string[] = [];
  const toolsUsed: string[] = [];
  let sessionId = input.sessionId ?? '';
  let outcome: AgentOutcome | undefined;
  let totalCostUsd = 0;
  let numTurns = 0;

  try {
    for await (const message of stream) {
      if (message.type === 'system' && 'session_id' in message) {
        sessionId = String(message.session_id);
      }
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') chunks.push(block.text);
          if (block.type === 'tool_use') toolsUsed.push(block.name);
        }
      }
      if (message.type === 'result') {
        outcome = classifyResult(message);
        totalCostUsd = message.total_cost_usd ?? 0;
        numTurns = message.num_turns;
      }
    }
  } catch (error) {
    // A single-shot query() yields the error result and THEN throws (max turns, max budget).
    // If we already saw the result, the throw carries no new information.
    if (timedOut) outcome = 'timeout';
    else if (outcome === undefined) throw error;
  } finally {
    clearTimeout(timer);
  }

  const finalOutcome = outcome ?? 'error';
  const reply = finalOutcome === 'ok' ? chunks.join('').trim() : OUTCOME_REPLY[finalOutcome];

  return {
    reply,
    sessionId,
    toolsUsed,
    outcome: finalOutcome,
    totalCostUsd,
    turnCostUsd: turnCostUsd(totalCostUsd, prior),
    numTurns,
  };
}
```

Note a timeout that aborts before any result message reports zero cost. That under-counts spend by whatever the aborted run consumed; it is bounded by the per-run budget cap and is recorded as a known limit in the README work (sub-project F).

- [ ] **Step 8: Keep the end-to-end script honest** — in `src/agent/e2e.ts`, track prior cost and print cost per beat. Add `let priorCostUsd = 0;` next to `let sessionId`, reset it to `0` where `sessionId = undefined` is set for a fresh chat, pass it into `runAgent`, and update it afterwards:

```ts
      runAgent({ text: beat.say, sessionId, preferences, priorCostUsd }),
    );
    sessionId = result.sessionId || sessionId;
    priorCostUsd = result.totalCostUsd;
```

and add `cost $${result.turnCostUsd.toFixed(4)} · ${result.outcome}` to the per-beat console line. Any beat whose outcome is not `ok` must count as a failure: after the `check`, `if (result.outcome !== 'ok') failures.push(\`${beat.name}: outcome ${result.outcome}\`);`.

- [ ] **Step 9: Typecheck and run unit tests**

Run: `pnpm typecheck && pnpm vitest run src/agent`
Expected: PASS. (`e2e.ts`, `runtime.smoke.ts`, `security.probe.ts` and `cost.probe.ts` are not `*.test.ts`, so Vitest does not run them.)

- [ ] **Step 10: Run the end-to-end script** (needs API credit)

Run: `pnpm tsx src/agent/e2e.ts`
Expected: 13/13 beats PASS with outcome `ok`, and a cost per beat. If a beat ends `max_budget` or `max_turns`, do not raise the default blindly: record that beat's measured cost and turn count in `tasks/agent_memory.md`, then decide the new default with the owner.

- [ ] **Step 11: Commit**

```bash
git add src/agent tasks/agent_memory.md
git commit -m "feat: per-run turn, budget and time limits with cost reporting"
```

---

### Task 7: Messages and commands

**Files:**
- Create: `src/telegram/messages.ts`
- Create: `src/telegram/commands.ts`
- Test: `src/telegram/commands.test.ts`

**Interfaces:**
- Consumes: `hasStore`, `redeemInvite` (Task 3); `clearSession` from `../repositories/updates.js`; `reseedStore` from `../seed/index.js`.
- Produces:
  - `messages.ts`: `WELCOME`, `PRIVATE_MESSAGE`, `INVALID_CODE`, `RESET_EXPLAINER`, `RATE_LIMITED_REPLY`, `DAILY_CAP_REPLY` (all `string`)
  - `startCommand(chatId: bigint, arg: string): Promise<string>`
  - `newCommand(chatId: bigint): Promise<string>`
  - `resetCommand(chatId: bigint, arg: string): Promise<string>`

- [ ] **Step 1: Write the failing tests** — create `src/telegram/commands.test.ts`:

```ts
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { inviteCodes, products, stores } from '../db/schema.js';
import { createInvite, hasStore, redeemInvite } from '../repositories/access.js';
import { provisionStore } from '../repositories/stores.js';
import { newCommand, resetCommand, startCommand } from './commands.js';
import { INVALID_CODE, PRIVATE_MESSAGE, RESET_EXPLAINER, WELCOME } from './messages.js';

const STRANGER = 999100020n;
const OWNER = 999100021n;
const OTHER = 999100022n;
const made: string[] = [];

async function invite() {
  const created = await createInvite();
  made.push(created.id);
  return created;
}

afterEach(async () => {
  await db.delete(stores).where(inArray(stores.id, [STRANGER, OWNER, OTHER]));
});

afterAll(async () => {
  if (made.length) await db.delete(inviteCodes).where(inArray(inviteCodes.id, made));
  await pool.end();
});

describe('startCommand', () => {
  it('turns a stranger with no code away and creates nothing', async () => {
    expect(await startCommand(STRANGER, '')).toBe(PRIVATE_MESSAGE);
    expect(await hasStore(STRANGER)).toBe(false);
  });

  it('rejects an invalid code and creates nothing', async () => {
    expect(await startCommand(STRANGER, 'nonsense')).toBe(INVALID_CODE);
    expect(await hasStore(STRANGER)).toBe(false);
  });

  it('welcomes a stranger who presents a valid code, and creates their store', async () => {
    const { code } = await invite();
    expect(await startCommand(STRANGER, code)).toBe(WELCOME);
    expect(await hasStore(STRANGER)).toBe(true);
  });

  it('welcomes an existing owner without spending a code', async () => {
    await provisionStore(OWNER);
    const { code } = await invite();
    expect(await startCommand(OWNER, code)).toBe(WELCOME);
    // The code is still good for someone else.
    expect(await redeemInvite(code, OTHER)).toBe('redeemed');
  });
});

describe('resetCommand', () => {
  async function ownerWithEditedStock(): Promise<void> {
    await provisionStore(OWNER);
    const [row] = await db.select().from(products).where(eq(products.storeId, OWNER)).limit(1);
    await db.update(products).set({ quantityBase: 777 }).where(eq(products.id, row!.id));
  }

  async function edited(): Promise<number> {
    const rows = await db.select().from(products).where(eq(products.storeId, OWNER));
    return rows.filter((r) => r.quantityBase === 777).length;
  }

  it('explains and changes nothing without the confirm argument', async () => {
    await ownerWithEditedStock();
    expect(await resetCommand(OWNER, '')).toBe(RESET_EXPLAINER);
    expect(await resetCommand(OWNER, 'please')).toBe(RESET_EXPLAINER);
    expect(await edited()).toBe(1);
  });

  it('restores the starting state on /reset confirm, in any case', async () => {
    await ownerWithEditedStock();
    await resetCommand(OWNER, 'CONFIRM');
    expect(await edited()).toBe(0);
  });
});

describe('newCommand', () => {
  it('confirms that stock and preferences are kept', async () => {
    await provisionStore(OWNER);
    expect(await newCommand(OWNER)).toMatch(/unchanged/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/telegram/commands.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement the messages** — create `src/telegram/messages.ts`:

```ts
/** Every fixed string the owner can see from the transport layer, in one place. */

export const WELCOME = [
  'Namaste! I run your shop from this chat.',
  '',
  'Try: "how much sugar is left?", "50 packets of Maggi came in, cost ₹12, MRP ₹14",',
  '"make a bill: 2kg sugar, 4 Maggi, UPI", "what\'s running out?"',
  '',
  '/new — fresh conversation (your stock, khata and preferences stay)',
  '/reset — restore this shop to its starting state (asks you to confirm)',
].join('\n');

export const PRIVATE_MESSAGE =
  'This is a private bot. If you have an invite code, send /start <your code>.';

export const INVALID_CODE =
  'That code is not valid — it may be used, revoked or mistyped. Check it with whoever invited you.';

export const RESET_EXPLAINER =
  'This wipes your stock, bills and khata and restores the starting demo shop. ' +
  'If you are sure, send /reset confirm.';

export const RATE_LIMITED_REPLY = 'Too many messages too fast. Give it a few minutes and try again.';

export const DAILY_CAP_REPLY =
  "This shop has reached today's usage limit. It resets at midnight IST.";
```

- [ ] **Step 4: Implement the commands** — create `src/telegram/commands.ts`:

```ts
import { hasStore, redeemInvite } from '../repositories/access.js';
import { clearSession } from '../repositories/updates.js';
import { reseedStore } from '../seed/index.js';
import {
  INVALID_CODE,
  PRIVATE_MESSAGE,
  RESET_EXPLAINER,
  WELCOME,
} from './messages.js';

/**
 * Command logic as plain functions. bot.ts only adapts grammY to these, so they can be
 * tested against the real database without a Telegram update in sight.
 */

export async function startCommand(chatId: bigint, arg: string): Promise<string> {
  // An existing owner never spends a code, whatever they typed after /start.
  if (await hasStore(chatId)) return WELCOME;
  if (arg.trim() === '') return PRIVATE_MESSAGE;
  return (await redeemInvite(arg, chatId)) === 'redeemed' ? WELCOME : INVALID_CODE;
}

export async function newCommand(chatId: bigint): Promise<string> {
  await clearSession(chatId);
  return 'Fresh chat. Your stock, khata and preferences are unchanged.';
}

/** Destructive, so it takes an explicit second word. Anything else explains and does nothing. */
export async function resetCommand(chatId: bigint, arg: string): Promise<string> {
  if (arg.trim().toLowerCase() !== 'confirm') return RESET_EXPLAINER;
  await reseedStore(chatId);
  await clearSession(chatId);
  return 'Shop restored to its starting state.';
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run src/telegram/commands.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/telegram/messages.ts src/telegram/commands.ts src/telegram/commands.test.ts
git commit -m "feat: invite-aware /start and confirm-gated /reset as testable functions"
```

---

### Task 8: Access gate, turn wiring and bot assembly

**Files:**
- Create: `src/telegram/gate.ts`
- Modify: `src/telegram/bot.ts`
- Modify: `src/telegram/turn.ts`
- Modify: `src/observability/log.ts`
- Modify: `src/observability/log.test.ts`
- Test: `src/telegram/gate.test.ts`
- Test: `src/telegram/bot.access.test.ts`

**Interfaces:**
- Consumes: Tasks 3–7.
- Produces:
  - `gate.ts`: `isStartCommand(text: string | undefined): boolean`, `decideAccess(input: { hasStore: boolean; text: string | undefined }): 'allow' | 'deny'`, `accessGate: (ctx: Context, next: NextFunction) => Promise<void>`
  - `bot.ts`: `createBot(token: string, botInfo?: UserFromGetMe): Bot` and `export const bot` (same name and role as today)
  - `log.ts`: `export type TurnOutcome`, `TurnLog` gains `costUsd?: number`, `numTurns?: number`

- [ ] **Step 1: Write the failing unit tests** — create `src/telegram/gate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decideAccess, isStartCommand } from './gate.js';

describe('isStartCommand', () => {
  it('recognises /start with or without an argument or bot suffix', () => {
    expect(isStartCommand('/start')).toBe(true);
    expect(isStartCommand('/start abc123')).toBe(true);
    expect(isStartCommand('/start@divagentBot abc123')).toBe(true);
    expect(isStartCommand('  /start  ')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isStartCommand(undefined)).toBe(false);
    expect(isStartCommand('')).toBe(false);
    expect(isStartCommand('hello')).toBe(false);
    expect(isStartCommand('/reset confirm')).toBe(false);
    expect(isStartCommand('please /start')).toBe(false);
    expect(isStartCommand('/starting')).toBe(false);
  });
});

describe('decideAccess', () => {
  it('allows anyone who owns a store', () => {
    expect(decideAccess({ hasStore: true, text: 'how much sugar?' })).toBe('allow');
    expect(decideAccess({ hasStore: true, text: undefined })).toBe('allow');
  });

  it('lets a stranger send only /start', () => {
    expect(decideAccess({ hasStore: false, text: '/start code' })).toBe('allow');
    expect(decideAccess({ hasStore: false, text: 'how much sugar?' })).toBe('deny');
    expect(decideAccess({ hasStore: false, text: '/reset confirm' })).toBe('deny');
    expect(decideAccess({ hasStore: false, text: undefined })).toBe('deny'); // voice, photo, sticker
  });
});
```

Add to `src/observability/log.test.ts` a test following that file's existing console-spy pattern (read the file first and match its setup):

```ts
  it('records cost, turn count and the wider outcome set', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((l: string) => void lines.push(l));
    logTurn({
      updateId: 1n,
      storeId: 2n,
      tools: [],
      durationMs: 5,
      outcome: 'daily_cap',
      costUsd: 0.1234,
      numTurns: 3,
    });
    spy.mockRestore();
    expect(JSON.parse(lines[0]!)).toMatchObject({ outcome: 'daily_cap', cost_usd: 0.1234, num_turns: 3 });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/telegram/gate.test.ts src/observability`
Expected: FAIL.

- [ ] **Step 3: Implement the log change** — in `src/observability/log.ts`, replace the `outcome` field and add the two optional fields and their output:

```ts
export type TurnOutcome =
  | 'ok'
  | 'error'
  | 'max_turns'
  | 'max_budget'
  | 'timeout'
  | 'rate_limited'
  | 'daily_cap';

export interface TurnLog {
  updateId: bigint;
  storeId: bigint;
  tools: string[];
  durationMs: number;
  outcome: TurnOutcome;
  costUsd?: number;
  numTurns?: number;
  text?: string;
  error?: unknown;
}
```

and inside `logTurn`, after `outcome: entry.outcome,` add nothing to the literal; instead, after the `line` literal is built:

```ts
  if (entry.costUsd !== undefined) line.cost_usd = entry.costUsd;
  if (entry.numTurns !== undefined) line.num_turns = entry.numTurns;
```

- [ ] **Step 4: Implement the gate** — create `src/telegram/gate.ts`:

```ts
import type { Context, NextFunction } from 'grammy';
import { hasStore } from '../repositories/access.js';
import { PRIVATE_MESSAGE } from './messages.js';

/** True for `/start` and `/start@botname …` — the one command a stranger may send. */
export function isStartCommand(text: string | undefined): boolean {
  if (!text) return false;
  const first = text.trim().split(/\s+/)[0] ?? '';
  return first.split('@')[0] === '/start';
}

/**
 * Authorization, not intent routing: does this chat own a store, and if not, is it asking to
 * redeem a code? Nothing here looks at what the owner is trying to do with the shop.
 */
export function decideAccess(input: {
  hasStore: boolean;
  text: string | undefined;
}): 'allow' | 'deny' {
  if (input.hasStore) return 'allow';
  return isStartCommand(input.text) ? 'allow' : 'deny';
}

/** First middleware on the bot. A denied chat gets one fixed reply and costs nothing. */
export async function accessGate(ctx: Context, next: NextFunction): Promise<void> {
  if (!ctx.chat) return;
  const decision = decideAccess({
    hasStore: await hasStore(BigInt(ctx.chat.id)),
    text: ctx.message?.text,
  });
  if (decision === 'allow') return next();
  await ctx.reply(PRIVATE_MESSAGE);
}
```

- [ ] **Step 5: Wire the turn** — in `src/telegram/turn.ts`:

Add imports:

```ts
import { completeUpdate, getSessionCostMicroUsd, getSessionId, setSessionId, claimUpdate } from '../repositories/updates.js';
import { recordUsage, spentTodayMicroUsd } from '../repositories/usage.js';
import { microUsd } from '../agent/limits.js';
import { turnLimiter } from './rate-limit.js';
import { DAILY_CAP_REPLY, RATE_LIMITED_REPLY } from './messages.js';
```

(merge with the existing `../repositories/updates.js` import rather than duplicating it) and below `const env = loadEnv();` add:

```ts
const DAILY_CAP_MICRO_USD = microUsd(env.STORE_DAILY_BUDGET_USD);
```

Replace the body of `handleTurn` from the `await provisionStore(storeId);` line to the end of the function with:

```ts
  const logOptions = { includeText: shouldLogMessageText(env) };

  // A refusal completes the update: a redelivery of a message we deliberately declined must
  // not be reprocessed.
  const refuse = async (outcome: 'rate_limited' | 'daily_cap', message: string): Promise<void> => {
    await ctx.reply(message);
    await completeUpdate(updateId);
    logTurn(
      { updateId, storeId, text, tools: [], durationMs: Date.now() - startedAt, outcome },
      logOptions,
    );
  };

  if (!turnLimiter.tryConsume(String(storeId))) {
    return refuse('rate_limited', RATE_LIMITED_REPLY);
  }
  // At the cap counts as over it: the budget is a ceiling, not a target.
  if ((await spentTodayMicroUsd(storeId)) >= DAILY_CAP_MICRO_USD) {
    return refuse('daily_cap', DAILY_CAP_REPLY);
  }

  await provisionStore(storeId);
  await ctx.replyWithChatAction('typing');

  try {
    const sessionId = await getSessionId(storeId);
    const priorMicro = await getSessionCostMicroUsd(storeId);
    const preferences = await readPreferences(storeId);

    const turnContext = newToolContext(storeId, updateId);
    const result = await toolContext.run(turnContext, () =>
      runAgent({ text, sessionId, preferences, priorCostUsd: priorMicro / 1_000_000 }),
    );

    if (result.sessionId) {
      await setSessionId(storeId, result.sessionId, microUsd(result.totalCostUsd));
    }
    // Accounting must never fail the turn: the owner's reply is more important than the ledger.
    try {
      await recordUsage(storeId, microUsd(result.turnCostUsd));
    } catch (error) {
      console.error(redact({ scope: 'usage', storeId: String(storeId), error }));
    }

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
        outcome: result.outcome,
        costUsd: result.turnCostUsd,
        numTurns: result.numTurns,
      },
      logOptions,
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
      logOptions,
    );
    await ctx.reply('Something went wrong on my side. Try that again?');
    // Deliberately NOT completed: the claim goes stale and a retry can reprocess it.
  }
}
```

- [ ] **Step 6: Rebuild `bot.ts` around `createBot`** — replace the whole file:

```ts
import { Bot, type CommandContext, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { loadEnv } from '../config/env.js';
import { downloadTelegramFile } from '../media/download.js';
import { transcribe } from '../media/transcribe.js';
import { claimUpdate, completeUpdate } from '../repositories/updates.js';
import { newCommand, resetCommand, startCommand } from './commands.js';
import { accessGate } from './gate.js';
import { RATE_LIMITED_REPLY, WELCOME } from './messages.js';
import { turnLimiter } from './rate-limit.js';
import { redact } from './redact.js';
import { handleTurn } from './turn.js';

const env = loadEnv();

/** Voice notes are ~60s of Opus at most; anything longer is a mis-tap, not a shop instruction. */
const MAX_VOICE_SECONDS = 60;

/**
 * Wraps a command handler so a failure replies instead of propagating.
 *
 * Without this, an error inside a command reaches grammY's default handler, which calls
 * bot.stop() — a single database blip would take the bot down.
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

/** The text after the command, e.g. the code in `/start abc123`. */
function argOf(ctx: CommandContext<Context>): string {
  return typeof ctx.match === 'string' ? ctx.match : '';
}

/**
 * Builds the bot. A factory so tests can pass `botInfo` (skipping the network `getMe`) and
 * intercept outgoing API calls; production uses the `bot` export below.
 */
export function createBot(token: string, botInfo?: UserFromGetMe): Bot {
  const bot = new Bot(token, botInfo ? { botInfo } : undefined);

  // First: nothing below runs for a chat that has no store and is not redeeming a code.
  bot.use(accessGate);

  bot.command(
    'start',
    guarded(async (ctx) => {
      await ctx.reply(await startCommand(BigInt(ctx.chat.id), argOf(ctx)));
    }),
  );

  bot.command(
    'help',
    guarded(async (ctx) => {
      await ctx.reply(WELCOME);
    }),
  );

  bot.command(
    'new',
    guarded(async (ctx) => {
      await ctx.reply(await newCommand(BigInt(ctx.chat.id)));
    }),
  );

  bot.command(
    'reset',
    guarded(async (ctx) => {
      await ctx.reply(await resetCommand(BigInt(ctx.chat.id), argOf(ctx)));
    }),
  );

  bot.on('message:text', async (ctx) => {
    await handleTurn(ctx, ctx.message.text);
  });

  bot.on('message:voice', async (ctx) => {
    // Guard on the metadata Telegram already sent, before spending a download.
    if (ctx.message.voice.duration > MAX_VOICE_SECONDS) {
      await ctx.reply(`That is a long one — keep voice notes under ${MAX_VOICE_SECONDS} seconds.`);
      return;
    }

    // Claim before spending anything, not after. handleTurn's own claim runs too late for
    // voice: by the time it would run, the file is already downloaded and the Whisper call
    // already paid for. A genuine redelivery (the crash-mid-turn case claimUpdate exists for)
    // must not repeat either of those, so this handler claims the update itself and hands the
    // result down.
    const updateId = BigInt(ctx.update.update_id);
    const storeId = BigInt(ctx.chat.id);
    const claim = await claimUpdate(updateId, storeId);
    if (claim === 'duplicate') return;

    // Voice spends before handleTurn does, so it must be rate-limited before the download.
    // handleTurn consumes one more, which makes a voice note count double — it costs double.
    if (!turnLimiter.tryConsume(String(storeId))) {
      await ctx.reply(RATE_LIMITED_REPLY);
      await completeUpdate(updateId);
      return;
    }

    let transcript: string;
    try {
      const audio = await downloadTelegramFile(ctx, env.TELEGRAM_BOT_TOKEN);
      transcript = await transcribe(
        audio,
        ctx.message.voice.mime_type ?? 'audio/ogg',
        env.OPENAI_API_KEY,
      );
    } catch (error) {
      console.error(redact({ scope: 'voice', chatId: String(ctx.chat.id), error }));
      await ctx.reply('I could not make out that voice note. Try again, or type it?');
      return;
    }

    if (!transcript) {
      await ctx.reply('That sounded empty — say it again?');
      return;
    }

    // Echo before acting. "Do" (2) and "das" (10) differ by one phoneme, and a misheard
    // quantity silently becomes a wrong bill. This does NOT wait for confirmation — it makes
    // the mistake visible in the same turn the money moves.
    await ctx.reply(`Heard: ${transcript}`);
    await handleTurn(ctx, transcript, { alreadyClaimed: true });
  });

  /**
   * Replaces grammY's default handler, which logs the error, calls bot.stop() and rethrows.
   * Keeping the bot alive matters more than surfacing the failure loudly, and the redactor is
   * what keeps ctx.api.token out of the log.
   */
  bot.catch((error) => {
    console.error(redact({ scope: 'bot', error }));
  });

  return bot;
}

export const bot = createBot(env.TELEGRAM_BOT_TOKEN);
```

Note: the previous `/new` and `/reset` handlers called `provisionStore` first. The gate now guarantees the chat owns a store, so those calls are dropped. `handleTurn` still calls `provisionStore` (idempotent, and unchanged) — leave it.

- [ ] **Step 7: Write the failing integration test** — create `src/telegram/bot.access.test.ts`. It drives the real `createBot` with fake updates, intercepts Telegram API calls, and mocks the agent and the voice download so any call to them is detectable:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { inviteCodes, processedUpdates, stores } from '../db/schema.js';

vi.mock('../agent/runtime.js', () => ({
  runAgent: vi.fn().mockResolvedValue({
    reply: 'agent says hi',
    sessionId: 'sess-1',
    toolsUsed: [],
    outcome: 'ok',
    totalCostUsd: 0.01,
    turnCostUsd: 0.01,
    numTurns: 1,
  }),
}));
vi.mock('../media/download.js', () => ({
  downloadTelegramFile: vi.fn().mockResolvedValue(Buffer.from('x')),
}));
vi.mock('../media/transcribe.js', () => ({ transcribe: vi.fn().mockResolvedValue('hello') }));

const { createBot } = await import('./bot.js');
const { runAgent } = await import('../agent/runtime.js');
const { downloadTelegramFile } = await import('../media/download.js');
const { createInvite } = await import('../repositories/access.js');
const { recordUsage } = await import('../repositories/usage.js');
const { provisionStore } = await import('../repositories/stores.js');
const { loadEnv } = await import('../config/env.js');
const { PRIVATE_MESSAGE, DAILY_CAP_REPLY, RATE_LIMITED_REPLY, WELCOME } = await import('./messages.js');
const { microUsd } = await import('../agent/limits.js');

const STRANGER = 999100030n;
const OWNER = 999100031n;
const CAPPED = 999100032n;
const SPAMMER = 999100033n;
const GROUP = -999100034n;
const ALL = [STRANGER, OWNER, CAPPED, SPAMMER, GROUP];
const made: string[] = [];
const env = loadEnv();

const sent: { method: string; payload: Record<string, unknown> }[] = [];

function makeBot() {
  const bot = createBot('123456:test-token-not-real', {
    id: 1,
    is_bot: true,
    first_name: 'Test',
    username: 'test_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  } as never);
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: true } as never;
  });
  return bot;
}

let nextId = 5_000_000;
function textUpdate(chatId: bigint, text: string) {
  const id = nextId++;
  const isCommand = text.startsWith('/');
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: Number(chatId), type: chatId < 0n ? 'group' : 'private', title: 'T', first_name: 'T' },
      from: { id: Number(chatId), is_bot: false, first_name: 'T' },
      text,
      ...(isCommand
        ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] }
        : {}),
    },
  };
}

function voiceUpdate(chatId: bigint) {
  const id = nextId++;
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: Number(chatId), type: 'private', first_name: 'T' },
      from: { id: Number(chatId), is_bot: false, first_name: 'T' },
      voice: { file_id: 'f', file_unique_id: 'u', duration: 3, mime_type: 'audio/ogg' },
    },
  };
}

const replies = () => sent.filter((s) => s.method === 'sendMessage').map((s) => String(s.payload.text));

beforeEach(async () => {
  sent.length = 0;
  vi.mocked(runAgent).mockClear();
  vi.mocked(downloadTelegramFile).mockClear();
  await db.delete(stores).where(inArray(stores.id, ALL));
});

afterAll(async () => {
  await db.delete(stores).where(inArray(stores.id, ALL));
  await db.delete(processedUpdates).where(inArray(processedUpdates.chatId, ALL));
  if (made.length) await db.delete(inviteCodes).where(inArray(inviteCodes.id, made));
  await pool.end();
});

describe('access gate', () => {
  it('turns a stranger away with one fixed reply and makes no agent call', async () => {
    const bot = makeBot();
    await bot.handleUpdate(textUpdate(STRANGER, 'how much sugar is left?') as never);
    expect(replies()).toEqual([PRIVATE_MESSAGE]);
    expect(runAgent).not.toHaveBeenCalled();
    expect(await db.select().from(stores).where(inArray(stores.id, [STRANGER]))).toHaveLength(0);
  });

  it('does not let a stranger run /reset', async () => {
    const bot = makeBot();
    await bot.handleUpdate(textUpdate(STRANGER, '/reset confirm') as never);
    expect(replies()).toEqual([PRIVATE_MESSAGE]);
  });

  it('answers a stranger voice note without downloading or transcribing it', async () => {
    const bot = makeBot();
    await bot.handleUpdate(voiceUpdate(STRANGER) as never);
    expect(replies()).toEqual([PRIVATE_MESSAGE]);
    expect(downloadTelegramFile).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('redeems a code via /start, then lets the new owner talk to the agent', async () => {
    const { id, code } = await createInvite();
    made.push(id);
    const bot = makeBot();

    await bot.handleUpdate(textUpdate(STRANGER, `/start ${code}`) as never);
    expect(replies()).toEqual([WELCOME]);

    await bot.handleUpdate(textUpdate(STRANGER, 'how much sugar is left?') as never);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(replies()).toContain('agent says hi');
  });

  it('redeems from a group chat and lets the group talk afterwards', async () => {
    const { id, code } = await createInvite();
    made.push(id);
    const bot = makeBot();

    await bot.handleUpdate(textUpdate(GROUP, `/start ${code}`) as never);
    await bot.handleUpdate(textUpdate(GROUP, 'stock check') as never);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it('keeps an existing owner working with no code at all', async () => {
    await provisionStore(OWNER);
    const bot = makeBot();
    await bot.handleUpdate(textUpdate(OWNER, 'hello') as never);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });
});

describe('spend and rate guards', () => {
  it('refuses a turn once the store has spent its daily budget, with no agent call', async () => {
    await provisionStore(CAPPED);
    await recordUsage(CAPPED, microUsd(env.STORE_DAILY_BUDGET_USD)); // exactly at the cap
    const bot = makeBot();

    await bot.handleUpdate(textUpdate(CAPPED, 'hello') as never);

    expect(replies()).toEqual([DAILY_CAP_REPLY]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('rate-limits a chat after RATE_LIMIT_TURNS turns in the window', async () => {
    await provisionStore(SPAMMER);
    const bot = makeBot();

    for (let i = 0; i < env.RATE_LIMIT_TURNS; i++) {
      await bot.handleUpdate(textUpdate(SPAMMER, `msg ${i}`) as never);
    }
    expect(runAgent).toHaveBeenCalledTimes(env.RATE_LIMIT_TURNS);

    await bot.handleUpdate(textUpdate(SPAMMER, 'one too many') as never);
    expect(runAgent).toHaveBeenCalledTimes(env.RATE_LIMIT_TURNS);
    expect(replies().at(-1)).toBe(RATE_LIMITED_REPLY);
  });
});
```

- [ ] **Step 8: Run to verify failure, then implement until it passes**

Run: `pnpm vitest run src/telegram`
Expected before Steps 3–6 are in place: FAIL. After: PASS.

If `createBot`'s `botInfo` option or the `bot.api.config.use` interception does not behave as written, that is a harness problem, not a product bug: check grammY's docs for `BotConfig.botInfo` and `api.config.use` and adjust the harness only, not the assertions.

- [ ] **Step 9: Prove the guards matter** — one at a time, and restoring each afterwards: (a) delete the `bot.use(accessGate)` line → the stranger tests must fail; (b) delete the `spentTodayMicroUsd` check in `turn.ts` → the daily-cap test must fail; (c) delete the `turnLimiter.tryConsume` check → the rate-limit test must fail.

- [ ] **Step 10: Commit**

```bash
git add src/telegram src/observability
git commit -m "feat: access gate, daily budget and rate limit wired into the bot"
```

---

### Task 9: Invite CLI

**Files:**
- Create: `src/scripts/invite.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `createInvite`, `revokeInvite`, `listInvites` (Task 3).
- Produces: `pnpm invite create | list | revoke <id>`; in the production image `node dist/scripts/invite.js <same>`.

- [ ] **Step 1: Implement** — create `src/scripts/invite.ts`:

```ts
import 'dotenv/config';
import { pool } from '../db/client.js';
import { createInvite, listInvites, revokeInvite } from '../repositories/access.js';

const USAGE = 'Usage: invite create | invite list | invite revoke <id>';

async function main(): Promise<number> {
  const [command, arg] = process.argv.slice(2);

  if (command === 'create') {
    const { id, code } = await createInvite();
    console.log(`Invite created (id ${id}).`);
    console.log(`Code: ${code}`);
    console.log('This is the only time the code is shown. The owner sends: /start ' + code);
    return 0;
  }

  if (command === 'list') {
    const rows = await listInvites();
    if (rows.length === 0) console.log('No invites.');
    for (const r of rows) {
      const state = r.revokedAt ? 'revoked' : r.usedAt ? `used by chat ${r.usedByChat}` : 'unused';
      console.log(`${r.id}  ${r.createdAt.toISOString()}  ${state}`);
    }
    return 0;
  }

  if (command === 'revoke' && arg) {
    const revoked = await revokeInvite(arg);
    console.log(
      revoked ? `Revoked ${arg}.` : `Nothing revoked: ${arg} is unknown, already used or already revoked.`,
    );
    return revoked ? 0 : 1;
  }

  console.error(USAGE);
  return 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
```

- [ ] **Step 2: Add the script** — in `package.json` `scripts`, add after `"db:migrate"`:

```json
    "invite": "tsx src/scripts/invite.ts",
```

- [ ] **Step 3: Exercise it against the local database**

Run: `pnpm invite create`, then `pnpm invite list`, then `pnpm invite revoke <the id printed>`, then `pnpm invite revoke <same id>`.
Expected: a code is printed once; `list` shows `unused` then `revoked`; the first revoke prints `Revoked …` and exits 0; the second prints `Nothing revoked …` and exits 1; and `pnpm invite` with no argument prints the usage line and exits 2.

- [ ] **Step 4: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/scripts package.json
git commit -m "feat: invite create/list/revoke CLI"
```

---

### Task 10: Documentation, full gate and live verification

**Files:**
- Modify: `docs/DEPLOY.md`
- Modify: `CLAUDE.md` (architecture map and §5 invariants table only)
- Modify: `README.md` (one short "Access and limits" paragraph and the `/reset` line)
- Modify: `HANDOFF.md`, `tasks/todo.md`, `tasks/agent_memory.md`, `tasks/lessons.md` if anything was learned

- [ ] **Step 1: DEPLOY.md** — add the eight new variables to the environment table (all optional, defaults as in Global Constraints). Add a section **Inviting an owner**:

```markdown
## Inviting an owner

The bot is private. A chat with no store gets "This is a private bot" and nothing else, and
`/start <code>` is the only way in. Codes are single-use, shown once, stored hashed.

    pnpm invite create          # prints the code once
    pnpm invite list            # id, created, state — never the code
    pnpm invite revoke <id>     # only works on an unused code

Against production, run the same command with the production `DATABASE_URL` (the public
connection string from Railway, not the internal one), or from a shell on the service as
`node dist/scripts/invite.js create`.

Revoking stops a code from being redeemed. It does not cut off a shop that already redeemed one.

Known limits: the per-chat rate limiter is in memory and resets on restart (fine for one
replica); a turn that is aborted by the timeout reports no cost, so the daily budget can
under-count by up to one per-run cap.
```

- [ ] **Step 2: Other docs** — in `CLAUDE.md` add `access.ts`/`usage.ts` to the architecture map and a row to the §5 table: *Access — only chats that own a store reach the agent; invite codes redeemed atomically (`repositories/access.ts`, `telegram/gate.ts`)* and *Spend — per-run limits, per-store daily budget, per-chat rate limit (`agent/limits.ts`, `repositories/usage.ts`, `telegram/rate-limit.ts`)*. In `README.md`, change the `/start` mention to say the bot is invite-only and add the confirm to `/reset`. Update `HANDOFF.md` (current state: sub-project A complete on `production-hardening`, next action: sub-project B plan) and tick the items in `tasks/todo.md`.

- [ ] **Step 3: Run the full gate**

Run: `pnpm fmt && pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test`
Expected: all green. Report the test count and compare it with the 236 baseline; a gate run that was not performed must be reported as not performed.

- [ ] **Step 4: Run the gate a second and third time**

Run: `pnpm test` twice more.
Expected: green both times. The suite has a history of order-dependent flakes, so one green run is not enough.

- [ ] **Step 5: Live check against the real bot** (needs a deployed or locally running bot with a real token)

With `pnpm dev` running and one test chat that has never used the bot:
1. Send "hello" → expect only the private-bot reply.
2. `pnpm invite create`, send `/start <code>` → expect the welcome.
3. Send the same code from a second chat → expect the invalid-code reply.
4. Send `/reset` → expect the explainer and unchanged stock; `/reset confirm` → expect the restore.
5. Check the log line for a normal turn includes `cost_usd` and `num_turns`.

- [ ] **Step 6: Commit**

```bash
git add docs CLAUDE.md README.md HANDOFF.md tasks
git commit -m "docs: invite-only access, spend limits and operating notes"
```

---

## Self-review

**Spec coverage (§A):** invite table with hash and conditional redemption → Tasks 2–3; middleware before every handler, fixed reply, no model call → Task 8; `/start <code>` → Tasks 7–8; scripts → Task 9; existing stores keep working (a store row *is* access, so no migration is needed — noted in Task 3's `hasStore`) → Tasks 3 and 8 ("keeps an existing owner working"); `maxTurns`, budget, timeout → Task 6; daily cap and `usage` table → Tasks 4 and 8; per-chat rate limit → Tasks 5 and 8; cost and turn count logged → Tasks 6 and 8; `AGENT_MODEL` / `AGENT_FALLBACK_MODEL` → Tasks 1 and 6; `/reset confirm` → Task 7; every spec test (unredeemed → zero agent calls, no double redemption incl. concurrent, revoked rejected, cap blocks before model, bare reset untouched, timeout aborts cleanly) → Tasks 3, 7, 8, 6. The timeout abort itself is covered by the outcome reply test and the live e2e, **not** by an automated test of an actual abort, because that needs a live model call; it is stated here rather than implied.

**Deviation from the spec, flagged:** the spec said "revoke" applies to codes; this plan makes revoke a no-op on an already-redeemed code (documented in DEPLOY.md). Cutting off a redeemed shop is not built; it is a known limit.

**Type consistency:** `AgentResult` fields (`outcome`, `totalCostUsd`, `turnCostUsd`, `numTurns`) are defined in Task 6 and used with the same names in Task 8's turn wiring and mock. `setSessionId`'s third parameter is `costMicroUsd` in Task 4 and called with `microUsd(result.totalCostUsd)` in Task 8. `TurnOutcome` in Task 8 is a superset of `AgentOutcome` from Task 6.

**Open verification points inside the plan:** `SDK_COST_IS_CUMULATIVE` (Task 6 probe, with a stop-and-re-plan branch), the grammY test harness (Task 8 Step 8), and whether any e2e beat exceeds the $0.50 default (Task 6 Step 10).
