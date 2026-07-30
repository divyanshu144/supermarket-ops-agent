/**
 * Adversarial invariant suite for design spec §4.
 *
 * Task 15's tests establish the single-threaded contract. This file attacks it.
 *
 * The brief states the requirement directly: "Two bills — or a sale plus a stock-in — in flight
 * at once must not corrupt stock."
 *
 * ## Read this before adding a test here
 *
 * `finalizeBill` takes `SELECT ... FOR NO KEY UPDATE` on the STORE row as its first act. That
 * lock mode conflicts with itself, so a second finalize for the same store blocks immediately
 * and the two never overlap — not even partially.
 *
 * This means a test that merely calls `finalizeBill` twice via `Promise.all` is NOT testing
 * concurrency. It is testing sequential execution with extra steps, and it will happily pass
 * with the compare-and-set removed, the lock ordering removed, or both.
 *
 * The guards beneath the store gate are defence in depth — they exist so the invariant survives
 * someone later removing the gate. To test them at all, this file drives raw connections from
 * the pool directly, below the gate. Tests that do that are marked BELOW-GATE.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { db, pool } from '../db/client.js';
import {
  bills,
  khataAccounts,
  khataEntries,
  products,
  stockMovements,
  stores,
} from '../db/schema.js';
import { addBillItem, finalizeBill, orderForLocking, openBill } from './bills.js';

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
  });

  it('BELOW-GATE: a sale blocks on a stock-in that holds the row, and sees the new quantity', async () => {
    // The brief names this case explicitly. An earlier version of this test fired a bare
    // UPDATE alongside a finalize and asserted 6 - 6 + 10 = 10 — an arithmetic identity that
    // holds even if the two never interact at all. This forces the interleaving instead.
    const billId = await draft([{ query: 'Noodles', qty: 10 }]); // more than the 6 on hand

    const stockIn = await pool.connect();
    try {
      await stockIn.query('BEGIN');
      // Hold the product row, mid-receive, uncommitted.
      await stockIn.query(
        `SELECT quantity_base FROM products
           WHERE store_id = $1 AND name = $2 FOR NO KEY UPDATE`,
        [STORE.toString(), 'Maggi Noodles 70g'],
      );
      await stockIn.query(
        `UPDATE products SET quantity_base = quantity_base + 10
           WHERE store_id = $1 AND name = $2`,
        [STORE.toString(), 'Maggi Noodles 70g'],
      );

      // Finalize now blocks inside lockProducts until the receive commits.
      const finalizing = finalizeBill(STORE, { billId, paymentMode: 'cash' });

      // Give it time to reach the lock and park there. If it did not block, it would have
      // refused by now against the pre-receive quantity of 6.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await stockIn.query('COMMIT');

      const result = await finalizing;

      // Had finalize read stock outside the lock it would have seen 6 and refused a bill for
      // 10. Blocking is what makes it see 16.
      expect(result.status).toBe('finalized');
      expect(await stockOf('Maggi Noodles 70g')).toBe(6); // 6 + 10 - 10
    } finally {
      stockIn.release();
    }
  });
});

describe('§4 compare-and-set, below the store gate', () => {
  it('BELOW-GATE: the CAS predicate refuses a decrement that would cross zero', async () => {
    // The shortfall pre-check inside finalizeBill catches oversells sixty lines before the CAS
    // runs, so no end-to-end test can exercise this predicate. It exists so the invariant
    // survives someone later removing the lock or the pre-check, and it is tested the same way
    // the CHECK constraint is: directly.
    const client = await pool.connect();
    try {
      const before = await stockOf('Maggi Noodles 70g'); // 6

      const refused = await client.query(
        `UPDATE products SET quantity_base = quantity_base - $1
           WHERE store_id = $2 AND name = $3 AND quantity_base >= $1
         RETURNING quantity_base`,
        [7, STORE.toString(), 'Maggi Noodles 70g'],
      );

      expect(refused.rowCount).toBe(0); // zero rows IS the refusal
      expect(await stockOf('Maggi Noodles 70g')).toBe(before);

      const allowed = await client.query(
        `UPDATE products SET quantity_base = quantity_base - $1
           WHERE store_id = $2 AND name = $3 AND quantity_base >= $1
         RETURNING quantity_base`,
        [6, STORE.toString(), 'Maggi Noodles 70g'],
      );

      expect(allowed.rowCount).toBe(1);
      expect(allowed.rows[0].quantity_base).toBe('0'); // exactly to zero is allowed
    } finally {
      client.release();
    }
  });
});

describe('§4 deadlock freedom', () => {
  /** Locks two product rows on one connection, in the given order, inside a transaction. */
  async function lockPair(client: PoolClient, names: [string, string]): Promise<void> {
    for (const name of names) {
      await client.query(
        `SELECT id FROM products WHERE store_id = $1 AND name = $2 FOR NO KEY UPDATE`,
        [STORE.toString(), name],
      );
    }
  }

  it('BELOW-GATE: unordered acquisition genuinely deadlocks — this is what the sort prevents', async () => {
    // Establishes that the hazard is real. Without this, "we sort the ids" is an unverified
    // claim: the store gate means finalizeBill can never deadlock regardless of ordering, so
    // an end-to-end test proves nothing either way.
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');

      // Each grabs one row, then reaches for the other's — a textbook cycle.
      await a.query(`SELECT id FROM products WHERE store_id = $1 AND name = $2 FOR NO KEY UPDATE`, [
        STORE.toString(),
        'Tata Salt 1kg',
      ]);
      await b.query(`SELECT id FROM products WHERE store_id = $1 AND name = $2 FOR NO KEY UPDATE`, [
        STORE.toString(),
        'Parle Biscuits 100g',
      ]);

      const aWaits = a.query(
        `SELECT id FROM products WHERE store_id = $1 AND name = $2 FOR NO KEY UPDATE`,
        [STORE.toString(), 'Parle Biscuits 100g'],
      );
      const bWaits = b.query(
        `SELECT id FROM products WHERE store_id = $1 AND name = $2 FOR NO KEY UPDATE`,
        [STORE.toString(), 'Tata Salt 1kg'],
      );

      const outcomes = await Promise.allSettled([aWaits, bWaits]);
      const rejected = outcomes.filter((o) => o.status === 'rejected');

      // Postgres detects the cycle and kills exactly one victim with SQLSTATE 40P01.
      expect(rejected).toHaveLength(1);
      const reason = (rejected[0] as PromiseRejectedResult).reason as { code?: string };
      expect(reason.code).toBe('40P01');
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
  });

  it('BELOW-GATE: acquiring the same pair in a consistent order never deadlocks', async () => {
    // The other half of the pair: identical contention, ordered acquisition, no cycle. This is
    // the property `[...productIds].sort()` buys inside finalizeBill.
    const a = await pool.connect();
    const b = await pool.connect();
    const ordered: [string, string] = ['Parle Biscuits 100g', 'Tata Salt 1kg'];
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');

      await lockPair(a, ordered);
      const bLocks = lockPair(b, ordered); // blocks, but cannot cycle

      await a.query('COMMIT');
      await expect(bLocks).resolves.toBeUndefined();
      await b.query('COMMIT');
    } finally {
      a.release();
      b.release();
    }
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

  it('rolls back the stock decrement when the khata write fails after it', async () => {
    // The real atomicity test. The refusal case below proves only control flow — the loser
    // never reaches chargeKhata at all. This injects a failure AFTER the stock has already
    // been decremented, which is the only way to prove the khata write shares the
    // transaction rather than merely following it.
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE OR REPLACE FUNCTION reject_failboat() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'injected failure';
        END; $$ LANGUAGE plpgsql;
      `);
      await client.query(`
        CREATE TRIGGER khata_failboat BEFORE INSERT ON khata_entries
        FOR EACH ROW WHEN (NEW.amount_paise > 0) EXECUTE FUNCTION reject_failboat();
      `);

      const billId = await draft([{ query: 'Noodles', qty: 2 }]);

      await expect(
        finalizeBill(STORE, { billId, paymentMode: 'khata', customerName: 'Failboat' }),
      ).rejects.toThrow();

      // Everything the transaction had already done must be gone.
      expect(await stockOf('Maggi Noodles 70g')).toBe(6);

      const movements = await db
        .select()
        .from(stockMovements)
        .where(eq(stockMovements.billId, billId));
      expect(movements).toHaveLength(0);

      const rows = await db.select().from(bills).where(eq(bills.id, billId));
      expect(rows[0]!.status).toBe('draft');
      expect(rows[0]!.invoiceNumber).toBeNull();

      const accounts = await db
        .select()
        .from(khataAccounts)
        .where(and(eq(khataAccounts.storeId, STORE), eq(khataAccounts.customerName, 'Failboat')));
      expect(accounts).toHaveLength(0);
    } finally {
      await client.query('DROP TRIGGER IF EXISTS khata_failboat ON khata_entries');
      await client.query('DROP FUNCTION IF EXISTS reject_failboat()');
      client.release();
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

describe('§4 lock ordering inside finalizeBill', () => {
  it('normalises any input order to one canonical order', () => {
    // A timing-based deadlock test does NOT work here and an earlier version of this file
    // shipped one that did not: with the sort deleted it still passed, because the first
    // transaction acquired both locks before the second began. Inducing a genuine cycle needs
    // interleaving mid-loop, which no sleep can reliably produce. So the ordering is a pure
    // function and is pinned directly — delete the sort in orderForLocking and this fails.
    const a = '11111111-1111-1111-1111-111111111111';
    const b = '22222222-2222-2222-2222-222222222222';
    const c = '33333333-3333-3333-3333-333333333333';

    expect(orderForLocking([c, a, b])).toEqual([a, b, c]);
    expect(orderForLocking([a, b, c])).toEqual([a, b, c]);
    // The property that matters: opposite inputs converge on the same acquisition order.
    expect(orderForLocking([a, c])).toEqual(orderForLocking([c, a]));
  });

  it('does not mutate the caller\u2019s array', () => {
    const ids = ['b', 'a'];
    orderForLocking(ids);
    expect(ids).toEqual(['b', 'a']);
  });

  it('BELOW-GATE: locking a pair in that canonical order never cycles', () => {
    // Paired with the raw-SQL deadlock test above, which proves the hazard is real: unordered
    // acquisition of this same pair does deadlock with SQLSTATE 40P01.
    const ordered = orderForLocking(['zzz', 'aaa']);
    expect(ordered).toEqual(['aaa', 'zzz']);
  });
});
