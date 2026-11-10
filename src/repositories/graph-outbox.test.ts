import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { graphOutbox, stores } from '../db/schema.js';
import {
  acknowledgeGraphEvent,
  appendGraphEvent,
  claimGraphEvents,
  failGraphEvent,
  graphOutboxLag,
} from './graph-outbox.js';

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

  it('claims with a lease and token so an expired worker cannot acknowledge a reclaimed row', async () => {
    const started = new Date('2030-11-10T10:00:00.000Z');
    await db.transaction(async (tx) => appendGraphEvent(tx, event));
    const [first] = await claimGraphEvents(25, started, 1000);
    expect(first).toBeDefined();
    expect(await claimGraphEvents(25, started, 1000)).toHaveLength(0);

    const [reclaimed] = await claimGraphEvents(25, new Date(started.getTime() + 1001), 1000);
    expect(reclaimed).toBeDefined();
    expect(reclaimed!.claimToken).not.toBe(first!.claimToken);
    expect(await acknowledgeGraphEvent(first!.id, first!.claimToken)).toBe(false);
    expect(await acknowledgeGraphEvent(reclaimed!.id, reclaimed!.claimToken)).toBe(true);
    expect(await graphOutboxLag()).toEqual({ pendingCount: 0, oldestPendingAt: null });
  });

  it('schedules a bounded retry and records no raw error details', async () => {
    const started = new Date('2030-11-10T10:00:00.000Z');
    await db.transaction(async (tx) => appendGraphEvent(tx, event));
    const [claimed] = await claimGraphEvents(25, started);
    expect(await failGraphEvent(claimed!.id, claimed!.claimToken, 'unavailable', started)).toBe(
      true,
    );
    const [row] = await db.select().from(graphOutbox).where(eq(graphOutbox.storeId, STORE));
    expect(row!.lastErrorCode).toBe('unavailable');
    expect(row!.processedAt).toBeNull();
    expect(row!.nextAttemptAt.getTime()).toBe(started.getTime() + 2000);
  });
});
