# Session Durability and Graceful Shutdown Implementation Plan (sub-project B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shop's conversation survives any redeploy, and a restart or shutdown never silently drops the owner's message that was being handled.

**Architecture:** Mirror Agent SDK transcripts into Postgres through the SDK's `sessionStore` option, so `resume` works from the database on a fresh container. A stored session with no stored entries is dropped to a fresh session (cost chain reset) before the run, and a resume that fails to start is retried once without `resume`. Shutdown stops taking new updates with a first middleware that never returns, drains the in-flight turn up to a grace period, and exits without `bot.stop()`; boot expires every `claimed` row so a redelivered update is reclaimed.

**Tech Stack:** TypeScript, grammY 1.45 (sequential long-polling, unchanged), Drizzle + Postgres, Claude Agent SDK (`sessionStore`, `SDKMirrorErrorMessage`), Vitest.

**Spec:** `docs/specs/2026-10-04-production-hardening-design.md` §B (amended 2026-10-04).

## Global Constraints

- Stay on sequential `bot.start`. The grammY runner is out of scope: it confirms update offsets early and can lose up to 100 fetched updates when killed (grammY docs, "Reliability Guarantees > grammY Runner"), which would break the `processed_updates` redelivery design (AD-16).
- **Never call `bot.stop()` on shutdown.** In the installed grammY (`node_modules/grammy/out/bot.js`, `stop()`), it aborts polling and then calls `getUpdates` with `offset = lastTriedUpdateId + 1`, which confirms the update currently being handled.
- Agent SDK facts (verified in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` and the SDK docs, 2026-10-04): `SessionStore` requires `append(key, entries)` and `load(key)` (return `null` for a never-written key; entries must come back deep-equal and in append order); optional `delete(key)` (deleting the main key, no `subpath`, must cascade to all subkeys). Entries are opaque JSON objects with a string `type`; most carry a stable `uuid`, and adapters SHOULD treat `uuid` as an idempotency key (ignore duplicates) because `append` is retried 3 times on rejection; entries without a `uuid` are appended without dedup. `SessionKey = { projectKey: string; sessionId: string; subpath?: string }` (empty-string `subpath` is invalid; omit it for the main transcript). The subprocess always writes locally first; a run resumed from the store deletes its local copy at run end. `persistSession: false` conflicts with a store. A failed batch emits `{ type: 'system', subtype: 'mirror_error', error: string, key, session_id }` and the run continues. `SessionStore` is marked `@alpha` in the SDK.
- Model-visible and log-visible data: a Postgres/Drizzle error message can embed query parameters, i.e. conversation content. **Never log a `mirror_error`'s `error` text or a store error's message verbatim** — log a fixed string plus the session id only.
- Money and cost rules from sub-project A stand: integer micro-USD, cost chain `priorCostUsd` / `totalCostUsd` / `turnCostUsd`; a run that starts a fresh session has `prior = 0`.
- `SHUTDOWN_GRACE_MS` default 30000, positive integer, max 120000, env-overridable.
- Every guard gets a test that fails without it. Gate: `pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test` (baseline after A: 321 tests). Tests run with `fileParallelism: false`; new tests use unique ids and clean up every row.
- Layering: `repositories/` own SQL; `agent/session-store.ts` is a thin adapter over a repository; `telegram/drain.ts` holds only process-lifecycle state; the agent layer must not import from `src/telegram`.
- Work on branch `production-hardening-b` (stacked on `production-hardening`, PR #1 not yet merged). Never commit to `main`.

## Review Focus

Failure modes the spec implies but no obvious test covers. Each has a test in the owning task.

1. **The SDK retries `append` up to 3 times, and a batch can land twice.** Duplicate `uuid` entries must not create duplicate rows; entries without a `uuid` must not be deduplicated. (Task 1.)
2. **A batch with one unserialisable entry must not leave half a batch.** The batch is one transaction. (Task 1.)
3. **A long conversation loads in order.** More than 100 entries across several batches come back in append order. (Task 1.)
4. **Mirror failures must not leak conversation text into logs.** A `mirror_error` whose `error` string contains owner text logs only a fixed message and the session id. (Task 4.)
5. **Sessions created before this change point at transcripts that existed only on a deleted container disk.** The first message after deploy must start a fresh session with prior cost 0 and replace the stale row, with no error reply. (Task 4.)
6. **An update that arrives during shutdown must be neither handled nor confirmed.** It must never resolve (so grammY's loop issues no further `getUpdates`) and must not be claimed. (Task 6.)
7. **A turn cut off by a restart must be reprocessed on redelivery even within 300 s.** Boot expires `claimed` rows; `done` rows stay duplicates. (Task 3.)
8. **`/new` and `/reset confirm` must not orphan the stored conversation.** (Task 3.)

---

## File Structure

| File | Responsibility |
|---|---|
| `src/db/schema.ts` + new migration | `session_entries` table |
| `src/repositories/session-entries.ts` | SQL for the transcript mirror: append, load, delete, exists |
| `src/agent/session-store.ts` | `postgresSessionStore` (SDK `SessionStore`) and `sessionExists` |
| `src/repositories/updates.ts` | `clearSession` also deletes stored entries; `expireInFlightClaims` |
| `src/agent/runtime.ts` | Passes the store; drops an unknown resume; retries a failed start once; logs mirror failures safely |
| `src/agent/cost.probe.ts` sibling: `src/agent/session-store.probe.ts` | Manual live probe: resume from the store on a different config dir; failure signature of an unknown resume |
| `src/telegram/turn.ts` | Clears the stale `sessions` row when the resume was dropped and no new id arrived |
| `src/observability/log.ts` | `resumeDropped` field |
| `src/config/env.ts` | `SHUTDOWN_GRACE_MS` |
| `src/telegram/drain.ts` | `drainGate` middleware, `beginDrain`, in-flight tracking |
| `src/telegram/bot.ts` | `drainGate` is the first middleware |
| `src/index.ts` | Boot: expire in-flight claims. SIGTERM/SIGINT: drain, then exit with no `bot.stop()` |

---

### Task 1: Transcript table and repository

**Files:**
- Modify: `src/db/schema.ts`
- Create: generated `src/db/migrations/0005_*.sql` and `meta/` updates
- Create: `src/repositories/session-entries.ts`
- Test: `src/repositories/session-entries.test.ts`

**Interfaces:**
- Produces (all in `session-entries.ts`):
  - `interface EntryKey { projectKey: string; sessionId: string; subpath?: string }`
  - `appendEntries(key: EntryKey, entries: Record<string, unknown>[]): Promise<void>`
  - `loadEntries(key: EntryKey): Promise<Record<string, unknown>[] | null>`
  - `deleteEntries(key: EntryKey): Promise<void>` — no `subpath` deletes the session and every subpath
  - `deleteSessionEntries(sessionId: string): Promise<void>` — across all project keys
  - `sessionHasEntries(sessionId: string): Promise<boolean>`

- [ ] **Step 1: Write the failing tests** — create `src/repositories/session-entries.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { sessionEntries } from '../db/schema.js';
import {
  appendEntries,
  deleteEntries,
  deleteSessionEntries,
  loadEntries,
  sessionHasEntries,
} from './session-entries.js';

const PROJECT = '/test/project';
const used: string[] = [];

function fresh(): string {
  const id = randomUUID();
  used.push(id);
  return id;
}

afterAll(async () => {
  if (used.length) await db.delete(sessionEntries).where(inArray(sessionEntries.sessionId, used));
  await pool.end();
});

describe('loadEntries', () => {
  it('returns null for a session that was never written', async () => {
    expect(await loadEntries({ projectKey: PROJECT, sessionId: fresh() })).toBeNull();
  });
});

describe('appendEntries', () => {
  it('round-trips entries deep-equal and in order across batches', async () => {
    const sessionId = fresh();
    const key = { projectKey: PROJECT, sessionId };
    const a = { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello' } };
    const b = { type: 'assistant', uuid: 'u2', message: { content: [{ type: 'text', text: 'hi' }] } };
    const c = { type: 'summary', note: 'no uuid on this one' };

    await appendEntries(key, [a, b]);
    await appendEntries(key, [c]);

    expect(await loadEntries(key)).toEqual([a, b, c]);
  });

  it('keeps append order for a long conversation (more than 100 entries)', async () => {
    const sessionId = fresh();
    const key = { projectKey: PROJECT, sessionId };
    const all: Record<string, unknown>[] = [];
    for (let batch = 0; batch < 5; batch++) {
      const entries = Array.from({ length: 50 }, (_, i) => ({
        type: 'user',
        uuid: `${sessionId}-${batch}-${i}`,
        n: batch * 50 + i,
      }));
      all.push(...entries);
      await appendEntries(key, entries);
    }
    const loaded = await loadEntries(key);
    expect(loaded).toHaveLength(250);
    expect(loaded!.map((e) => e.n)).toEqual(all.map((e) => e.n));
  });

  it('ignores a duplicate uuid, so an SDK retry of a landed batch adds nothing', async () => {
    const sessionId = fresh();
    const key = { projectKey: PROJECT, sessionId };
    const batch = [
      { type: 'user', uuid: 'dup-1', n: 1 },
      { type: 'assistant', uuid: 'dup-2', n: 2 },
    ];
    await appendEntries(key, batch);
    await appendEntries(key, batch);
    expect(await loadEntries(key)).toEqual(batch);
  });

  it('does not deduplicate entries that carry no uuid', async () => {
    const sessionId = fresh();
    const key = { projectKey: PROJECT, sessionId };
    await appendEntries(key, [{ type: 'title', text: 'x' }]);
    await appendEntries(key, [{ type: 'title', text: 'x' }]);
    expect(await loadEntries(key)).toHaveLength(2);
  });

  it('writes a batch atomically: one bad entry leaves nothing behind', async () => {
    const sessionId = fresh();
    const key = { projectKey: PROJECT, sessionId };
    await expect(
      appendEntries(key, [
        { type: 'user', uuid: 'ok-1' },
        { type: 'user', uuid: 'bad-2', big: 10n }, // BigInt cannot be serialised to JSON
      ]),
    ).rejects.toThrow();
    expect(await loadEntries(key)).toBeNull();
  });

  it('treats a no-op append as success', async () => {
    const key = { projectKey: PROJECT, sessionId: fresh() };
    await expect(appendEntries(key, [])).resolves.toBeUndefined();
  });

  it('keeps the main transcript and a subpath separate', async () => {
    const sessionId = fresh();
    await appendEntries({ projectKey: PROJECT, sessionId }, [{ type: 'user', uuid: 'm1' }]);
    await appendEntries({ projectKey: PROJECT, sessionId, subpath: 'subagents/agent-1' }, [
      { type: 'user', uuid: 's1' },
    ]);
    expect(await loadEntries({ projectKey: PROJECT, sessionId })).toEqual([
      { type: 'user', uuid: 'm1' },
    ]);
    expect(
      await loadEntries({ projectKey: PROJECT, sessionId, subpath: 'subagents/agent-1' }),
    ).toEqual([{ type: 'user', uuid: 's1' }]);
  });
});

describe('deleteEntries', () => {
  it('deleting the main key cascades to every subpath', async () => {
    const sessionId = fresh();
    await appendEntries({ projectKey: PROJECT, sessionId }, [{ type: 'user', uuid: 'm1' }]);
    await appendEntries({ projectKey: PROJECT, sessionId, subpath: 'subagents/agent-1' }, [
      { type: 'user', uuid: 's1' },
    ]);
    await deleteEntries({ projectKey: PROJECT, sessionId });
    expect(await loadEntries({ projectKey: PROJECT, sessionId })).toBeNull();
    expect(
      await loadEntries({ projectKey: PROJECT, sessionId, subpath: 'subagents/agent-1' }),
    ).toBeNull();
  });

  it('deleting a subpath leaves the main transcript', async () => {
    const sessionId = fresh();
    await appendEntries({ projectKey: PROJECT, sessionId }, [{ type: 'user', uuid: 'm1' }]);
    await appendEntries({ projectKey: PROJECT, sessionId, subpath: 'subagents/agent-1' }, [
      { type: 'user', uuid: 's1' },
    ]);
    await deleteEntries({ projectKey: PROJECT, sessionId, subpath: 'subagents/agent-1' });
    expect(await loadEntries({ projectKey: PROJECT, sessionId })).toHaveLength(1);
  });
});

describe('sessionHasEntries / deleteSessionEntries', () => {
  it('reports whether any entries exist for a session id, under any project key', async () => {
    const sessionId = fresh();
    expect(await sessionHasEntries(sessionId)).toBe(false);
    await appendEntries({ projectKey: '/other/project', sessionId }, [{ type: 'user', uuid: 'x' }]);
    expect(await sessionHasEntries(sessionId)).toBe(true);
  });

  it('deleteSessionEntries removes the session across project keys', async () => {
    const sessionId = fresh();
    await appendEntries({ projectKey: '/a', sessionId }, [{ type: 'user', uuid: 'a1' }]);
    await appendEntries({ projectKey: '/b', sessionId }, [{ type: 'user', uuid: 'b1' }]);
    await deleteSessionEntries(sessionId);
    expect(await sessionHasEntries(sessionId)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/repositories/session-entries.test.ts`
Expected: FAIL — `sessionEntries` is not exported from the schema and `./session-entries.js` does not exist.

- [ ] **Step 3: Add the table** — in `src/db/schema.ts` add `bigserial` to the `drizzle-orm/pg-core` import list and append:

```ts
/**
 * Mirror of Agent SDK session transcripts, so `resume` works from the database on a fresh
 * container (the SDK's local transcript lives on a disk that a redeploy wipes).
 *
 * `id` is the append order. `subpath` is '' for the main transcript (the SDK forbids an empty
 * string, so '' is free to mean "none"). The partial unique index makes a retried batch
 * idempotent: most entries carry a stable `uuid`, and entries without one are never deduplicated.
 * Retention is ours: rows are deleted on /new and /reset, and abandoned conversations accumulate.
 */
export const sessionEntries = pgTable(
  'session_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectKey: text('project_key').notNull(),
    sessionId: text('session_id').notNull(),
    subpath: text('subpath').notNull().default(''),
    entryUuid: text('entry_uuid'),
    entry: jsonb('entry').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('session_entries_lookup_idx').on(t.sessionId, t.projectKey, t.subpath, t.id),
    uniqueIndex('session_entries_uuid_uq')
      .on(t.projectKey, t.sessionId, t.subpath, t.entryUuid)
      .where(sql`${t.entryUuid} is not null`),
  ],
);
```

- [ ] **Step 4: Generate and apply the migration**

Run: `pnpm db:generate && pnpm db:migrate`
Expected: a new `0005_*.sql` containing only `CREATE TABLE "session_entries"`, its lookup index and the partial unique index (`WHERE "session_entries"."entry_uuid" is not null`). Read the SQL before committing; it must not touch any existing table. If drizzle-kit prompts about renames, choose "create".

- [ ] **Step 5: Implement the repository** — create `src/repositories/session-entries.ts`:

```ts
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sessionEntries } from '../db/schema.js';

export interface EntryKey {
  projectKey: string;
  sessionId: string;
  /** Undefined = the main transcript. */
  subpath?: string;
}

const subpathOf = (key: EntryKey): string => key.subpath ?? '';

/**
 * Appends a batch in order, atomically.
 *
 * One row per entry inside one transaction, so ids ascend in batch order and a bad entry leaves
 * no partial batch. A duplicate `uuid` is ignored: the SDK retries a rejected append, and a
 * timed-out one may still have landed.
 */
export async function appendEntries(
  key: EntryKey,
  entries: Record<string, unknown>[],
): Promise<void> {
  if (entries.length === 0) return;
  await db.transaction(async (tx) => {
    for (const entry of entries) {
      await tx
        .insert(sessionEntries)
        .values({
          projectKey: key.projectKey,
          sessionId: key.sessionId,
          subpath: subpathOf(key),
          entryUuid: typeof entry.uuid === 'string' ? entry.uuid : null,
          entry,
        })
        .onConflictDoNothing();
    }
  });
}

/** Entries in append order, or null when nothing was ever written for the key. */
export async function loadEntries(key: EntryKey): Promise<Record<string, unknown>[] | null> {
  const rows = await db
    .select({ entry: sessionEntries.entry })
    .from(sessionEntries)
    .where(
      and(
        eq(sessionEntries.projectKey, key.projectKey),
        eq(sessionEntries.sessionId, key.sessionId),
        eq(sessionEntries.subpath, subpathOf(key)),
      ),
    )
    .orderBy(asc(sessionEntries.id));
  return rows.length === 0 ? null : rows.map((r) => r.entry);
}

/** No `subpath` deletes the whole session, every subpath included (the SDK's `delete` contract). */
export async function deleteEntries(key: EntryKey): Promise<void> {
  const scope = [
    eq(sessionEntries.projectKey, key.projectKey),
    eq(sessionEntries.sessionId, key.sessionId),
  ];
  if (key.subpath !== undefined) scope.push(eq(sessionEntries.subpath, key.subpath));
  await db.delete(sessionEntries).where(and(...scope));
}

/** Backs /new and /reset: the store schema is keyed by project, but a session id is a UUID. */
export async function deleteSessionEntries(sessionId: string): Promise<void> {
  await db.delete(sessionEntries).where(eq(sessionEntries.sessionId, sessionId));
}

export async function sessionHasEntries(sessionId: string): Promise<boolean> {
  const rows = await db
    .select({ id: sessionEntries.id })
    .from(sessionEntries)
    .where(eq(sessionEntries.sessionId, sessionId))
    .limit(1);
  return rows.length > 0;
}
```

- [ ] **Step 6: Run to verify pass**

Run: `pnpm vitest run src/repositories/session-entries.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Prove the guards matter** — one at a time, restoring each afterwards: (a) remove `.onConflictDoNothing()` → the "duplicate uuid" test must fail; (b) replace `db.transaction(...)` with plain sequential inserts on `db` → the "atomically" test must fail (the first entry stays); (c) drop `.orderBy(asc(sessionEntries.id))` → the 250-entry ordering test may or may not fail on a small table, so instead reverse the order (`desc`) and confirm the two ordering tests fail, then restore.

- [ ] **Step 8: Commit**

```bash
git add src/db src/repositories/session-entries.ts src/repositories/session-entries.test.ts
git commit -m "feat: session_entries table and transcript repository"
```

(Every commit message in this plan ends with a blank line and `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.)

---

### Task 2: SDK session-store adapter

**Files:**
- Create: `src/agent/session-store.ts`
- Test: `src/agent/session-store.test.ts`

**Interfaces:**
- Consumes: Task 1's repository functions.
- Produces: `postgresSessionStore: SessionStore` (from `@anthropic-ai/claude-agent-sdk`) and `sessionExists(sessionId: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing test** — create `src/agent/session-store.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { sessionEntries } from '../db/schema.js';
import { postgresSessionStore, sessionExists } from './session-store.js';

const used: string[] = [];
const fresh = (): string => {
  const id = randomUUID();
  used.push(id);
  return id;
};

afterAll(async () => {
  if (used.length) await db.delete(sessionEntries).where(inArray(sessionEntries.sessionId, used));
  await pool.end();
});

describe('postgresSessionStore', () => {
  it('returns null for a key that was never written', async () => {
    expect(await postgresSessionStore.load({ projectKey: '/p', sessionId: fresh() })).toBeNull();
  });

  it('loads exactly what was appended, in order', async () => {
    const key = { projectKey: '/p', sessionId: fresh() };
    const entries = [
      { type: 'user', uuid: 'a', message: 'one' },
      { type: 'assistant', uuid: 'b', message: 'two' },
    ];
    await postgresSessionStore.append(key, entries);
    expect(await postgresSessionStore.load(key)).toEqual(entries);
  });

  it('delete removes the session and its subpaths', async () => {
    const sessionId = fresh();
    await postgresSessionStore.append({ projectKey: '/p', sessionId }, [{ type: 'user', uuid: 'm' }]);
    await postgresSessionStore.append({ projectKey: '/p', sessionId, subpath: 'subagents/a' }, [
      { type: 'user', uuid: 's' },
    ]);
    await postgresSessionStore.delete!({ projectKey: '/p', sessionId });
    expect(await postgresSessionStore.load({ projectKey: '/p', sessionId })).toBeNull();
    expect(
      await postgresSessionStore.load({ projectKey: '/p', sessionId, subpath: 'subagents/a' }),
    ).toBeNull();
  });
});

describe('sessionExists', () => {
  it('is false for an unknown id and true once the session has been mirrored', async () => {
    const sessionId = fresh();
    expect(await sessionExists(sessionId)).toBe(false);
    await postgresSessionStore.append({ projectKey: '/p', sessionId }, [{ type: 'user', uuid: 'x' }]);
    expect(await sessionExists(sessionId)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/agent/session-store.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** — create `src/agent/session-store.ts`:

```ts
import type { SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import {
  appendEntries,
  deleteEntries,
  loadEntries,
  sessionHasEntries,
} from '../repositories/session-entries.js';

/**
 * Postgres-backed transcript mirror for the Agent SDK's `sessionStore` option.
 *
 * The SDK writes the transcript to local disk first and forwards each batch here; on `resume` it
 * calls `load` before spawning, so a conversation survives a redeploy that wipes the container's
 * disk. `SessionStore` is `@alpha` in the SDK — this adapter is the only place that touches it.
 *
 * `listSessions`, `listSessionSummaries` and `listSubkeys` are deliberately not implemented: we
 * resume by the session id we already store per shop, and we do not use subagent transcripts.
 */
export const postgresSessionStore: SessionStore = {
  async append(key, entries) {
    await appendEntries(key, entries);
  },
  async load(key) {
    return (await loadEntries(key)) as SessionStoreEntry[] | null;
  },
  async delete(key) {
    await deleteEntries(key);
  },
};

/**
 * Whether a stored session id has a mirrored transcript. A session id the store has never seen —
 * every session created before the mirror existed — cannot be resumed on a fresh container.
 */
export async function sessionExists(sessionId: string): Promise<boolean> {
  return sessionHasEntries(sessionId);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/agent/session-store.test.ts && pnpm typecheck`
Expected: PASS, and typecheck proves the adapter satisfies the SDK's `SessionStore` type. If `SessionStore` / `SessionStoreEntry` are not importable from the package root, check `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` for the export path and adjust the import only; do not weaken the types.

- [ ] **Step 5: Commit**

```bash
git add src/agent/session-store.ts src/agent/session-store.test.ts
git commit -m "feat: Postgres-backed Agent SDK session store"
```

---

### Task 3: Clearing a conversation and boot-time claim expiry

**Files:**
- Modify: `src/repositories/updates.ts`
- Modify: `src/repositories/updates.test.ts`
- Modify: `src/telegram/commands.test.ts`

**Interfaces:**
- Consumes: `deleteSessionEntries` (Task 1), existing `getSessionId`, `STALE_AFTER_SECONDS`.
- Produces: `clearSession(storeId)` now also deletes the stored transcript; `expireInFlightClaims(): Promise<number>` — number of claims expired.

- [ ] **Step 1: Write the failing tests**

In `src/repositories/updates.test.ts` (it already imports `db`, `eq`, `sql`, `processedUpdates`, `claimUpdate`, `completeUpdate`, `setSessionId`, `clearSession`, and defines `UPD`, `CHAT`), merge `expireInFlightClaims` into the existing `./updates.js` import, import `sessionEntries` from `../db/schema.js` and `appendEntries`/`sessionHasEntries` from `./session-entries.js`, and append:

```ts
describe('expireInFlightClaims (boot recovery)', () => {
  it('lets a redelivered update be reclaimed straight away after a restart', async () => {
    await claimUpdate(UPD, CHAT);
    // Without recovery the claim is "still in flight elsewhere" for 300 s, so the redelivery is dropped.
    expect(await claimUpdate(UPD, CHAT)).toBe('duplicate');

    expect(await expireInFlightClaims()).toBeGreaterThanOrEqual(1);

    expect(await claimUpdate(UPD, CHAT)).toBe('reclaimed');
  });

  it('leaves completed updates alone, so a genuine redelivery is still a duplicate', async () => {
    await claimUpdate(UPD, CHAT);
    await completeUpdate(UPD);
    await expireInFlightClaims();
    expect(await claimUpdate(UPD, CHAT)).toBe('duplicate');
  });
});

describe('clearSession removes the stored transcript', () => {
  it('deletes the mirrored entries along with the session row', async () => {
    await setSessionId(CHAT, 'sess-to-clear', 1000);
    await appendEntries({ projectKey: '/p', sessionId: 'sess-to-clear' }, [
      { type: 'user', uuid: 'clear-me' },
    ]);
    expect(await sessionHasEntries('sess-to-clear')).toBe(true);

    await clearSession(CHAT);

    expect(await sessionHasEntries('sess-to-clear')).toBe(false);
    expect(await getSessionId(CHAT)).toBeUndefined();
  });

  it('is a no-op when the shop has no session', async () => {
    await expect(clearSession(CHAT)).resolves.toBeUndefined();
  });
});
```

(`sessionEntries` is only needed for cleanup: add `await db.delete(sessionEntries).where(eq(sessionEntries.sessionId, 'sess-to-clear'));` to the file's `afterAll`. Merge `getSessionId` into the existing import if it is not already there.)

In `src/telegram/commands.test.ts`, extend the existing `/new` and `/reset confirm` session-clearing tests (added in sub-project A) so they also assert the transcript is gone: before calling the command, `await appendEntries({ projectKey: '/p', sessionId: 's' }, [{ type: 'user', uuid: 'x' }])` for the session id they already set, and after, `expect(await sessionHasEntries('s')).toBe(false)`; the bare `/reset` test must assert it is still `true`. Clean those rows in `afterAll`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/repositories/updates.test.ts src/telegram/commands.test.ts`
Expected: FAIL — `expireInFlightClaims` is not exported and `clearSession` leaves the entries behind.

- [ ] **Step 3: Implement** — in `src/repositories/updates.ts` add the import `import { deleteSessionEntries } from './session-entries.js';` and replace `clearSession`, then add `expireInFlightClaims` after `completeUpdate`:

```ts
/**
 * Boot-time recovery for a process that died mid-turn.
 *
 * A claim younger than STALE_AFTER_SECONDS is treated as "still running elsewhere", which is
 * right while the owner's process is alive and wrong after a restart: Telegram redelivers the
 * update immediately, finds a fresh claim and drops it, so the owner's message is lost. With one
 * replica (DEPLOY.md) every claim present at boot belongs to a dead process, so expire them all.
 * Completed updates are untouched: a redelivery of finished work must stay a duplicate.
 * Do not call this with more than one replica running.
 */
export async function expireInFlightClaims(): Promise<number> {
  const rows = await db
    .update(processedUpdates)
    .set({ claimedAt: sql`now() - make_interval(secs => ${STALE_AFTER_SECONDS + 1})` })
    .where(eq(processedUpdates.status, 'claimed'))
    .returning({ updateId: processedUpdates.updateId });
  return rows.length;
}
```

```ts
/**
 * Backs `/new` and `/reset`: clears the conversation and nothing else. Stock, khata and
 * preferences stay. The mirrored transcript goes too, or every cleared conversation would
 * accumulate in session_entries forever.
 */
export async function clearSession(storeId: bigint): Promise<void> {
  const sessionId = await getSessionId(storeId);
  if (sessionId) await deleteSessionEntries(sessionId);
  await db.delete(sessions).where(eq(sessions.storeId, storeId));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/repositories/updates.test.ts src/telegram/commands.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Prove the guards matter** — (a) make `expireInFlightClaims` a no-op → the "reclaimed straight away" test must fail; (b) delete the `WHERE status = 'claimed'` condition → the "leaves completed updates alone" test must fail; (c) remove the `deleteSessionEntries` call → the clear tests must fail. Restore each.

- [ ] **Step 6: Commit**

```bash
git add src/repositories/updates.ts src/repositories/updates.test.ts src/telegram/commands.test.ts
git commit -m "feat: clearing a conversation deletes its transcript; boot expires in-flight claims"
```

---

### Task 4: Runtime — use the store, drop an unknown resume, retry a failed start

**Files:**
- Modify: `src/agent/runtime.ts`
- Modify: `src/agent/runtime.test.ts`
- Modify: `src/telegram/turn.ts`
- Modify: `src/telegram/turn.test.ts`
- Modify: `src/observability/log.ts`
- Modify: `src/observability/log.test.ts`

**Interfaces:**
- Consumes: `postgresSessionStore`, `sessionExists` (Task 2); `clearSession` (existing).
- Produces: `AgentResult.resumeDropped: boolean`; `TurnLog.resumeDropped?: boolean` (logged as `resume_dropped`).

- [ ] **Step 1: Write the failing tests**

**`src/agent/runtime.test.ts`** — the file mocks the SDK's `query`. Add, directly after the existing `vi.mock('@anthropic-ai/claude-agent-sdk', …)` block, a mock of the store module so `runAgent` never touches the database in this file, and extend the helper types:

```ts
vi.mock('./session-store.js', () => ({
  postgresSessionStore: { __store: true },
  sessionExists: vi.fn(),
}));
```

Change `QueryArgs` to
```ts
interface QueryArgs {
  prompt: string;
  options: {
    abortController: AbortController;
    maxBudgetUsd?: number;
    resume?: string;
    sessionStore?: unknown;
  };
}
```
After the existing dynamic imports add `const { sessionExists } = await import('./session-store.js'); const sessionExistsMock = vi.mocked(sessionExists);` and extend the existing `beforeEach` to `mockQuery.mockReset(); sessionExistsMock.mockReset(); sessionExistsMock.mockResolvedValue(true);` (so every existing test that passes `sessionId: 'sess-1'` keeps resuming — their assertions stay as they are). Then append:

```ts
describe('runAgent — session store and resume', () => {
  it('passes the Postgres store and the resume id when the session is known', async () => {
    fake([system, text('a'), result('success', false, 0.2, 1)], 'end');
    const r = await runAgent({ text: 'hi', sessionId: 'sess-1', priorCostUsd: 0.1 });
    const opts = (mockQuery.mock.calls[0]![0] as QueryArgs).options;
    expect(opts.resume).toBe('sess-1');
    expect(opts.sessionStore).toEqual({ __store: true });
    expect(r.resumeDropped).toBe(false);
  });

  it('drops an unknown session to a fresh one with prior cost 0 (the pre-mirror sessions)', async () => {
    sessionExistsMock.mockResolvedValue(false);
    fake([system, text('hello'), result('success', false, 0.2, 1)], 'end');

    const r = await runAgent({ text: 'hi', sessionId: 'old-local-only', priorCostUsd: 0.6 });

    const opts = (mockQuery.mock.calls[0]![0] as QueryArgs).options;
    expect(opts.resume).toBeUndefined();
    expect(opts.maxBudgetUsd).toBe(0.5); // bare cap: the stale 0.6 must not widen it
    expect(r.resumeDropped).toBe(true);
    expect(r.outcome).toBe('ok');
    expect(r.turnCostUsd).toBeCloseTo(0.2); // charged in full, not total - 0.6 clamped to 0
  });

  it('retries once without resume when the run fails to start before any output', async () => {
    mockQuery
      .mockImplementationOnce(() =>
        (async function* () {
          throw new Error('No conversation found with session ID');
        })(),
      )
      .mockImplementationOnce(() =>
        (async function* () {
          yield system;
          yield text('fresh');
          yield result('success', false, 0.1, 1);
        })(),
      );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await runAgent({ text: 'hi', sessionId: 'sess-1', priorCostUsd: 0.3 });
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect((mockQuery.mock.calls[1]![0] as QueryArgs).options.resume).toBeUndefined();
      expect(r).toMatchObject({ outcome: 'ok', reply: 'fresh', resumeDropped: true });
      expect(r.turnCostUsd).toBeCloseTo(0.1);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not retry a failure that happens after output has started', async () => {
    fake([system, text('partial')], 'throw', new Error('mid-run failure'));
    await expect(runAgent({ text: 'hi', sessionId: 'sess-1' })).rejects.toThrow('mid-run failure');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('does not retry a failure on a fresh run (nothing to drop), and never loops', async () => {
    fake([], 'throw', new Error('boom'));
    await expect(runAgent({ text: 'hi' })).rejects.toThrow('boom');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('surfaces the retry failure itself if the fresh start also fails', async () => {
    mockQuery.mockImplementation(() =>
      (async function* () {
        throw new Error('still broken');
      })(),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(runAgent({ text: 'hi', sessionId: 'sess-1' })).rejects.toThrow('still broken');
      expect(mockQuery).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('runAgent — mirror failures', () => {
  it('logs a mirror failure without the error text, which can contain conversation content', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      fake(
        [
          system,
          {
            type: 'system',
            subtype: 'mirror_error',
            session_id: 'sess-1',
            error: 'Failed query: insert ... params: {"text":"khata for Ramesh is 4000"}',
            key: { projectKey: '/p', sessionId: 'sess-1' },
          },
          text('ok'),
          result('success', false, 0.1, 1),
        ],
        'end',
      );
      const r = await runAgent({ text: 'hi' });
      expect(r.outcome).toBe('ok'); // a mirror failure never fails the turn
      expect(err).toHaveBeenCalledTimes(1);
      const line = String(err.mock.calls[0]![0]);
      expect(line).toContain('sess-1');
      expect(line).not.toContain('Ramesh');
      expect(line).not.toContain('Failed query');
    } finally {
      err.mockRestore();
    }
  });
});
```

**`src/telegram/turn.test.ts`** — it mocks `runAgent` through `runAgentMock` and already provisions `CHAT` in `beforeEach`. Add (using the file's existing `fakeCtx`, `UPD`, `CHAT`; merge imports for `getSessionId`, `setSessionId`):

```ts
describe('handleTurn — dropped resume', () => {
  it('replaces a stale session row with the new session id and cost', async () => {
    await setSessionId(CHAT, 'stale-id', 900_000);
    runAgentMock.mockResolvedValueOnce({
      reply: 'ok', sessionId: 'new-id', toolsUsed: [], outcome: 'ok',
      totalCostUsd: 0.2, turnCostUsd: 0.2, numTurns: 1, resumeDropped: true,
    });
    await handleTurn(fakeCtx(), 'hello');
    expect(await getSessionId(CHAT)).toBe('new-id');
    expect(await getSessionCostMicroUsd(CHAT)).toBe(200_000);
  });

  it('clears the stale session row when the resume was dropped and no new id arrived', async () => {
    await setSessionId(CHAT, 'stale-id', 900_000);
    runAgentMock.mockResolvedValueOnce({
      reply: 'sorry', sessionId: '', toolsUsed: [], outcome: 'timeout',
      totalCostUsd: 0, turnCostUsd: 0.5, numTurns: 0, resumeDropped: true,
    });
    await handleTurn(fakeCtx(), 'hello');
    expect(await getSessionId(CHAT)).toBeUndefined();
  });
});
```
(`runAgentMock` is typed by its original implementation; widen it with `vi.fn(async (): Promise<Record<string, unknown>> => ({ … }))` if `mockResolvedValueOnce` rejects the extra fields at typecheck.) Merge `getSessionCostMicroUsd` into the existing import from `../repositories/updates.js`.

**`src/observability/log.test.ts`** — following the file's existing console-spy pattern, add: a `logTurn` with `resumeDropped: true` outputs `resume_dropped: true`, and one without it outputs no `resume_dropped` key.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/agent/runtime.test.ts src/telegram/turn.test.ts src/observability`
Expected: FAIL — `runAgent` has no store, no drop, no retry; `turn.ts` does not clear the row; `logTurn` has no `resumeDropped`.

- [ ] **Step 3: Implement the log field** — in `src/observability/log.ts` add `resumeDropped?: boolean;` to `TurnLog` and, after the `cost_usd` / `num_turns` lines in `logTurn`, `if (entry.resumeDropped) line.resume_dropped = true;`.

- [ ] **Step 4: Implement the runtime** — in `src/agent/runtime.ts`:

Add the import `import { postgresSessionStore, sessionExists } from './session-store.js';`.

Add `resumeDropped: boolean;` to `AgentResult` with the comment:
```ts
  /**
   * True when the stored session id could not be used and this run started a fresh conversation
   * (the store had no transcript for it, or the resume failed to start). The caller must replace
   * or clear its stored session row.
   */
```

Rename the existing `runAgent` to an internal function with this signature and add the failure wrapper above it:

```ts
/** A run that threw instead of yielding a result; `sawOutput` says whether the model had spoken. */
class RunFailed extends Error {
  constructor(
    readonly original: unknown,
    readonly sawOutput: boolean,
  ) {
    super('agent run failed');
  }
}

async function runOnce(args: {
  text: string;
  resume?: string;
  preferences?: Record<string, unknown>;
  prior: number;
}): Promise<Omit<AgentResult, 'resumeDropped'>> {
```
Inside it, replace `const prior = input.priorCostUsd ?? 0;` by using `args.prior` (`const prior = args.prior;`), `input.text` → `args.text`, `input.preferences` → `args.preferences`, `resume: input.sessionId` → `resume: args.resume`, `let sessionId = input.sessionId ?? ''` → `let sessionId = args.resume ?? ''`, and the tripwire's `input.sessionId &&` → `args.resume &&`. In the `options` object add `sessionStore: postgresSessionStore,` next to `resume`. In the message loop, handle the mirror failure **first**, before the existing `system`/`session_id` branch:

```ts
      if (message.type === 'system' && message.subtype === 'mirror_error') {
        // Fixed text + session id only: the error string can embed the failed query's parameters,
        // which are conversation content.
        console.error(
          JSON.stringify({
            scope: 'session-store',
            warning: 'transcript mirror failed; the turn is unaffected',
            sessionId: message.session_id,
          }),
        );
        continue;
      }
```
and change the catch to wrap an unexpected throw:

```ts
  } catch (error) {
    // A single-shot query() yields the error result and THEN throws (max turns, max budget).
    // If we already saw the result, the throw carries no new information.
    if (outcome === undefined && !timedOut) {
      throw new RunFailed(error, chunks.length > 0 || toolsUsed.length > 0);
    }
  } finally {
```
(The `return {…}` at the end of `runOnce` stays, minus nothing: it returns the `Omit<AgentResult,'resumeDropped'>` shape.)

Add the new exported `runAgent` below it:

```ts
export async function runAgent(input: {
  text: string;
  sessionId?: string;
  preferences?: Record<string, unknown>;
  /** Session spend before this run, so the budget cap and the cost accounting are per-run. */
  priorCostUsd?: number;
}): Promise<AgentResult> {
  let resume = input.sessionId;
  let prior = input.priorCostUsd ?? 0;
  let resumeDropped = false;

  // A session id the store has no transcript for cannot be resumed on a fresh container. That is
  // every session created before the mirror existed, so the first message after a deploy starts a
  // new conversation instead of failing. The old session's spend does not carry over.
  if (resume && !(await sessionExists(resume))) {
    resume = undefined;
    prior = 0;
    resumeDropped = true;
  }

  try {
    return { ...(await runOnce({ text: input.text, resume, preferences: input.preferences, prior })), resumeDropped };
  } catch (error) {
    if (!(error instanceof RunFailed)) throw error;
    // A resume that fails to start, before the model has said anything, is retried once without
    // it. Spawn-level failures throw; a failure on a started session arrives as a result message,
    // so a transient API error does not reach this branch. If it ever does, the cost is one lost
    // conversation context, which the warning below makes visible.
    if (!resume || error.sawOutput) throw error.original;
    console.warn(
      JSON.stringify({
        scope: 'session',
        warning: 'resume failed before any output; retrying once without resume',
      }),
    );
    try {
      const fresh = await runOnce({
        text: input.text,
        resume: undefined,
        preferences: input.preferences,
        prior: 0,
      });
      return { ...fresh, resumeDropped: true };
    } catch (retryError) {
      throw retryError instanceof RunFailed ? retryError.original : retryError;
    }
  }
}
```
Run `pnpm prettier --write src/agent/runtime.ts` afterwards (the one-line `return` above is long).

- [ ] **Step 5: Wire the turn** — in `src/telegram/turn.ts` merge `clearSession` into the `../repositories/updates.js` import and replace

```ts
    if (result.sessionId) {
      await setSessionId(storeId, result.sessionId, microUsd(result.totalCostUsd));
    }
```
with
```ts
    if (result.sessionId) {
      await setSessionId(storeId, result.sessionId, microUsd(result.totalCostUsd));
    } else if (result.resumeDropped) {
      // The stored session could not be used and no new one was created (e.g. the fresh run timed
      // out before its first message): clear the stale row so the next turn starts clean.
      await clearSession(storeId);
    }
```
and add `resumeDropped: result.resumeDropped,` to the `logTurn` call on the success path.

- [ ] **Step 6: Run to verify pass**

Run: `pnpm vitest run src/agent src/telegram/turn.test.ts src/observability && pnpm typecheck`
Expected: PASS. Every pre-existing test in `runtime.test.ts` still passes unchanged (they rely on `sessionExistsMock` defaulting to true).

- [ ] **Step 7: Prove the guards matter** — (a) delete the `sessionExists` pre-check → the "drops an unknown session" test fails; (b) change `prior = 0` to leave `prior` in the drop branch → the same test fails on `maxBudgetUsd` and cost; (c) delete the retry branch → the "retries once" test fails; (d) change `error.sawOutput` guard to always-false → "does not retry after output" fails; (e) log `message.error` in the mirror handler → the leak test fails; (f) remove the `else if (result.resumeDropped)` branch → the clear test fails. Restore each.

- [ ] **Step 8: Commit**

```bash
git add src/agent src/telegram/turn.ts src/telegram/turn.test.ts src/observability
git commit -m "feat: resume from the Postgres store, drop an unknown resume, retry a failed start once"
```

---

### Task 5: Live probe for the store (written, not run)

**Files:**
- Create: `src/agent/session-store.probe.ts`

No automated test: it needs a real API key and spends money. As with sub-project A's cost probe, the agent **writes it, typechecks it, and does not run it**; the operator runs it before relying on session durability.

- [ ] **Step 1: Write the probe** — create `src/agent/session-store.probe.ts`:

```ts
/**
 * Live probe: does a conversation survive a "redeploy" when the transcript is mirrored to Postgres?
 *
 *   pnpm tsx src/agent/session-store.probe.ts
 *
 * Needs a real ANTHROPIC_API_KEY and the local database. Costs a few cents.
 *
 *   A. Turn 1 runs with its local transcripts in a throwaway config dir and the Postgres store.
 *   B. Turn 2 RESUMES the same session id with a DIFFERENT, empty config dir — i.e. no local
 *      transcript, exactly what a fresh container looks like — and asks for the codeword.
 *      PASS: the reply contains it. FAIL: resume from the store did not work; do not rely on it.
 *   C. Turn 3 resumes a session id that exists nowhere. It records HOW that fails (thrown error
 *      text, or an error result), which decides whether runtime.ts's retry condition ("throws
 *      before any assistant output") matches reality. Paste the output into
 *      tasks/agent_memory.md under Known Gotchas.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadEnv } from '../config/env.js';
import { pool } from '../db/client.js';
import { deleteSessionEntries } from '../repositories/session-entries.js';
import { postgresSessionStore } from './session-store.js';

const env = loadEnv();
const CODEWORD = 'PINEAPPLE';

async function turn(prompt: string, resume: string | undefined, configDir: string) {
  let sessionId = resume ?? '';
  let reply = '';
  let seenAssistant = false;
  let resultSubtype = '';
  let threw = '';
  try {
    for await (const m of query({
      prompt,
      options: {
        model: env.AGENT_MODEL,
        resume,
        sessionStore: postgresSessionStore,
        systemPrompt: 'Be brief.',
        settingSources: [],
        allowedTools: [],
        maxTurns: 3,
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      },
    })) {
      if (m.type === 'system' && 'session_id' in m) sessionId = String(m.session_id);
      if (m.type === 'assistant') {
        seenAssistant = true;
        for (const b of m.message.content) if (b.type === 'text') reply += b.text;
      }
      if (m.type === 'result') resultSubtype = m.subtype;
    }
  } catch (error) {
    threw = (error as Error).message;
  }
  return { sessionId, reply, seenAssistant, resultSubtype, threw };
}

const dirA = mkdtempSync(join(tmpdir(), 'probe-a-'));
const dirB = mkdtempSync(join(tmpdir(), 'probe-b-'));

console.log('A. fresh session, local transcripts in', dirA);
const a = await turn(`Remember the codeword ${CODEWORD}. Reply with just: ok`, undefined, dirA);
console.log(`   session=${a.sessionId} reply="${a.reply.trim()}" threw="${a.threw}"`);

console.log('B. resume from the store with an EMPTY config dir', dirB);
const b = await turn('What is the codeword? Reply with just the word.', a.sessionId, dirB);
console.log(`   reply="${b.reply.trim()}" threw="${b.threw}"`);
console.log(
  b.reply.toUpperCase().includes(CODEWORD)
    ? '   PASS: the conversation survived without any local transcript.'
    : '   FAIL: resume from the store did not restore the conversation.',
);

console.log('C. resume a session id that exists nowhere');
const missing = randomUUID();
const c = await turn('hello', missing, mkdtempSync(join(tmpdir(), 'probe-c-')));
console.log(
  `   threw="${c.threw}" resultSubtype="${c.resultSubtype}" sawAssistantOutput=${c.seenAssistant}`,
);
console.log(
  c.threw && !c.seenAssistant
    ? '   MATCHES runtime.ts: a spawn-level throw before any assistant output (the retry condition).'
    : '   DOES NOT MATCH the runtime.ts retry condition: update RunFailed handling before relying on it.',
);

await deleteSessionEntries(a.sessionId);
await pool.end();
```

- [ ] **Step 2: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint && pnpm fmt:check`
Expected: clean. If `env` / `sessionStore` / option types differ in the installed SDK, adapt minimally and say so in the report. **Do not run the probe.**

- [ ] **Step 3: Commit**

```bash
git add src/agent/session-store.probe.ts
git commit -m "test: live probe for resuming from the Postgres session store"
```

---

### Task 6: Drain gate, graceful shutdown and boot recovery

**Files:**
- Modify: `src/config/env.ts`, `src/config/env.test.ts`, `.env.example`
- Create: `src/telegram/drain.ts`
- Test: `src/telegram/drain.test.ts`
- Modify: `src/telegram/bot.ts`
- Modify: `src/telegram/bot.access.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produces (`drain.ts`): `drainGate(ctx: Context, next: NextFunction): Promise<void>`, `beginDrain(graceMs: number): Promise<'drained' | 'timeout'>`, `isDraining(): boolean`, `inFlightCount(): number`, `resetDrainForTests(): void`.
- Produces (env): `SHUTDOWN_GRACE_MS: number` (default 30000).

- [ ] **Step 1: Write the failing tests**

Append to `src/config/env.test.ts`:

```ts
describe('SHUTDOWN_GRACE_MS', () => {
  it('defaults to 30 seconds and accepts an override up to two minutes', () => {
    expect(loadEnv(valid).SHUTDOWN_GRACE_MS).toBe(30_000);
    expect(loadEnv({ ...valid, SHUTDOWN_GRACE_MS: '120000' }).SHUTDOWN_GRACE_MS).toBe(120_000);
  });

  it('rejects zero and values above two minutes', () => {
    expect(() => loadEnv({ ...valid, SHUTDOWN_GRACE_MS: '0' })).toThrow(/SHUTDOWN_GRACE_MS/);
    expect(() => loadEnv({ ...valid, SHUTDOWN_GRACE_MS: '120001' })).toThrow(/SHUTDOWN_GRACE_MS/);
  });
});
```

Create `src/telegram/drain.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'grammy';
import {
  beginDrain,
  drainGate,
  inFlightCount,
  isDraining,
  resetDrainForTests,
} from './drain.js';

const ctx = {} as Context;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const NEVER = Symbol('never resolved');

/** A handler whose completion the test controls. */
function controllable() {
  let release!: () => void;
  const next = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  return { next, release: () => release() };
}

afterEach(() => resetDrainForTests());

describe('drainGate', () => {
  it('passes updates through and tracks them while not draining', async () => {
    const h = controllable();
    const done = drainGate(ctx, h.next);
    expect(inFlightCount()).toBe(1);
    h.release();
    await done;
    expect(inFlightCount()).toBe(0);
    expect(h.next).toHaveBeenCalledTimes(1);
  });

  it('releases the in-flight count even when the handler throws', async () => {
    await expect(drainGate(ctx, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(inFlightCount()).toBe(0);
  });

  it('never handles and never returns for an update that arrives while draining', async () => {
    await beginDrain(10);
    expect(isDraining()).toBe(true);
    const next = vi.fn(async () => {});
    // Returning would let grammY's loop move on and confirm the update by polling again.
    const outcome = await Promise.race([drainGate(ctx, next), sleep(30).then(() => NEVER)]);
    expect(outcome).toBe(NEVER);
    expect(next).not.toHaveBeenCalled();
    expect(inFlightCount()).toBe(0);
  });
});

describe('beginDrain', () => {
  it('resolves drained at once when nothing is in flight', async () => {
    expect(await beginDrain(1000)).toBe('drained');
  });

  it('waits for the in-flight turn to finish', async () => {
    const h = controllable();
    const handling = drainGate(ctx, h.next);
    let settled: string | undefined;
    const drain = beginDrain(1000).then((r) => (settled = r));

    await sleep(20);
    expect(settled).toBeUndefined(); // still waiting

    h.release();
    await handling;
    await drain;
    expect(settled).toBe('drained');
  });

  it('gives up after the grace period if the turn never finishes', async () => {
    const h = controllable();
    void drainGate(ctx, h.next);
    expect(await beginDrain(30)).toBe('timeout');
    h.release();
  });
});
```

Add to `src/telegram/bot.access.test.ts` (import `beginDrain`, `resetDrainForTests` from `./drain.js`; `OWNER` is the file's existing provisioned owner; `textUpdate`, `makeBot`, `sent`, `runAgent` mock and the `processed_updates` helpers already exist there):

```ts
describe('draining', () => {
  afterEach(() => resetDrainForTests());

  it('neither handles nor claims an update that arrives during shutdown', async () => {
    await provisionStore(OWNER);
    const bot = makeBot();
    await beginDrain(10); // nothing in flight: drained at once, but the gate now holds

    const update = textUpdate(OWNER, 'bill 2 sugar');
    void bot.handleUpdate(update as never); // never settles by design; do not await it
    await new Promise((r) => setTimeout(r, 50));

    expect(runAgent).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    const claimed = await db
      .select()
      .from(processedUpdates)
      .where(eq(processedUpdates.updateId, BigInt(update.update_id)));
    expect(claimed).toHaveLength(0);
  });
});
```
(Merge `afterEach` into the file's vitest import.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/config/env.test.ts src/telegram/drain.test.ts src/telegram/bot.access.test.ts`
Expected: FAIL — `SHUTDOWN_GRACE_MS` is undefined; `./drain.js` is missing.

- [ ] **Step 3: Add the env var** — in `src/config/env.ts` add to the schema next to the other limits:

```ts
    SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().max(120_000).default(30_000),
```
and to `.env.example`: `# SHUTDOWN_GRACE_MS=30000`.

- [ ] **Step 4: Implement the drain gate** — create `src/telegram/drain.ts`:

```ts
import type { Context, NextFunction } from 'grammy';

/**
 * Process-lifecycle state for graceful shutdown.
 *
 * grammY's long-polling loop handles one update at a time and confirms a batch only when it
 * fetches the next one. Shutdown must therefore (1) stop starting work, (2) let the in-flight
 * turn finish, and (3) exit WITHOUT `bot.stop()` — stop() calls getUpdates with
 * `offset = lastTriedUpdateId + 1`, which confirms the update currently being handled, so a
 * turn cut off by exit would be lost instead of redelivered.
 */
let draining = false;
let inFlight = 0;
let waiters: Array<() => void> = [];

export function isDraining(): boolean {
  return draining;
}

export function inFlightCount(): number {
  return inFlight;
}

/**
 * First middleware. While draining it neither handles the update nor returns: returning would let
 * grammY's loop carry on and issue another getUpdates, confirming the update we declined to
 * handle. Hanging keeps it unconfirmed, so Telegram redelivers it to the next process.
 */
export async function drainGate(_ctx: Context, next: NextFunction): Promise<void> {
  if (draining) return new Promise<void>(() => {});
  inFlight++;
  try {
    await next();
  } finally {
    inFlight--;
    if (inFlight === 0) for (const wake of waiters.splice(0)) wake();
  }
}

/** Stops accepting updates and resolves when the in-flight one finishes, or after the grace period. */
export function beginDrain(graceMs: number): Promise<'drained' | 'timeout'> {
  draining = true;
  if (inFlight === 0) return Promise.resolve('drained');
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve('drained');
    };
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== done);
      resolve('timeout');
    }, graceMs);
    waiters.push(done);
  });
}

export function resetDrainForTests(): void {
  draining = false;
  inFlight = 0;
  waiters = [];
}
```

- [ ] **Step 5: Make it the first middleware** — in `src/telegram/bot.ts` add `import { drainGate } from './drain.js';` and, in `createBot`, put `bot.use(drainGate);` immediately BEFORE `bot.use(accessGate);` (update the comment above that line to say the drain gate is first).

- [ ] **Step 6: Rewrite shutdown and boot** — in `src/index.ts`, import `expireInFlightClaims` from `./repositories/updates.js` and `beginDrain` from `./telegram/drain.js`, remove the now-unused `pool` import if nothing else uses it, then replace the migrations block's tail and the shutdown function:

```ts
console.log('Migrations up to date.');

// One replica: any claim still 'claimed' at boot belongs to a process that died mid-turn. Expire
// them so Telegram's redelivery of those updates is reclaimed instead of dropped as "in flight".
const expired = await expireInFlightClaims();
if (expired > 0) console.log(`Expired ${expired} in-flight claim(s) from the previous process.`);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, finishing the turn in flight…`);
  const outcome = await beginDrain(env.SHUTDOWN_GRACE_MS);
  console.log(
    outcome === 'drained'
      ? 'Idle, exiting.'
      : 'Grace period elapsed with a turn still running; exiting. Telegram will redeliver it.',
  );
  // Deliberately NOT bot.stop(): it confirms the update being handled (offset = last tried + 1),
  // so a turn we cut off here would be lost instead of redelivered. See telegram/drain.ts.
  process.exit(0);
}
```
and in the same file replace `loadEnv();` with `const env = loadEnv();` (it currently discards the result).

- [ ] **Step 7: Run to verify pass**

Run: `pnpm vitest run src/config src/telegram && pnpm typecheck && pnpm lint`
Expected: PASS. There is no unit test for `index.ts` (it boots the process); it is covered by typecheck and the DEPLOY.md checklist in Task 7.

- [ ] **Step 8: Prove the guards matter** — (a) make `drainGate` `return` instead of hanging during drain → the "never returns" test fails; (b) remove `bot.use(drainGate)` → the bot "draining" test fails (the update is handled); (c) make `beginDrain` resolve `'drained'` immediately regardless of `inFlight` → "waits for the in-flight turn" fails. Restore each.

- [ ] **Step 9: Commit**

```bash
git add src/config .env.example src/telegram src/index.ts
git commit -m "feat: drain in-flight turn on shutdown without confirming it; expire orphaned claims at boot"
```

---

### Task 7: Documentation, full gate and handoff

**Files:**
- Modify: `docs/DEPLOY.md`, `HANDOFF.md`, `CLAUDE.md` (architecture map and §5 table only), `tasks/todo.md`, `tasks/lessons.md`, `tasks/agent_memory.md`

- [ ] **Step 1: DEPLOY.md** — add a section **Deploys and shutdown**:

```markdown
## Deploys and shutdown

On SIGTERM/SIGINT the bot stops starting work, lets the turn in flight finish (up to
`SHUTDOWN_GRACE_MS`, default 30 s), and exits. It deliberately does not call `bot.stop()`: in
grammY that confirms the update being handled, so a turn cut off by the exit would be lost.
Anything not confirmed is redelivered by Telegram to the next process.

At boot the bot expires every in-flight claim, because with one replica any claim present at
boot belongs to a dead process; without that, a redelivered update would be dropped as "still
running" for up to five minutes. **Never run two replicas**: the second one's boot would expire
the first one's live claims.

Not yet verified: how long Railway waits between SIGTERM and SIGKILL (its draining setting). If
that is shorter than `SHUTDOWN_GRACE_MS`, a long turn can be killed mid-flight; it is then
reprocessed on redelivery (tools are idempotent per update), but the model call is paid for twice.

## Conversation storage

Agent transcripts are mirrored to Postgres (`session_entries`) so a conversation survives a
redeploy. Rows are deleted by `/new` and `/reset confirm`; **abandoned conversations accumulate**
(there is no retention job yet), so watch the table's size. A shop whose stored session predates
this feature gets one fresh conversation on its first message after the deploy. A mirror write
that fails is logged with the session id only, never the text, and does not fail the turn.
```
Add `SHUTDOWN_GRACE_MS` (optional, default 30000, max 120000) to the environment table.

- [ ] **Step 2: Other docs**
  - `CLAUDE.md`: add `repositories/session-entries.ts`, `agent/session-store.ts` and `telegram/drain.ts` to the architecture map, and one row to the §5 table: *Recovery — a turn cut off by a restart is redelivered and reprocessed: shutdown drains the in-flight turn instead of confirming it, and boot expires orphaned claims (`telegram/drain.ts`, `repositories/updates.ts`).* Touch nothing else in that file.
  - `tasks/agent_memory.md` → *Known Gotchas*: (1) grammY `bot.stop()` confirms the in-flight update (`offset = lastTriedUpdateId + 1`) and does not wait for the handler; (2) `claimUpdate`'s 300 s stale window drops a redelivered update after a fast restart, hence the boot-time expiry; (3) the runner confirms offsets early (up to 100 updates lost on kill), which is why sequential polling was kept; (4) the SDK's `SessionStore` is `@alpha`, retries `append`, wants `uuid` idempotency, and `mirror_error` text can contain query parameters. Add the same one line under *Architecture Decisions*: B keeps sequential polling and mirrors sessions in Postgres.
  - `tasks/lessons.md`: ONE entry in the file's format — *what broke*: the spec said an interrupted turn "is recovered by redelivery as before" and a SIGTERM handler called `bot.stop()`; *root cause*: two unverified assumptions about library behaviour (`bot.stop()` waits for handlers; a fresh claim after restart is reclaimable) that the installed source contradicts; *next time*: read the library source for the exact shutdown/confirmation semantics before designing recovery on top of it.
  - `HANDOFF.md`: current state (sub-project B implemented on `production-hardening-b`, stacked on PR #1, not merged), test count from your gate run, and **Next action**: run `pnpm tsx src/agent/session-store.probe.ts` with a real key (PASS required before relying on durability; paste its Q-C output into `tasks/agent_memory.md`), check Railway's draining time against `SHUTDOWN_GRACE_MS`, then sub-project C. List what B left out (runner, replay inbox, session retention job).
  - `tasks/todo.md`: add a "Production hardening — sub-project B" section with this plan's tasks checked, and the live probe and Railway check left unchecked with "needs credentials / needs Railway".

- [ ] **Step 3: Full gate, three times**

Run: `pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test`, then `pnpm test` twice more.
Expected: green all three times. Report the exact counts and compare with the 321 baseline. If any run fails, stop and report the output; do not retry until green.

- [ ] **Step 4: Commit**

```bash
git add docs HANDOFF.md CLAUDE.md tasks
git commit -m "docs: session durability, graceful shutdown and restart recovery"
```

---

## Self-review

**Spec coverage (§B, amended):** Postgres session store behind `sessionStore` with ordered, deep-equal, atomic, uuid-idempotent append, `load`→`null`, cascading `delete` → Tasks 1–2; `/new` and `/reset confirm` delete stored entries → Task 3; mirror failures logged and never failing a turn → Task 4; stale or unknown session dropped to a fresh session with prior cost 0, stale row cleared or replaced → Task 4; failed start retried once without `resume` → Task 4; graceful shutdown with a bounded grace period, no `bot.stop()` → Task 6; boot-time claim expiry → Task 3 (function) and Task 6 (call site); DEPLOY.md notes including the unverified Railway timing → Task 7; live probe (resume from the store, failure signature of an unknown resume) → Task 5, written but not run.

**Placeholder scan:** no TBD/TODO; every code step has complete code. The only deliberately open items are named as such: the Railway draining time and the live probes.

**Type consistency:** `EntryKey`/repository functions (Task 1) are used by the adapter (Task 2) and by `clearSession` (Task 3) with the same names; `AgentResult.resumeDropped` (Task 4) is read in `turn.ts` (Task 4) and logged via `TurnLog.resumeDropped` (Task 4); `beginDrain`/`drainGate`/`resetDrainForTests` (Task 6) match their uses in `bot.ts`, `index.ts` and both test files; `expireInFlightClaims` (Task 3) is called in `index.ts` (Task 6).

**Known limits deliberately accepted:** one conversation reset if a transient spawn failure ever hits the retry branch (logged); abandoned conversations accumulate in `session_entries` (documented, no retention job); a turn exceeding the grace period is reprocessed on redelivery and its model call paid twice; `SessionStore` is `@alpha`; the retry condition ("throws before any assistant output") is the SDK's observed behaviour only after the Task 5 probe is run.
