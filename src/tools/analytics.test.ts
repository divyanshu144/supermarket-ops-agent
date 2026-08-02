import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { products, stockMovements, stores } from '../db/schema.js';
import { newToolContext, toolContext } from './context.js';
import { reorderSuggestionsTool } from './analytics.js';

const STORE = 999000092n;

async function productId(name: string): Promise<string> {
  const [match] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.storeId, STORE), eq(products.name, name)));
  return match!.id;
}

function withStore<T>(storeId: bigint, fn: () => Promise<T>): Promise<T> {
  return toolContext.run(newToolContext(storeId, 1n), fn);
}

beforeEach(async () => {
  await db.delete(stores).where(eq(stores.id, STORE));
  await db.insert(stores).values({ id: STORE, name: 'Test Kirana', gstin: '27AAAAA0000A1Z5' });

  await db.insert(products).values({
    storeId: STORE,
    // Loose staple: sold by the kg, base unit is grams. This is the case that slipped
    // through — the existing analytics fixtures only use `packet` products, where base and
    // selling units are numerically identical, so a base-unit rate looks correct by accident.
    name: 'Loose Sugar',
    unit: 'kg',
    hsnCode: '17019910',
    gstRateBps: 0,
    costPricePaise: 4000,
    mrpPaise: 4500,
    quantityBase: 20000, // 20 kg, in grams
    reorderLevelBase: 5000,
  });

  const sugarId = await productId('Loose Sugar');

  await db.insert(stockMovements).values({
    storeId: STORE,
    productId: sugarId,
    kind: 'sale',
    // 30 kg sold over the 30-day window = 1000 g/day if left unconverted, 1 kg/day if correct.
    qtyBaseDelta: -30000,
  });
});

afterAll(async () => {
  await db.delete(stores).where(eq(stores.id, STORE));
  await pool.end();
});

describe('reorder_suggestions tool', () => {
  it('reports sells_per_day in selling units, not base units, for a loose kg product', async () => {
    const raw = await withStore(STORE, () =>
      reorderSuggestionsTool.handler({ days_back: 30 }, {}),
    );
    const parsed = JSON.parse(raw.content[0]!.text) as {
      suggestions: Array<{ name: string; in_stock: string; sells_per_day: number }>;
    };

    const sugar = parsed.suggestions.find((s) => s.name === 'Loose Sugar');
    expect(sugar).toBeDefined();
    expect(sugar!.in_stock).toBe('20 kg');
    // Must read 1 (kg/day), not 1000 (g/day) — the bug reported grams as if they were kg.
    expect(sugar!.sells_per_day).toBe(1);
  });
});
