import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import {
  auditLog,
  bills,
  khataAccounts,
  khataEntries,
  pendingActions,
  stores,
} from '../db/schema.js';
import { createPendingAction } from '../repositories/confirmations.js';
import { handleConfirmation } from './confirmed-actions.js';
import { previewCustomerPseudonymisation } from './privacy.js';

const STORE = 999000061n;
const OTHER = 999000062n;
const OWNER = 999000161n;
const OTHER_OWNER = 999000162n;
const ACCOUNT_ID = '4b5db255-b7a9-492e-a1cb-21e945c22215';
const OTHER_ACCOUNT_ID = '5b5db255-b7a9-492e-a1cb-21e945c22215';
const BILL_ID = '6b5db255-b7a9-492e-a1cb-21e945c22215';
const OTHER_BILL_ID = '7b5db255-b7a9-492e-a1cb-21e945c22215';

beforeEach(async () => {
  await db.delete(pendingActions).where(eq(pendingActions.storeId, STORE));
  await db.delete(auditLog).where(eq(auditLog.storeId, STORE));
  await db.delete(stores).where(eq(stores.id, STORE));
  await db.delete(stores).where(eq(stores.id, OTHER));
  await db.insert(stores).values([
    { id: STORE, ownerUserId: OWNER, name: 'Privacy shop', gstin: '27AAAAA0000A1Z5' },
    { id: OTHER, ownerUserId: OTHER_OWNER, name: 'Other shop', gstin: '27BBBBB0000B1Z5' },
  ]);
  await db.insert(bills).values([
    {
      id: BILL_ID,
      storeId: STORE,
      customerName: 'Ramesh',
      paymentRef: 'UPI-PRIVATE-REF',
      subtotalPaise: 1000,
      cgstPaise: 90,
      sgstPaise: 90,
      roundOffPaise: 20,
      totalPaise: 1200,
    },
    { id: OTHER_BILL_ID, storeId: OTHER, customerName: 'Ramesh', paymentRef: 'OTHER-REF' },
  ]);
  await db.insert(khataAccounts).values([
    {
      id: ACCOUNT_ID,
      storeId: STORE,
      customerName: 'Ramesh',
      phone: '9876543210',
      balancePaise: 1200,
    },
    {
      id: OTHER_ACCOUNT_ID,
      storeId: OTHER,
      customerName: 'Ramesh',
      phone: '9123456780',
      balancePaise: 4500,
    },
  ]);
  await db.insert(khataEntries).values([
    {
      accountId: ACCOUNT_ID,
      kind: 'charge',
      amountPaise: 1200,
      billId: BILL_ID,
      note: 'private ledger note',
    },
    { accountId: ACCOUNT_ID, kind: 'payment', amountPaise: 0, note: null },
    {
      accountId: OTHER_ACCOUNT_ID,
      kind: 'charge',
      amountPaise: 4500,
      billId: OTHER_BILL_ID,
      note: 'other store note',
    },
  ]);
});

afterAll(async () => {
  await db.delete(pendingActions).where(eq(pendingActions.storeId, STORE));
  await db.delete(auditLog).where(eq(auditLog.storeId, STORE));
  await db.delete(stores).where(eq(stores.id, STORE));
  await db.delete(stores).where(eq(stores.id, OTHER));
  await pool.end();
});

describe('customer pseudonymisation preview and confirmation', () => {
  it('returns counts without customer content and makes no change before confirmation', async () => {
    const preview = await previewCustomerPseudonymisation(STORE, 'Ramesh');
    expect(preview).toEqual({
      status: 'preview',
      accountId: ACCOUNT_ID,
      accounts: 1,
      bills: 1,
      notes: 1,
    });

    const [account] = await db.select().from(khataAccounts).where(eq(khataAccounts.id, ACCOUNT_ID));
    const [bill] = await db.select().from(bills).where(eq(bills.id, BILL_ID));
    expect(account!.customerName).toBe('Ramesh');
    expect(bill!.paymentRef).toBe('UPI-PRIVATE-REF');
  });

  it('requires the owner-bound W1 callback and preserves amounts while clearing identifiers', async () => {
    const pending = await createPendingAction({
      storeId: STORE,
      ownerUserId: OWNER,
      originatingUpdateId: 800000061n,
      tool: 'pseudonymise_customer',
      arguments: { account_id: ACCOUNT_ID },
    });
    expect(
      await handleConfirmation({
        decision: 'confirm',
        callbackId: pending.callbackId,
        storeId: STORE,
        ownerUserId: OTHER_OWNER,
        updateId: 800000062n,
      }),
    ).toEqual({ status: 'unavailable' });

    const [untouched] = await db
      .select()
      .from(khataAccounts)
      .where(eq(khataAccounts.id, ACCOUNT_ID));
    expect(untouched!.customerName).toBe('Ramesh');

    const result = await handleConfirmation({
      decision: 'confirm',
      callbackId: pending.callbackId,
      storeId: STORE,
      ownerUserId: OWNER,
      updateId: 800000063n,
    });
    expect(result).toEqual({ status: 'confirmed', outcome: 'pseudonymised' });

    const [account] = await db.select().from(khataAccounts).where(eq(khataAccounts.id, ACCOUNT_ID));
    const entries = await db
      .select()
      .from(khataEntries)
      .where(eq(khataEntries.accountId, ACCOUNT_ID));
    const [bill] = await db.select().from(bills).where(eq(bills.id, BILL_ID));
    const [foreignAccount] = await db
      .select()
      .from(khataAccounts)
      .where(eq(khataAccounts.id, OTHER_ACCOUNT_ID));
    const [foreignBill] = await db.select().from(bills).where(eq(bills.id, OTHER_BILL_ID));
    const audit = await db.select().from(auditLog).where(eq(auditLog.storeId, STORE));

    expect(account!.customerName).toBe(`Former customer ${ACCOUNT_ID}`);
    expect(account!.phone).toBeNull();
    expect(account!.balancePaise).toBe(1200);
    expect(entries.map((entry) => entry.amountPaise)).toEqual([1200, 0]);
    expect(entries.every((entry) => entry.note === null)).toBe(true);
    expect(bill!.customerName).toBe(`Former customer ${ACCOUNT_ID}`);
    expect(bill!.paymentRef).toBeNull();
    expect(bill!.totalPaise).toBe(1200);
    expect(foreignAccount!.customerName).toBe('Ramesh');
    expect(foreignAccount!.phone).toBe('9123456780');
    expect(foreignBill!.customerName).toBe('Ramesh');
    expect(foreignBill!.paymentRef).toBe('OTHER-REF');
    const serializedAudit = JSON.stringify(audit, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(serializedAudit).not.toContain('Ramesh');
    expect(serializedAudit).not.toContain('9876543210');
    expect(serializedAudit).not.toContain('private ledger note');
    expect(
      await handleConfirmation({
        decision: 'confirm',
        callbackId: pending.callbackId,
        storeId: STORE,
        ownerUserId: OWNER,
        updateId: 800000064n,
      }),
    ).toEqual({ status: 'unavailable' });
    expect(await db.select().from(auditLog).where(eq(auditLog.storeId, STORE))).toHaveLength(1);
  });
});
