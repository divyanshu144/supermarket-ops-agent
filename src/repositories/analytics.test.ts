import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { products, stockMovements, stores } from '../db/schema.js';
import { reorderSuggestions } from './analytics.js';

const STORE = 999000091n;

async function productId(name: string): Promise<string> {
  const [match] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.storeId, STORE), eq(products.name, name)));
  return match!.id;
}

beforeEach(async () => {
  await db.delete(stores).where(eq(stores.id, STORE));
  await db.insert(stores).values({ id: STORE, name: 'Test Kirana', gstin: '27AAAAA0000A1Z5' });

  await db.insert(products).values([
    {
      storeId: STORE,
      name: 'Maggi 70g',
      unit: 'packet',
      hsnCode: '19023010',
      gstRateBps: 1200,
      costPricePaise: 1000,
      mrpPaise: 1400,
      quantityBase: 10,
      reorderLevelBase: 20,
    },
    {
      storeId: STORE,
      name: 'Parle-G 100g',
      unit: 'packet',
      hsnCode: '19053100',
      gstRateBps: 1200,
      costPricePaise: 900,
      mrpPaise: 1200,
      quantityBase: 40,
      reorderLevelBase: 20,
    },
    {
      storeId: STORE,
      name: 'Tata Salt 1kg',
      unit: 'packet',
      hsnCode: '25010020',
      gstRateBps: 500,
      costPricePaise: 1800,
      mrpPaise: 2200,
      quantityBase: 15,
      reorderLevelBase: 10,
    },
    {
      // Lowest absolute stock of all four, but barely sells — a sort by raw quantityBase
      // would put this first; a correct sort by days of cover puts it last of the sellers.
      storeId: STORE,
      name: 'Britannia 100g',
      unit: 'packet',
      hsnCode: '19053200',
      gstRateBps: 1200,
      costPricePaise: 1500,
      mrpPaise: 2000,
      quantityBase: 5,
      reorderLevelBase: 10,
    },
  ]);

  const maggiId = await productId('Maggi 70g');
  const parleId = await productId('Parle-G 100g');
  const britanniaId = await productId('Britannia 100g');

  await db.insert(stockMovements).values([
    {
      storeId: STORE,
      productId: maggiId,
      kind: 'sale',
      qtyBaseDelta: -60,
    },
    {
      storeId: STORE,
      productId: parleId,
      kind: 'sale',
      qtyBaseDelta: -30,
    },
    {
      // 1 sold over 30 days = 1/30 per day, 5 left -> 150 days of cover.
      storeId: STORE,
      productId: britanniaId,
      kind: 'sale',
      qtyBaseDelta: -1,
    },
  ]);
});

afterAll(async () => {
  await db.delete(stores).where(eq(stores.id, STORE));
  await pool.end();
});

describe('reorderSuggestions', () => {
  it('ranks by days of cover, not by absolute stock', async () => {
    // Fast mover: 60 sold over 30 days = 2/day, 10 left -> 5 days of cover.
    // Slow mover: 30 sold over 30 days = 1/day, 40 left -> 40 days of cover.
    // Britannia has the least stock of any seller (5) but the slowest velocity (150 days of
    // cover) — asserting the full order rules out a sort by raw quantityBase, which would put
    // Britannia first instead of last among the sellers.
    const suggestions = await reorderSuggestions(STORE, 30);

    const fast = suggestions.find((s) => s.name === 'Maggi 70g');
    const slow = suggestions.find((s) => s.name === 'Parle-G 100g');
    const barelyMoves = suggestions.find((s) => s.name === 'Britannia 100g');

    expect(fast!.daysOfCover).toBeCloseTo(5, 1);
    expect(slow!.daysOfCover).toBeCloseTo(40, 1);
    expect(barelyMoves!.daysOfCover).toBeCloseTo(150, 0);
    expect(suggestions.map((s) => s.name)).toEqual([
      'Maggi 70g',
      'Parle-G 100g',
      'Britannia 100g',
      'Tata Salt 1kg',
    ]);
  });

  it('reports products with no sales without dividing by zero', async () => {
    const suggestions = await reorderSuggestions(STORE, 30);
    const idle = suggestions.find((s) => s.name === 'Tata Salt 1kg');
    expect(idle!.unitsPerDay).toBe(0);
    expect(idle!.daysOfCover).toBeNull();
  });
});
