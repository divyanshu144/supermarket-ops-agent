import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { products, stockMovements, stores } from '../db/schema.js';
import { reorderSuggestions } from './analytics.js';

const STORE = 999000040n;

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
  ]);

  const maggiId = await productId('Maggi 70g');
  const parleId = await productId('Parle-G 100g');

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
    const suggestions = await reorderSuggestions(STORE, 30);

    const fast = suggestions.find((s) => s.name === 'Maggi 70g');
    const slow = suggestions.find((s) => s.name === 'Parle-G 100g');

    expect(fast!.daysOfCover).toBeCloseTo(5, 1);
    expect(slow!.daysOfCover).toBeCloseTo(40, 1);
    expect(suggestions[0]!.name).toBe('Maggi 70g');
  });

  it('reports products with no sales without dividing by zero', async () => {
    const suggestions = await reorderSuggestions(STORE, 30);
    const idle = suggestions.find((s) => s.name === 'Tata Salt 1kg');
    expect(idle!.unitsPerDay).toBe(0);
    expect(idle!.daysOfCover).toBeNull();
  });
});
