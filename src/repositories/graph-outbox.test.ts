import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { graphOutbox, stores } from '../db/schema.js';
import { appendGraphEvent } from './graph-outbox.js';

const STORE = 999000097n;
const event = {
  type: 'stock_movement' as const,
  storeId: String(STORE),
  id: 'movement-1',
  productId: 'product-1',
  kind: 'receive',
  qtyBaseDelta: 5,
  billId: null,
  createdAt: '2026-11-10T10:00:00.000Z',
};

beforeEach(async () => {
  await db.delete(stores).where(eq(stores.id, STORE));
  await db
    .insert(stores)
    .values({ id: STORE, name: 'Graph Outbox Test', gstin: '27AAAAA0000A1Z5' });
});
afterAll(async () => {
  await db.delete(stores).where(eq(stores.id, STORE));
  await pool.end();
});

describe('appendGraphEvent', () => {
  it('persists a parameterized source event in the caller transaction', async () => {
    const malicious = { ...event, id: "x'); MATCH (n) DETACH DELETE n //" };
    await db.transaction(async (tx) => appendGraphEvent(tx, malicious));
    const rows = await db.select().from(graphOutbox).where(eq(graphOutbox.storeId, STORE));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityId).toBe(malicious.id);
    expect(rows[0]!.payload).toEqual(malicious);
  });

  it('rolls back the event when the source transaction rolls back', async () => {
    await expect(
      db.transaction(async (tx) => {
        await appendGraphEvent(tx, event);
        throw new Error('rollback test');
      }),
    ).rejects.toThrow('rollback test');
    expect(await db.select().from(graphOutbox).where(eq(graphOutbox.storeId, STORE))).toHaveLength(
      0,
    );
  });
});
