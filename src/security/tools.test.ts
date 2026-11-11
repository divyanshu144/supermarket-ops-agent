import { afterAll, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { stores, products, auditLog } from '../db/schema.js';
import { secureTools } from './tools.js';
import { chargeKhataTool } from '../tools/khata.js';
import { addBillItemTool } from '../tools/billing.js';
import { addProductTool } from '../tools/inventory.js';
import { newToolContext, toolContext } from '../tools/context.js';
import { findAccount } from '../repositories/khata.js';
import { handleConfirmation } from '../tools/confirmed-actions.js';
import { openBill, getBill } from '../repositories/bills.js';
const STORE = 987654321n;
const OWNER = 987654320n;
beforeEach(async () => {
  await db.delete(auditLog).where(eq(auditLog.storeId, STORE));
  await db.delete(stores).where(eq(stores.id, STORE));
  await db
    .insert(stores)
    .values({ id: STORE, ownerUserId: OWNER, name: 'Security fixture', gstin: '27AAAAA0000A1Z5' });
  await db.insert(products).values({
    storeId: STORE,
    name: 'Rice',
    unit: 'packet',
    hsnCode: '1006',
    gstRateBps: 500,
    costPricePaise: 5000,
    mrpPaise: 10000,
    quantityBase: 10,
  });
});
afterAll(async () => {
  await db.delete(auditLog).where(eq(auditLog.storeId, STORE));
  await db.delete(stores).where(eq(stores.id, STORE));
  await pool.end();
});
it('cannot charge credit until the bound owner confirms, then executes once', async () => {
  const context = newToolContext(STORE, 100n, undefined, OWNER);
  const [secured] = secureTools([chargeKhataTool]);
  await toolContext.run(context, () =>
    secured!.handler(
      { customer_name: 'Fixture Customer', amount_paise: 10000, note: undefined },
      {},
    ),
  );
  expect((await findAccount(STORE, 'Fixture Customer')).status).toBe('not_found');
  const callbackId = context.pendingConfirmations[0]!.callbackId;
  expect(
    (
      await handleConfirmation({
        decision: 'confirm',
        callbackId,
        storeId: STORE,
        ownerUserId: OWNER + 1n,
        updateId: 101n,
      })
    ).status,
  ).toBe('unavailable');
  expect(
    (
      await handleConfirmation({
        decision: 'confirm',
        callbackId,
        storeId: STORE,
        ownerUserId: OWNER,
        updateId: 102n,
      })
    ).status,
  ).toBe('confirmed');
  const account = await findAccount(STORE, 'Fixture Customer');
  expect(account.status).toBe('found');
  if (account.status === 'found') expect(account.account.balancePaise).toBe(10000);
  expect(
    (
      await handleConfirmation({
        decision: 'confirm',
        callbackId,
        storeId: STORE,
        ownerUserId: OWNER,
        updateId: 103n,
      })
    ).status,
  ).toBe('unavailable');
});
it('rejects discounts above the cap without creating a pending action or editing a bill', async () => {
  const { billId } = await openBill(STORE);
  const context = newToolContext(STORE, 200n, undefined, OWNER);
  const [secured] = secureTools([addBillItemTool]);
  const result = await toolContext.run(context, () =>
    secured!.handler(
      { bill_id: billId, product_query: 'Rice', qty: 1, unit: 'packet', unit_price_override: 1 },
      {},
    ),
  );
  expect(JSON.stringify(result)).toContain('discount_cap');
  expect(context.pendingConfirmations).toHaveLength(0);
  expect((await getBill(STORE, billId))!.items).toHaveLength(0);
});
it('validates GST against supported catalogue slabs before any confirmation or write', async () => {
  const context = newToolContext(STORE, 300n, undefined, OWNER);
  const [secured] = secureTools([addProductTool]);
  await expect(
    toolContext.run(context, () =>
      secured!.handler(
        {
          name: 'Injected',
          brand: undefined,
          pack_size: undefined,
          is_loose: undefined,
          opening_qty: undefined,
          reorder_level: undefined,
          unit: 'packet',
          hsn_code: '1006',
          gst_rate_bps: 777 as 500,
          cost_price_paise: 100,
          mrp_paise: 200,
        },
        {},
      ),
    ),
  ).rejects.toThrow();
  expect(context.pendingConfirmations).toHaveLength(0);
});
