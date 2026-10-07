import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { auditLog, billItems, pendingActions, products, stores } from '../db/schema.js';
import { addBillItem, getBill, openBill } from '../repositories/bills.js';
import { createPendingAction, hashBillSnapshot } from '../repositories/confirmations.js';
import { handleConfirmation } from './confirmed-actions.js';
import { finalizeBillTool, voidBillTool } from './billing.js';
import { settleKhataTool } from './khata.js';
import { proposeConfirmation } from './confirmation.js';
import { newToolContext, toolContext } from './context.js';
import { chargeAccount, findAccount } from '../repositories/khata.js';

const STORE = 999100051n;
const OWNER = 700051n;
const UPDATE = 8100051n;

async function fingerprint(billId: string): Promise<string> {
  const bill = await getBill(STORE, billId);
  return hashBillSnapshot(
    bill!.items.map((line) => ({
      lineNo: line.lineNo,
      productId: line.productId,
      qtyBase: line.qtyBase,
      unitPricePaise: line.unitPricePaise,
      gstRateBps: line.gstRateBps,
      hsnCode: line.hsnCode,
    })),
  );
}

async function draft(price: number): Promise<string> {
  const { billId } = await openBill(STORE);
  const added = await addBillItem(STORE, {
    billId,
    productQuery: 'Test Noodles',
    qty: 1,
    unit: 'packet',
    unitPriceOverridePaise: price,
  });
  expect(added.status).toBe('added');
  return billId;
}

async function pending(tool: string, billId: string, args: Record<string, unknown>) {
  return createPendingAction({
    storeId: STORE,
    ownerUserId: OWNER,
    originatingUpdateId: UPDATE,
    tool,
    arguments: args,
    billFingerprint: await fingerprint(billId),
  });
}

function resultText(result: Awaited<ReturnType<typeof finalizeBillTool.handler>>): string {
  const content = result.content[0];
  if (!content || content.type !== 'text') throw new Error('Expected text tool result');
  return content.text;
}

beforeEach(async () => {
  await db.delete(auditLog).where(eq(auditLog.storeId, STORE));
  await db.delete(stores).where(eq(stores.id, STORE));
  await db.insert(stores).values({
    id: STORE,
    ownerUserId: OWNER,
    name: 'Test Shop',
    gstin: '27AAAAA0000A1Z5',
  });
  await db.insert(products).values({
    storeId: STORE,
    name: 'Test Noodles',
    brand: 'Test',
    unit: 'packet',
    hsnCode: '19023010',
    gstRateBps: 1200,
    costPricePaise: 100,
    mrpPaise: 200,
    quantityBase: 5,
  });
});

afterAll(async () => {
  await db.delete(auditLog).where(eq(auditLog.storeId, STORE));
  await db.delete(stores).where(eq(stores.id, STORE));
  await pool.end();
});

describe('model-free confirmed actions', () => {
  it.each([undefined, false, true])(
    'does not let model-supplied allow_below_cost=%s authorize a bill',
    async (allowBelowCost) => {
      const billId = await draft(50);
      const context = newToolContext(STORE, UPDATE + 9n, undefined, OWNER);
      const args = {
        bill_id: billId,
        payment_mode: 'cash' as const,
        payment_ref: undefined,
        customer_name: undefined,
        allow_below_cost: allowBelowCost,
      };
      const result = await toolContext.run(context, () => finalizeBillTool.handler(args, {}));

      expect(JSON.parse(resultText(result))).toEqual({
        status: 'awaiting_confirmation',
        action: 'below_cost_finalize',
      });
      expect(context.pendingConfirmations).toHaveLength(1);
      expect((await getBill(STORE, billId))!.status).toBe('draft');
      const [product] = await db.select().from(products).where(eq(products.storeId, STORE));
      expect(product!.quantityBase).toBe(5);
    },
  );

  it.each([undefined, false, true])(
    'requires confirmation for model-supplied allow_overpay=%s',
    async (allowOverpay) => {
      await chargeAccount(STORE, {
        customerName: `Account ${String(allowOverpay)}`,
        amountPaise: 5_000,
      });
      const customer = `Account ${String(allowOverpay)}`;
      const context = newToolContext(STORE, UPDATE + 11n, undefined, OWNER);
      const args = {
        customer,
        amount_paise: 9_000,
        note: undefined,
        allow_overpay: allowOverpay,
      };
      const result = await toolContext.run(context, () => settleKhataTool.handler(args, {}));

      expect(JSON.parse(resultText(result)).status).toBe('awaiting_confirmation');
      expect(context.pendingConfirmations).toHaveLength(1);
      const account = await findAccount(STORE, customer);
      expect(account.status).toBe('found');
      if (account.status === 'found') expect(account.account.balancePaise).toBe(5_000);
    },
  );
  it('returns a pending result for void_bill without reversing stock', async () => {
    const billId = await draft(150);
    const { finalizeBill } = await import('../repositories/bills.js');
    await finalizeBill(STORE, { billId, paymentMode: 'cash' });
    const context = newToolContext(STORE, UPDATE + 10n, undefined, OWNER);
    const result = await toolContext.run(context, () =>
      voidBillTool.handler({ bill_id: billId }, {}),
    );

    expect(JSON.parse(resultText(result)).status).toBe('awaiting_confirmation');
    expect((await getBill(STORE, billId))!.status).toBe('finalized');
    const [product] = await db.select().from(products).where(eq(products.storeId, STORE));
    expect(product!.quantityBase).toBe(4);
  });

  it('waits for owner confirmation before accepting an overpaid khata settlement', async () => {
    await chargeAccount(STORE, { customerName: 'Account Owner', amountPaise: 5_000 });
    const context = newToolContext(STORE, UPDATE + 11n, undefined, OWNER);
    const result = await toolContext.run(context, () =>
      settleKhataTool.handler(
        { customer: 'Account Owner', amount_paise: 9_000, note: undefined, allow_overpay: false },
        {},
      ),
    );

    expect(JSON.parse(resultText(result)).status).toBe('awaiting_confirmation');
    expect(context.pendingConfirmations).toHaveLength(1);
    const account = await findAccount(STORE, 'Account Owner');
    expect(account.status).toBe('found');
    if (account.status === 'found') expect(account.account.balancePaise).toBe(5_000);

    const pendingAction = await db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.callbackId, context.pendingConfirmations[0]!.callbackId));
    const confirmed = await handleConfirmation({
      decision: 'confirm',
      callbackId: context.pendingConfirmations[0]!.callbackId,
      storeId: STORE,
      ownerUserId: OWNER,
      updateId: UPDATE + 12n,
    });
    expect(confirmed).toEqual({ status: 'confirmed', outcome: 'settled' });
    expect(pendingAction[0]!.argumentHash).toMatch(/^[0-9a-f]{64}$/);
    const after = await findAccount(STORE, 'Account Owner');
    expect(after.status).toBe('found');
    if (after.status === 'found') expect(after.account.balancePaise).toBe(-4_000);
  });

  it('finalizes a below-cost bill only after the owner callback and never twice', async () => {
    const billId = await draft(50);
    const action = await pending('finalize_bill', billId, {
      bill_id: billId,
      payment_mode: 'cash',
      allow_below_cost: true,
    });
    const input = {
      decision: 'confirm' as const,
      callbackId: action.callbackId,
      storeId: STORE,
      ownerUserId: OWNER,
      updateId: UPDATE + 1n,
    };

    expect(await handleConfirmation(input)).toEqual({ status: 'confirmed', outcome: 'finalized' });
    expect((await getBill(STORE, billId))!.status).toBe('finalized');
    const [product] = await db.select().from(products).where(eq(products.storeId, STORE));
    expect(product!.quantityBase).toBe(4);
    expect(await handleConfirmation({ ...input, updateId: UPDATE + 2n })).toEqual({
      status: 'unavailable',
    });
    const [after] = await db.select().from(products).where(eq(products.storeId, STORE));
    expect(after!.quantityBase).toBe(4);

    const rows = await db.select().from(auditLog).where(eq(auditLog.storeId, STORE));
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!)).toEqual([
      'id',
      'storeId',
      'action',
      'tool',
      'outcome',
      'updateId',
      'createdAt',
    ]);
    expect(rows.map((row) => `${row.action}|${row.tool}|${row.outcome}`).join('|')).not.toContain(
      'Test Noodles',
    );
  });

  it('refuses a stale confirmation if a bill line price changes', async () => {
    const billId = await draft(50);
    const action = await pending('finalize_bill', billId, {
      bill_id: billId,
      payment_mode: 'cash',
      allow_below_cost: true,
    });
    await db.update(billItems).set({ unitPricePaise: 75 }).where(eq(billItems.billId, billId));

    expect(
      await handleConfirmation({
        decision: 'confirm',
        callbackId: action.callbackId,
        storeId: STORE,
        ownerUserId: OWNER,
        updateId: UPDATE + 3n,
      }),
    ).toEqual({ status: 'stale_bill' });
    expect((await getBill(STORE, billId))!.status).toBe('draft');
    const [product] = await db.select().from(products).where(eq(products.storeId, STORE));
    expect(product!.quantityBase).toBe(5);
  });

  it('keeps the exact below-cost refusal snapshot when the bill changes before pending-row creation', async () => {
    const billId = await draft(50);
    const refusalFingerprint = await fingerprint(billId);
    await db.update(billItems).set({ unitPricePaise: 75 }).where(eq(billItems.billId, billId));
    const context = newToolContext(STORE, UPDATE + 20n, undefined, OWNER);

    await toolContext.run(context, () =>
      proposeConfirmation({
        tool: 'finalize_bill',
        action: 'below_cost_finalize',
        billId,
        billFingerprint: refusalFingerprint,
        arguments: { bill_id: billId, payment_mode: 'cash' },
      }),
    );

    const [row] = await db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.callbackId, context.pendingConfirmations[0]!.callbackId));
    expect(row!.billFingerprint).toBe(refusalFingerprint);
    expect(await fingerprint(billId)).not.toBe(row!.billFingerprint);
    expect(
      await handleConfirmation({
        decision: 'confirm',
        callbackId: row!.callbackId,
        storeId: STORE,
        ownerUserId: OWNER,
        updateId: UPDATE + 21n,
      }),
    ).toEqual({ status: 'stale_bill' });
    expect((await getBill(STORE, billId))!.status).toBe('draft');
  });

  it('rechecks the finalized bill fingerprint inside the stock-moving transaction', async () => {
    const billId = await draft(50);
    const expectedBillFingerprint = await fingerprint(billId);
    await db.update(billItems).set({ unitPricePaise: 75 }).where(eq(billItems.billId, billId));
    const { finalizeBill } = await import('../repositories/bills.js');

    expect(
      await finalizeBill(STORE, {
        billId,
        paymentMode: 'cash',
        allowBelowCost: true,
        expectedBillFingerprint,
      }),
    ).toEqual({ status: 'stale_confirmation' });
    expect((await getBill(STORE, billId))!.status).toBe('draft');
    const [product] = await db.select().from(products).where(eq(products.storeId, STORE));
    expect(product!.quantityBase).toBe(5);
  });

  it('rechecks the bill fingerprint inside the stock-restoring void transaction', async () => {
    const billId = await draft(150);
    const { finalizeBill, voidBill } = await import('../repositories/bills.js');
    await finalizeBill(STORE, { billId, paymentMode: 'cash' });
    const expectedBillFingerprint = await fingerprint(billId);
    await db.update(billItems).set({ unitPricePaise: 175 }).where(eq(billItems.billId, billId));

    expect(await voidBill(STORE, billId, expectedBillFingerprint)).toEqual({
      status: 'stale_confirmation',
    });
    expect((await getBill(STORE, billId))!.status).toBe('finalized');
    const [product] = await db.select().from(products).where(eq(products.storeId, STORE));
    expect(product!.quantityBase).toBe(4);
  });

  it('requires a bound confirmation before voiding a finalized bill', async () => {
    const billId = await draft(150);
    const { finalizeBill } = await import('../repositories/bills.js');
    await finalizeBill(STORE, { billId, paymentMode: 'cash' });
    const action = await pending('void_bill', billId, { bill_id: billId });

    expect(
      await handleConfirmation({
        decision: 'confirm',
        callbackId: action.callbackId,
        storeId: STORE,
        ownerUserId: OWNER,
        updateId: UPDATE + 4n,
      }),
    ).toEqual({ status: 'confirmed', outcome: 'voided' });
    expect((await getBill(STORE, billId))!.status).toBe('void');
    const [product] = await db.select().from(products).where(eq(products.storeId, STORE));
    expect(product!.quantityBase).toBe(5);
  });
});
