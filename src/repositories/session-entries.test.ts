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
    const b = {
      type: 'assistant',
      uuid: 'u2',
      message: { content: [{ type: 'text', text: 'hi' }] },
    };
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
