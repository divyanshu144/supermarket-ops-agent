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
