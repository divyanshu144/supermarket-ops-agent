import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { sessionEntries } from '../db/schema.js';
import {
  appendEntries,
  stripNul,
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

describe('NUL handling', () => {
  it('appends an entry with a NUL in a nested string and loads it back with the NUL removed', async () => {
    const key = { projectKey: PROJECT, sessionId: fresh() };
    await appendEntries(key, [
      {
        type: 'user',
        uuid: 'nul-1',
        n: 7,
        message: { content: [{ type: 'tool_result', text: 'ab\u0000cd' }] },
      },
    ]);
    expect(await loadEntries(key)).toEqual([
      {
        type: 'user',
        uuid: 'nul-1',
        n: 7,
        message: { content: [{ type: 'tool_result', text: 'abcd' }] },
      },
    ]);
  });

  it('preserves a literal backslash followed by u0000', async () => {
    const key = { projectKey: PROJECT, sessionId: fresh() };
    const entry = { type: 'user', uuid: 'nul-2', text: 'a\\u0000b' };
    await appendEntries(key, [entry]);
    expect(await loadEntries(key)).toEqual([entry]);
  });
});

describe('project key independence', () => {
  it('loads entries written under a different project key', async () => {
    const sessionId = fresh();
    await appendEntries({ projectKey: '/a', sessionId }, [{ type: 'user', uuid: 'p1' }]);
    expect(await loadEntries({ projectKey: '/b', sessionId })).toEqual([
      { type: 'user', uuid: 'p1' },
    ]);
    expect(await sessionHasEntries(sessionId)).toBe(true);
  });

  it('deleteEntries under a different project key still deletes', async () => {
    const sessionId = fresh();
    await appendEntries({ projectKey: '/a', sessionId }, [{ type: 'user', uuid: 'p1' }]);
    await deleteEntries({ projectKey: '/b', sessionId });
    expect(await sessionHasEntries(sessionId)).toBe(false);
    expect(await loadEntries({ projectKey: '/a', sessionId })).toBeNull();
  });

  it('a subpath delete under another project key leaves the main transcript', async () => {
    const sessionId = fresh();
    await appendEntries({ projectKey: '/a', sessionId }, [{ type: 'user', uuid: 'm1' }]);
    await appendEntries({ projectKey: '/a', sessionId, subpath: 'subagents/x' }, [
      { type: 'user', uuid: 's1' },
    ]);
    await deleteEntries({ projectKey: '/b', sessionId, subpath: 'subagents/x' });
    expect(await loadEntries({ projectKey: '/b', sessionId })).toHaveLength(1);
    expect(await loadEntries({ projectKey: '/b', sessionId, subpath: 'subagents/x' })).toBeNull();
  });

  it('keeps the main transcript and a subpath separate across project keys', async () => {
    const sessionId = fresh();
    await appendEntries({ projectKey: '/a', sessionId }, [{ type: 'user', uuid: 'm1' }]);
    await appendEntries({ projectKey: '/b', sessionId, subpath: 'subagents/x' }, [
      { type: 'user', uuid: 's1' },
    ]);
    expect(await loadEntries({ projectKey: '/c', sessionId })).toEqual([
      { type: 'user', uuid: 'm1' },
    ]);
    expect(await loadEntries({ projectKey: '/c', sessionId, subpath: 'subagents/x' })).toEqual([
      { type: 'user', uuid: 's1' },
    ]);
  });
});

describe('lone surrogate handling', () => {
  it('replaces a lone high surrogate with U+FFFD and does not throw', async () => {
    const key = { projectKey: PROJECT, sessionId: fresh() };
    await appendEntries(key, [{ type: 'user', uuid: 'sg-1', text: 'cut\uD83D' }]);
    expect(await loadEntries(key)).toEqual([{ type: 'user', uuid: 'sg-1', text: 'cut\uFFFD' }]);
  });

  it('leaves a valid surrogate pair (emoji) untouched', async () => {
    const key = { projectKey: PROJECT, sessionId: fresh() };
    const entry = { type: 'user', uuid: 'sg-2', text: 'ok \u{1F600}' };
    await appendEntries(key, [entry]);
    expect(await loadEntries(key)).toEqual([entry]);
  });

  it('well-forms object keys and nested strings in the helper', () => {
    expect(stripNul({ ['k\uDE00']: ['a\u0000\uD83D'] })).toEqual({ ['k\uFFFD']: ['a\uFFFD'] });
    expect(stripNul('\u{1F600}')).toBe('\u{1F600}');
  });
});

describe('stripNul', () => {
  it('strips NUL from strings, arrays, nested objects and object keys', () => {
    expect(stripNul('a\u0000b')).toBe('ab');
    expect(stripNul(['x\u0000', ['\u0000y']])).toEqual(['x', ['y']]);
    expect(stripNul({ 'k\u0000ey': { deep: 'v\u0000al' } })).toEqual({ key: { deep: 'val' } });
  });

  it('leaves numbers, booleans and null untouched', () => {
    expect(stripNul({ a: 1, b: true, c: false, d: null, e: 0 })).toEqual({
      a: 1,
      b: true,
      c: false,
      d: null,
      e: 0,
    });
    expect(stripNul(null)).toBeNull();
    expect(stripNul(5)).toBe(5);
  });

  it('does not touch a literal backslash-u0000 sequence', () => {
    expect(stripNul('a\\u0000b')).toBe('a\\u0000b');
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
