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
    await postgresSessionStore.append({ projectKey: '/p', sessionId }, [
      { type: 'user', uuid: 'm' },
    ]);
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
    await postgresSessionStore.append({ projectKey: '/p', sessionId }, [
      { type: 'user', uuid: 'x' },
    ]);
    expect(await sessionExists(sessionId)).toBe(true);
  });
});
