/**
 * Adversarial invariant suite for design spec §4.
 *
 * Task 15's tests establish the single-threaded contract. This file attacks it: real concurrent
 * transactions against one Postgres, races, opposite lock orders, and partial failure. Each test
 * is written so that removing its guard makes it fail — not so that it passes today.
 *
 * The brief states the requirement directly: "Two bills — or a sale plus a stock-in — in flight
 * at once must not corrupt stock."
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import {
  bills,
  khataAccounts,
  khataEntries,
  products,
  stockMovements,
  stores,
} from '../db/schema.js';
import { addBillItem, finalizeBill, openBill } from './bills.js';

const STORE = 999000020n;

/** Tight stock on the noodles so races actually contend; generous elsewhere. */
const CATALOGUE = [
  {
    name: 'Maggi Noodles 70g',
    unit: 'packet' as const,
    hsnCode: '19023010',
    gstRateBps: 1200,
    costPricePaise: 1000,
    mrpPaise: 1400,
    quantityBase: 6,
  },
  {
    name: 'Tata Salt 1kg',
    unit: 'packet' as const,
    hsnCode: '25010020',
    gstRateBps: 500,
    costPricePaise: 2000,
    mrpPaise: 2800,
    quantityBase: 500,
  },
  {
    name: 'Parle Biscuits 100g',
    unit: 'packet' as const,
    hsnCode: '19053100',
    gstRateBps: 1800,
    costPricePaise: 800,
    mrpPaise: 1000,
    quantityBase: 500,
  },
];

async function stockOf(name: string): Promise<number> {
  const [row] = await db
    .select({ quantityBase: products.quantityBase })
    .from(products)
    .where(and(eq(products.storeId, STORE), eq(products.name, name)));
  return row!.quantityBase;
}

async function draft(lines: Array<{ query: string; qty: number }>): Promise<string> {
  const { billId } = await openBill(STORE);
  for (const line of lines) {
    const added = await addBillItem(STORE, {
      billId,
      productQuery: line.query,
      qty: line.qty,
      unit: 'packet',
    });
    expect(added.status).toBe('added');
  }
  return billId;
}

beforeEach(async () => {
  await db.delete(stores).where(eq(stores.id, STORE));
  await db.insert(stores).values({ id: STORE, name: 'Race Kirana', gstin: '27AAAAA0000A1Z5' });
  await db.insert(products).values(CATALOGUE.map((p) => ({ ...p, storeId: STORE })));
});

afterAll(async () => {
  await db.delete(stores).where(eq(stores.id, STORE));
  await pool.end();
});

describe('§4 oversell guard under concurrency', () => {
  it('lets exactly one of two racing bills win when stock covers only one', async () => {
    // 6 in stock, two bills wanting 4 each. Read-then-write would let both through and
    // leave stock at -2.
    const [billA, billB] = await Promise.all([
      draft([{ query: 'Noodles', qty: 4 }]),
      draft([{ query: 'Noodles', qty: 4 }]),
    ]);

    const results = await Promise.all([
      finalizeBill(STORE, { billId: billA, paymentMode: 'cash' }),
      finalizeBill(STORE, { billId: billB, paymentMode: 'cash' }),
    ]);

    const finalized = results.filter((r) => r.status === 'finalized');
    const refused = results.filter((r) => r.status === 'insufficient_stock');

    expect(finalized).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(await stockOf('Maggi Noodles 70g')).toBe(2);
  });

  it('never drives stock negative under a wider stampede', async () => {
    // Ten bills of 1 against 6 in stock: exactly six may win, and the survivor count must
    // match the stock consumed.
    const drafts = await Promise.all(
      Array.from({ length: 10 }, () => draft([{ query: 'Noodles', qty: 1 }])),
    );

    const results = await Promise.all(
      drafts.map((billId) => finalizeBill(STORE, { billId, paymentMode: 'cash' })),
    );

    const winners = results.filter((r) => r.status === 'finalized').length;

    expect(winners).toBe(6);
    expect(await stockOf('Maggi Noodles 70g')).toBe(0);
    expect(await stockOf('Maggi Noodles 70g')).toBeGreaterThanOrEqual(0);
  });

  it('holds when a sale and a stock-in are in flight together', async () => {
    // The brief names this case explicitly. A receive that lands mid-sale must not be lost,
    // and the sale must not consume stock the receive had not yet added.
    const billId = await draft([{ query: 'Noodles', qty: 6 }]);

    const [finalizeResult] = await Promise.all([
      finalizeBill(STORE, { billId, paymentMode: 'cash' }),
      db
        .update(products)
        .set({ quantityBase: sql`${products.quantityBase} + 10` })
        .where(and(eq(products.storeId, STORE), eq(products.name, 'Maggi Noodles 70g'))),
    ]);

    expect(finalizeResult.status).toBe('finalized');
    // 6 - 6 + 10 = 10, regardless of which committed first.
    expect(await stockOf('Maggi Noodles 70g')).toBe(10);
  });
});

describe('§4 deadlock freedom', () => {
  it('resolves two bills that touch the same products in opposite order', async () => {
    // Both have ample stock, so the only thing under test is lock acquisition order. Without
    // sorting product ids before locking, these two deadlock and Postgres kills one.
    const billA = await draft([
      { query: 'Salt', qty: 1 },
      { query: 'Biscuits', qty: 1 },
    ]);
    const billB = await draft([
      { query: 'Biscuits', qty: 1 },
      { query: 'Salt', qty: 1 },
    ]);

    const results = await Promise.all([
      finalizeBill(STORE, { billId: billA, paymentMode: 'cash' }),
      finalizeBill(STORE, { billId: billB, paymentMode: 'upi' }),
    ]);

    expect(results.map((r) => r.status)).toEqual(['finalized', 'finalized']);
    expect(await stockOf('Tata Salt 1kg')).toBe(498);
    expect(await stockOf('Parle Biscuits 100g')).toBe(498);
  });
});

describe('§4 invoice numbering under concurrency', () => {
  it('issues a distinct invoice number to every concurrent finalize', async () => {
    const drafts = await Promise.all(
      Array.from({ length: 8 }, () => draft([{ query: 'Salt', qty: 1 }])),
    );

    const results = await Promise.all(
      drafts.map((billId) => finalizeBill(STORE, { billId, paymentMode: 'cash' })),
    );

    const numbers = results
      .filter((r): r is Extract<typeof r, { status: 'finalized' }> => r.status === 'finalized')
      .map((r) => r.invoiceNumber);

    expect(numbers).toHaveLength(8);
    expect(new Set(numbers).size).toBe(8);
  });
});

describe('§4 khata atomicity', () => {
  it('writes the charge and the balance together, or neither', async () => {
    // The loser of a stock race must leave no ledger trace at all. If the khata write sat
    // outside the transaction, the refused bill would still have charged the customer.
    const [billA, billB] = await Promise.all([
      draft([{ query: 'Noodles', qty: 4 }]),
      draft([{ query: 'Noodles', qty: 4 }]),
    ]);

    const results = await Promise.all([
      finalizeBill(STORE, { billId: billA, paymentMode: 'khata', customerName: 'Ramesh' }),
      finalizeBill(STORE, { billId: billB, paymentMode: 'khata', customerName: 'Ramesh' }),
    ]);

    const winner = results.find((r) => r.status === 'finalized');
    expect(winner).toBeDefined();

    const [account] = await db
      .select()
      .from(khataAccounts)
      .where(and(eq(khataAccounts.storeId, STORE), eq(khataAccounts.customerName, 'Ramesh')));

    const entries = await db
      .select()
      .from(khataEntries)
      .where(eq(khataEntries.accountId, account!.id));

    // Exactly one bill's worth of credit, never two.
    expect(entries).toHaveLength(1);
    expect(account!.balancePaise).toBe(entries[0]!.amountPaise);

    if (winner?.status === 'finalized') {
      expect(account!.balancePaise).toBe(winner.totals.totalPaise);
    }
  });

  it('leaves no ledger entry behind when the bill is refused outright', async () => {
    const billId = await draft([{ query: 'Noodles', qty: 99 }]);

    const result = await finalizeBill(STORE, {
      billId,
      paymentMode: 'khata',
      customerName: 'Sunita',
    });

    expect(result.status).toBe('insufficient_stock');

    const accounts = await db
      .select()
      .from(khataAccounts)
      .where(and(eq(khataAccounts.storeId, STORE), eq(khataAccounts.customerName, 'Sunita')));

    // The account was never even opened, let alone charged.
    expect(accounts).toHaveLength(0);
    expect(await stockOf('Maggi Noodles 70g')).toBe(6);
  });
});

describe('§4 database backstop', () => {
  it('rejects a direct negative stock update even outside the repository', async () => {
    // The CHECK constraint is the last line of defence if anything ever bypasses the
    // compare-and-set in finalizeBill.
    await expect(
      db
        .update(products)
        .set({ quantityBase: -1 })
        .where(and(eq(products.storeId, STORE), eq(products.name, 'Maggi Noodles 70g'))),
    ).rejects.toThrow();

    expect(await stockOf('Maggi Noodles 70g')).toBe(6);
  });

  it('rejects a decrement that would cross zero', async () => {
    await expect(
      db
        .update(products)
        .set({ quantityBase: sql`${products.quantityBase} - 7` })
        .where(and(eq(products.storeId, STORE), eq(products.name, 'Maggi Noodles 70g'))),
    ).rejects.toThrow();
  });
});

describe('§4 idempotency under concurrency', () => {
  it('a doubly-submitted finalize decrements once', async () => {
    // Telegram redelivery can land the same finalize twice, potentially overlapping.
    const billId = await draft([{ query: 'Noodles', qty: 2 }]);

    const results = await Promise.all([
      finalizeBill(STORE, { billId, paymentMode: 'cash' }),
      finalizeBill(STORE, { billId, paymentMode: 'cash' }),
    ]);

    const numbers = results
      .filter(
        (r): r is Extract<typeof r, { status: 'finalized' | 'already_finalized' }> =>
          r.status === 'finalized' || r.status === 'already_finalized',
      )
      .map((r) => r.invoiceNumber);

    expect(numbers).toHaveLength(2);
    expect(new Set(numbers).size).toBe(1); // the same invoice, twice

    expect(await stockOf('Maggi Noodles 70g')).toBe(4); // 6 - 2, once

    const movements = await db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.billId, billId));
    expect(movements).toHaveLength(1);

    const rows = await db.select().from(bills).where(eq(bills.id, billId));
    expect(rows[0]!.status).toBe('finalized');
  });
});
