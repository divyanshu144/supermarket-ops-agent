import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from './client.js';
import { products, stores } from './schema.js';

const STORE_ID = 999000001n;

beforeEach(async () => {
  await db.delete(stores).where(eq(stores.id, STORE_ID));
});
afterAll(async () => {
  await db.delete(stores).where(eq(stores.id, STORE_ID));
  await pool.end();
});

describe('schema', () => {
  it('round-trips a store and a product', async () => {
    await db.insert(stores).values({ id: STORE_ID, name: 'Test Kirana', gstin: '27AAAAA0000A1Z5' });
    await db.insert(products).values({
      storeId: STORE_ID,
      name: 'Tata Salt 1kg',
      unit: 'packet',
      hsnCode: '25010020',
      gstRateBps: 500,
      costPricePaise: 2000,
      mrpPaise: 2800,
      quantityBase: 40,
    });
    const rows = await db.select().from(products).where(eq(products.storeId, STORE_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mrpPaise).toBe(2800);
  });

  it('refuses negative stock at the database level', async () => {
    await db.insert(stores).values({ id: STORE_ID, name: 'Test Kirana', gstin: '27AAAAA0000A1Z5' });
    await expect(
      db.insert(products).values({
        storeId: STORE_ID,
        name: 'Broken',
        unit: 'packet',
        hsnCode: '00000000',
        gstRateBps: 0,
        costPricePaise: 1,
        mrpPaise: 1,
        quantityBase: -1,
      }),
    ).rejects.toThrow();
  });
});
