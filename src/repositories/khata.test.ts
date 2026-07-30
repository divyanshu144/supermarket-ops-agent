import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { khataAccounts, stores } from '../db/schema.js';
import {
  accountStatement,
  chargeAccount,
  findAccount,
  listAccounts,
  settleAccount,
} from './khata.js';

const STORE = 999000021n;
const OTHER = 999000022n;

beforeEach(async () => {
  for (const id of [STORE, OTHER]) {
    await db.delete(stores).where(eq(stores.id, id));
    await db.insert(stores).values({ id, name: 'Khata Kirana', gstin: '27AAAAA0000A1Z5' });
  }
  await db.insert(khataAccounts).values([
    { storeId: STORE, customerName: 'Ramesh', balancePaise: 50_000 },
    { storeId: OTHER, customerName: 'Hidden Customer', balancePaise: 99_900 },
  ]);
});

afterAll(async () => {
  for (const id of [STORE, OTHER]) await db.delete(stores).where(eq(stores.id, id));
  await pool.end();
});

describe('the charge/settle asymmetry', () => {
  it('CHARGING an unknown name opens the account — that is how a kirana works', async () => {
    const result = await chargeAccount(STORE, { customerName: 'Priya', amountPaise: 20_000 });

    expect(result.status).toBe('charged');
    expect(result.accountOpened).toBe(true);
    expect(result.newBalance).toBe('₹200.00');
  });

  it('SETTLING an unknown name refuses rather than opening an account', async () => {
    // Money arriving against a customer who does not exist is a mistake every time. Silently
    // opening an account would bury it behind a negative balance.
    const result = await settleAccount(STORE, { customerQuery: 'Nobody', amountPaise: 10_000 });

    expect(result.status).toBe('unknown_customer');

    const accounts = await listAccounts(STORE);
    expect(accounts.map((a) => a.customerName)).not.toContain('Nobody');
  });
});

describe('charging', () => {
  it('adds to an existing account, matching the name case-insensitively', async () => {
    const result = await chargeAccount(STORE, { customerName: 'ramesh', amountPaise: 10_000 });

    expect(result.accountOpened).toBe(false);
    expect(result.newBalance).toBe('₹600.00'); // 500 + 100

    const accounts = await listAccounts(STORE);
    expect(accounts.filter((a) => /ramesh/i.test(a.customerName))).toHaveLength(1);
  });

  it('records every charge as a ledger entry', async () => {
    await chargeAccount(STORE, { customerName: 'Ramesh', amountPaise: 5_000, note: 'chai' });
    const statement = await accountStatement(STORE, { customerQuery: 'Ramesh' });

    expect(statement.status).toBe('found');
    if (statement.status === 'found') {
      expect(statement.entries[0]!.kind).toBe('charge');
      expect(statement.entries[0]!.note).toBe('chai');
    }
  });
});

describe('settling', () => {
  it('reduces the balance and records a payment', async () => {
    const result = await settleAccount(STORE, { customerQuery: 'Ramesh', amountPaise: 30_000 });

    expect(result.status).toBe('settled');
    if (result.status === 'settled') expect(result.newBalance).toBe('₹200.00'); // 500 - 300

    const statement = await accountStatement(STORE, { customerQuery: 'Ramesh' });
    if (statement.status === 'found') expect(statement.entries[0]!.kind).toBe('payment');
  });

  it('refuses to take more than the outstanding balance', async () => {
    const result = await settleAccount(STORE, { customerQuery: 'Ramesh', amountPaise: 90_000 });

    expect(result.status).toBe('exceeds_balance');
    if (result.status === 'exceeds_balance') {
      expect(result.balance).toBe('₹500.00');
      expect(result.offered).toBe('₹900.00');
    }

    const after = await findAccount(STORE, 'Ramesh');
    if (after.status === 'found') expect(after.account.balancePaise).toBe(50_000); // untouched
  });

  it('allows an overpayment once the owner has confirmed', async () => {
    const result = await settleAccount(STORE, {
      customerQuery: 'Ramesh',
      amountPaise: 90_000,
      allowOverpay: true,
    });

    expect(result.status).toBe('settled');
    if (result.status === 'settled') expect(result.newBalance).toBe('-₹400.00');
  });

  it('settles exactly to zero without complaint', async () => {
    const result = await settleAccount(STORE, { customerQuery: 'Ramesh', amountPaise: 50_000 });
    expect(result.status).toBe('settled');
    if (result.status === 'settled') expect(result.newBalance).toBe('₹0.00');
  });
});

describe('tenancy', () => {
  it('never finds another store’s customer', async () => {
    const found = await findAccount(STORE, 'Hidden Customer');
    expect(found.status).toBe('not_found');
  });

  it('never settles against another store’s customer', async () => {
    const result = await settleAccount(STORE, {
      customerQuery: 'Hidden Customer',
      amountPaise: 1_000,
    });
    expect(result.status).toBe('unknown_customer');
  });

  it('lists only this store’s accounts', async () => {
    const accounts = await listAccounts(STORE);
    expect(accounts.map((a) => a.customerName)).toEqual(['Ramesh']);
  });
});
