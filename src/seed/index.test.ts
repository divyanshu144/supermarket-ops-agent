import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, gte } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { bills, khataAccounts, products, stockMovements, stores } from '../db/schema.js';
import { seedStore } from './index.js';

const STORE = 999000009n;

beforeEach(async () => {
  await db.delete(stores).where(eq(stores.id, STORE));
  await db.insert(stores).values({ id: STORE, name: 'S', gstin: '27AAAAA0000A1Z5' });
});

afterAll(async () => {
  await db.delete(stores).where(eq(stores.id, STORE));
  await pool.end();
});

describe('seedStore', () => {
  it('creates the catalogue with an item at or below reorder level', async () => {
    await seedStore(STORE);
    const rows = await db.select().from(products).where(eq(products.storeId, STORE));

    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(rows.some((r) => r.quantityBase <= r.reorderLevelBase)).toBe(true);
  });

  it('leaves Maggi at its low opening stock so the oversell guard is demonstrable', async () => {
    // Seeded sales must NOT decrement stock, or this figure drifts per store and the
    // oversell demo stops being reproducible.
    await seedStore(STORE);
    const rows = await db.select().from(products).where(eq(products.storeId, STORE));
    const maggi = rows.find((r) => r.name.startsWith('Maggi'));

    expect(maggi?.quantityBase).toBe(6);
  });

  it('creates khata accounts including one carrying a balance', async () => {
    await seedStore(STORE);
    const rows = await db.select().from(khataAccounts).where(eq(khataAccounts.storeId, STORE));

    expect(rows.some((r) => r.balancePaise > 0)).toBe(true);
  });

  it('DATES SALES HISTORY RELATIVE TO NOW, not to hardcoded calendar dates', async () => {
    // Regression test for the "this week's deck is empty next month" bug.
    await seedStore(STORE);
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);

    const recent = await db
      .select()
      .from(bills)
      .where(and(eq(bills.storeId, STORE), gte(bills.createdAt, sevenDaysAgo)));

    expect(recent.length).toBeGreaterThan(0);
  });

  it('honours an injected clock so the relative dating is provable', async () => {
    const fixed = new Date('2030-06-15T12:00:00Z');
    await seedStore(STORE, fixed);

    const rows = await db.select().from(bills).where(eq(bills.storeId, STORE));
    const newest = rows.map((r) => r.createdAt.getTime()).sort((a, b) => b - a)[0]!;

    expect(newest).toBeLessThanOrEqual(fixed.getTime());
    expect(newest).toBeGreaterThan(fixed.getTime() - 3 * 86_400_000);
  });

  it('records a stock movement for every seeded sale', async () => {
    await seedStore(STORE);
    const moves = await db.select().from(stockMovements).where(eq(stockMovements.storeId, STORE));

    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((m) => m.kind === 'sale')).toBe(true);
    expect(moves.every((m) => m.qtyBaseDelta < 0)).toBe(true);
  });

  it('produces bills whose totals are whole rupees after round-off', async () => {
    await seedStore(STORE);
    const rows = await db.select().from(bills).where(eq(bills.storeId, STORE));

    expect(rows.length).toBeGreaterThan(0);
    for (const bill of rows) {
      expect(bill.totalPaise! % 100).toBe(0);
      expect(bill.subtotalPaise! + bill.cgstPaise! + bill.sgstPaise! + bill.roundOffPaise!).toBe(
        bill.totalPaise,
      );
    }
  });
});
