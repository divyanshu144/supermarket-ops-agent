import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { products, stores } from '../db/schema.js';
import { seedStore } from '../seed/index.js';
import { findStock } from './products.js';

const STORE = 999000003n;
const OTHER = 999000004n;
const SEEDED_STORE = 999000093n;

beforeEach(async () => {
  for (const id of [STORE, OTHER]) {
    await db.delete(stores).where(eq(stores.id, id));
    await db.insert(stores).values({ id, name: 'S', gstin: '27AAAAA0000A1Z5' });
  }

  await db.insert(products).values([
    {
      storeId: STORE,
      name: 'Aashirvaad Atta 5kg',
      brand: 'Aashirvaad',
      packSize: '5kg',
      unit: 'packet',
      hsnCode: '11010000',
      gstRateBps: 500,
      costPricePaise: 22000,
      mrpPaise: 26000,
      quantityBase: 12,
    },
    {
      storeId: STORE,
      name: 'Loose Atta',
      unit: 'kg',
      isLoose: true,
      hsnCode: '11010000',
      gstRateBps: 0,
      costPricePaise: 3800,
      mrpPaise: 4500,
      quantityBase: 25000,
    },
    {
      storeId: OTHER,
      name: 'Tata Salt 1kg',
      unit: 'packet',
      hsnCode: '25010020',
      gstRateBps: 500,
      costPricePaise: 2000,
      mrpPaise: 2800,
      quantityBase: 99,
    },
  ]);
});

afterAll(async () => {
  for (const id of [STORE, OTHER]) await db.delete(stores).where(eq(stores.id, id));
  await pool.end();
});

describe('findStock', () => {
  it('returns a single match', async () => {
    const result = await findStock(STORE, 'aashirvaad');
    expect(result.status).toBe('found');
  });

  it('returns candidates when the query is ambiguous', async () => {
    const result = await findStock(STORE, 'atta');
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') expect(result.candidates).toHaveLength(2);
  });

  it('reports not_found rather than inventing a product', async () => {
    const result = await findStock(STORE, 'caviar');
    expect(result.status).toBe('not_found');
  });

  it('never sees another store’s products', async () => {
    // Tenancy proof. Tata Salt exists, but only in OTHER.
    const result = await findStock(STORE, 'tata salt');
    expect(result.status).toBe('not_found');
  });

  it('matches on brand as well as name', async () => {
    const result = await findStock(STORE, 'Aashirvaad');
    expect(result.status).toBe('found');
  });
});

describe('findStock against the real seeded catalogue', () => {
  // catalogue.test.ts only proves CATALOGUE *contains* two atta products. It does not prove
  // the mechanism the brief's own example depends on — "add atta" -> the model asking "which
  // one, Aashirvaad 5kg or loose?" — actually fires for a store built the way every real store
  // is built, via seedStore. This is that end-to-end proof, on a seeded store rather than the
  // synthetic two-row fixture the tests above use.
  beforeEach(async () => {
    await db.delete(stores).where(eq(stores.id, SEEDED_STORE));
    await db.insert(stores).values({ id: SEEDED_STORE, name: 'S', gstin: '27AAAAA0000A1Z5' });
    await seedStore(SEEDED_STORE);
  });

  afterAll(async () => {
    await db.delete(stores).where(eq(stores.id, SEEDED_STORE));
  });

  it('asks which atta on a seeded store', async () => {
    const result = await findStock(SEEDED_STORE, 'atta');
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      expect(result.candidates.length).toBeGreaterThanOrEqual(2);
      const names = result.candidates.map((c) => c.name);
      expect(names.some((n) => /aashirvaad/i.test(n))).toBe(true);
      expect(names.some((n) => /loose/i.test(n))).toBe(true);
    }
  });
});
