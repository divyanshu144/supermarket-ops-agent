import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from './client.js';
import { bills, idempotencyKeys, khataAccounts, preferences, stores } from './schema.js';

const STORE = 999000008n;

beforeEach(async () => {
  await db.delete(stores).where(eq(stores.id, STORE));
  await db.insert(stores).values({ id: STORE, name: 'S', gstin: '27AAAAA0000A1Z5' });
});

afterAll(async () => {
  await db.delete(stores).where(eq(stores.id, STORE));
  await pool.end();
});

describe('bills', () => {
  it('allows several concurrent draft bills per store', async () => {
    // The brief's "two bills in flight" is intra-chat, so multiple drafts must stay legal.
    await db.insert(bills).values([{ storeId: STORE }, { storeId: STORE }]);
    const rows = await db.select().from(bills).where(eq(bills.storeId, STORE));
    expect(rows).toHaveLength(2);
  });

  it('rejects a duplicate invoice number within a store', async () => {
    await db.insert(bills).values({ storeId: STORE, status: 'finalized', invoiceNumber: 'INV-1' });
    await expect(
      db.insert(bills).values({ storeId: STORE, status: 'finalized', invoiceNumber: 'INV-1' }),
    ).rejects.toThrow();
  });

  it('does not let the partial index block multiple un-numbered drafts', async () => {
    // invoiceNumber is NULL until finalize; the unique index is partial for exactly this reason.
    await db.insert(bills).values([{ storeId: STORE }, { storeId: STORE }, { storeId: STORE }]);
    const rows = await db.select().from(bills).where(eq(bills.storeId, STORE));
    expect(rows).toHaveLength(3);
  });
});

describe('khata_accounts', () => {
  it('treats customer names case-insensitively', async () => {
    await db.insert(khataAccounts).values({ storeId: STORE, customerName: 'Ramesh' });
    await expect(
      db.insert(khataAccounts).values({ storeId: STORE, customerName: 'ramesh' }),
    ).rejects.toThrow();
  });

  it('defaults a new account to a zero balance', async () => {
    const [account] = await db
      .insert(khataAccounts)
      .values({ storeId: STORE, customerName: 'Imran' })
      .returning();
    expect(account!.balancePaise).toBe(0);
  });
});

describe('idempotency_keys', () => {
  it('enforces uniqueness per store and key — the constraint IS the enforcement', async () => {
    await db
      .insert(idempotencyKeys)
      .values({ storeId: STORE, key: 'k1', operation: 'finalize_bill', result: { ok: true } });

    await expect(
      db
        .insert(idempotencyKeys)
        .values({ storeId: STORE, key: 'k1', operation: 'finalize_bill', result: { ok: false } }),
    ).rejects.toThrow();
  });
});

describe('preferences', () => {
  it('stores one value per store and key', async () => {
    await db.insert(preferences).values({ storeId: STORE, key: 'default_payment', value: 'upi' });
    await expect(
      db.insert(preferences).values({ storeId: STORE, key: 'default_payment', value: 'cash' }),
    ).rejects.toThrow();
  });
});
