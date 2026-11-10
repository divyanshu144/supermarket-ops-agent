import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { auditLog, billItems, products, stores } from '../db/schema.js';
import { addBillItem, finalizeBill, openBill } from '../repositories/bills.js';
import { chargeAccount, findAccount, settleAccount } from '../repositories/khata.js';
import { finalizeBillTool, updateBillItemTool } from './billing.js';
import { getStockTool } from './inventory.js';
import { newToolContext, toolContext } from './context.js';

const STORE = 999100079n;
const OWNER = 700079n;
const UPDATE = 8100079n;
const NAMES = ['Aarav Fixture', 'Sara Fixture'] as const;

async function makeDraft(name: string, pricePaise: number) {
  const { billId } = await openBill(STORE, { customerName: name });
  const result = await addBillItem(STORE, {
    billId,
    productQuery: 'Fairness Rice',
    qty: 1,
    unit: 'packet',
    unitPriceOverridePaise: pricePaise,
  });
  expect(result.status).toBe('added');
  return billId;
}

function resultBody(value: unknown) {
  const toolResult = value as { content?: Array<{ type?: string; text?: string }> };
  const text = toolResult.content?.find((part) => part.type === 'text')?.text;
  if (!text) throw new Error('Expected JSON text tool result');
  return JSON.parse(text) as Record<string, unknown>;
}

beforeEach(async () => {
  await db.delete(auditLog).where(eq(auditLog.storeId, STORE));
  await db.delete(stores).where(eq(stores.id, STORE));
  await db.insert(stores).values({
    id: STORE,
    ownerUserId: OWNER,
    name: 'Synthetic fairness shop',
    gstin: '27AAAAA0000A1Z5',
  });
  await db.insert(products).values({
    storeId: STORE,
    name: 'Fairness Rice',
    brand: 'Fixture',
    unit: 'packet',
    hsnCode: '10063020',
    gstRateBps: 500,
    costPricePaise: 100,
    mrpPaise: 200,
    quantityBase: 10,
  });
});

afterAll(async () => {
  await db.delete(auditLog).where(eq(auditLog.storeId, STORE));
  await db.delete(stores).where(eq(stores.id, STORE));
  await pool.end();
});

describe('deterministic name invariance on real tools and Postgres', () => {
  it('preserves khata, confirmation, bill-edit, GST totals, and stock outcomes across name swaps', async () => {
    for (const name of NAMES)
      await chargeAccount(STORE, { customerName: name, amountPaise: 5_000 });
    const payments = await Promise.all(
      NAMES.map((name) => settleAccount(STORE, { customerQuery: name, amountPaise: 2_000 })),
    );
    expect(payments.map((result) => result.status)).toEqual(['settled', 'settled']);
    const balances = await Promise.all(
      NAMES.map(async (name) => {
        const result = await findAccount(STORE, name);
        return result.status === 'found' ? result.account.balancePaise : null;
      }),
    );
    expect(balances).toEqual([3_000, 3_000]);

    const belowCost = await Promise.all(
      NAMES.map(async (name, index) => {
        const billId = await makeDraft(name, 50);
        const context = newToolContext(STORE, UPDATE + BigInt(index + 1), undefined, OWNER);
        const body = resultBody(
          await toolContext.run(context, () =>
            finalizeBillTool.handler(
              {
                bill_id: billId,
                payment_mode: 'cash',
                payment_ref: undefined,
                customer_name: undefined,
                allow_below_cost: undefined,
              },
              {},
            ),
          ),
        );
        return {
          status: body.status,
          action: body.action,
          confirmations: context.pendingConfirmations.length,
        };
      }),
    );
    expect(belowCost).toEqual([
      { status: 'awaiting_confirmation', action: 'below_cost_finalize', confirmations: 1 },
      { status: 'awaiting_confirmation', action: 'below_cost_finalize', confirmations: 1 },
    ]);

    const editResults = await Promise.all(
      NAMES.map(async (name, index) => {
        const billId = await makeDraft(name, 150);
        const context = newToolContext(STORE, UPDATE + BigInt(index + 10), undefined, OWNER);
        const body = resultBody(
          await toolContext.run(context, () =>
            updateBillItemTool.handler(
              {
                bill_id: billId,
                product_query: 'Fairness Rice',
                qty: 2,
                unit: 'packet',
              },
              {},
            ),
          ),
        );
        const [line] = await db.select().from(billItems).where(eq(billItems.billId, billId));
        return { status: body.status, qtyBase: Number(line?.qtyBase) };
      }),
    );
    expect(editResults).toEqual([
      { status: 'updated', qtyBase: 2 },
      { status: 'updated', qtyBase: 2 },
    ]);

    const totals = await Promise.all(
      NAMES.map(async (name) => {
        const billId = await makeDraft(name, 150);
        const result = await finalizeBill(STORE, { billId, paymentMode: 'cash' });
        if (result.status !== 'finalized') throw new Error('Expected finalized control bill');
        return { subtotalPaise: result.totals.subtotalPaise, totalPaise: result.totals.totalPaise };
      }),
    );
    expect(totals[0]).toEqual(totals[1]);

    const stock = await Promise.all(
      NAMES.map(async (_name, index) => {
        const context = newToolContext(STORE, UPDATE + BigInt(index + 20), undefined, OWNER);
        const body = resultBody(
          await toolContext.run(context, () =>
            getStockTool.handler({ query: 'Fairness Rice' }, {}),
          ),
        );
        return {
          status: body.status,
          product: (body.product as Record<string, unknown> | undefined)?.name,
          quantity: (body.product as Record<string, unknown> | undefined)?.in_stock,
        };
      }),
    );
    expect(stock[0]).toEqual(stock[1]);
  });
});
