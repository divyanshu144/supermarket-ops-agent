import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { pendingActions, stores } from '../db/schema.js';
import {
  claimPendingAction,
  cancelPendingAction,
  createPendingAction,
  hashBillSnapshot,
} from './confirmations.js';

const STORE_A = 999100041n;
const STORE_B = 999100042n;
const OWNER_A = 700041n;
const OWNER_B = 700042n;
const UPDATE_ID = 8_100_041n;

beforeEach(async () => {
  await db.delete(stores).where(inArray(stores.id, [STORE_A, STORE_B]));
  await db.insert(stores).values([
    { id: STORE_A, ownerUserId: OWNER_A, name: 'A', gstin: '27AAAAA0000A1Z5' },
    { id: STORE_B, ownerUserId: OWNER_B, name: 'B', gstin: '27BBBBB0000B1Z6' },
  ]);
});

afterAll(async () => {
  await db.delete(stores).where(inArray(stores.id, [STORE_A, STORE_B]));
  await pool.end();
});

describe('pending action confirmations', () => {
  it('maps a short callback id to exact arguments in a store and owner bound row', async () => {
    const args = { bill_id: 'bill-a', payment_mode: 'cash', allow_below_cost: true };
    const pending = await createPendingAction({
      storeId: STORE_A,
      ownerUserId: OWNER_A,
      originatingUpdateId: UPDATE_ID,
      tool: 'finalize_bill',
      arguments: args,
      billFingerprint: 'fingerprint-a',
    });

    expect(pending.callbackId.length).toBeLessThanOrEqual(64);
    expect(pending.callbackId).not.toContain(JSON.stringify(args));
    const [row] = await db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.callbackId, pending.callbackId));
    expect(row).toMatchObject({
      storeId: STORE_A,
      ownerUserId: OWNER_A,
      originatingUpdateId: UPDATE_ID,
      tool: 'finalize_bill',
      arguments: args,
      billFingerprint: 'fingerprint-a',
      status: 'pending',
    });
    expect(row!.argumentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('atomically refuses another store, another user, the proposal update, and expired callbacks', async () => {
    const now = new Date();
    const pending = await createPendingAction({
      storeId: STORE_A,
      ownerUserId: OWNER_A,
      originatingUpdateId: UPDATE_ID,
      tool: 'void_bill',
      arguments: { bill_id: 'bill-a' },
      now,
    });
    const common = { callbackId: pending.callbackId, updateId: UPDATE_ID + 1n, now };
    expect(
      await claimPendingAction({ ...common, storeId: STORE_B, ownerUserId: OWNER_A }),
    ).toBeNull();
    expect(
      await claimPendingAction({ ...common, storeId: STORE_A, ownerUserId: OWNER_B }),
    ).toBeNull();
    expect(
      await claimPendingAction({
        callbackId: pending.callbackId,
        storeId: STORE_A,
        ownerUserId: OWNER_A,
        updateId: UPDATE_ID,
      }),
    ).toBeNull();
    expect(
      await claimPendingAction({
        ...common,
        storeId: STORE_A,
        ownerUserId: OWNER_A,
        now: new Date(now.getTime() + 11 * 60 * 1000),
      }),
    ).toBeNull();
  });

  it('allows only one callback claim, even when Telegram redelivers concurrently', async () => {
    const pending = await createPendingAction({
      storeId: STORE_A,
      ownerUserId: OWNER_A,
      originatingUpdateId: UPDATE_ID,
      tool: 'void_bill',
      arguments: { bill_id: 'bill-a' },
    });
    const claims = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        claimPendingAction({
          callbackId: pending.callbackId,
          storeId: STORE_A,
          ownerUserId: OWNER_A,
          updateId: UPDATE_ID + BigInt(index) + 1n,
        }),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('cancels only an unexpired pending action from a distinct update', async () => {
    const pending = await createPendingAction({
      storeId: STORE_A,
      ownerUserId: OWNER_A,
      originatingUpdateId: UPDATE_ID,
      tool: 'void_bill',
      arguments: { bill_id: 'bill-a' },
    });
    expect(
      await cancelPendingAction({
        callbackId: pending.callbackId,
        storeId: STORE_A,
        ownerUserId: OWNER_A,
        updateId: UPDATE_ID,
      }),
    ).toBe(false);
    expect(
      await cancelPendingAction({
        callbackId: pending.callbackId,
        storeId: STORE_A,
        ownerUserId: OWNER_A,
        updateId: UPDATE_ID + 1n,
      }),
    ).toBe(true);
    const [row] = await db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.callbackId, pending.callbackId));
    expect(row!.status).toBe('cancelled');
  });

  it('changes the bill fingerprint when a line quantity or price changes', () => {
    const base = [
      {
        lineNo: 1,
        productId: 'p1',
        qtyBase: 2,
        unitPricePaise: 500,
        gstRateBps: 500,
        hsnCode: '1234',
      },
    ];
    expect(hashBillSnapshot(base)).toBe(hashBillSnapshot([...base].reverse()));
    expect(hashBillSnapshot(base)).not.toBe(
      hashBillSnapshot([{ ...base[0]!, unitPricePaise: 501 }]),
    );
    expect(hashBillSnapshot(base)).not.toBe(hashBillSnapshot([{ ...base[0]!, qtyBase: 3 }]));
  });
});
