import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import {
  billItems,
  bills,
  khataAccounts,
  khataEntries,
  products,
  stockMovements,
  stores,
} from '../db/schema.js';
import {
  addBillItem,
  finalizeBill,
  findBills,
  getBill,
  openBill,
  removeBillItem,
  updateBillItem,
  voidBill,
} from './bills.js';

const STORE = 999000012n;
const OTHER = 999000013n;

/** Fixed catalogue so every expected paise figure below is hand-checkable. */
const CATALOGUE = [
  {
    name: 'Maggi Noodles 70g',
    brand: 'Maggi',
    unit: 'packet' as const,
    hsnCode: '19023010',
    gstRateBps: 1200,
    costPricePaise: 1000,
    mrpPaise: 1400,
    quantityBase: 6,
  },
  {
    name: 'Maggi Ketchup 500g',
    brand: 'Maggi',
    unit: 'packet' as const,
    hsnCode: '21032000',
    gstRateBps: 1200,
    costPricePaise: 8000,
    mrpPaise: 11000,
    quantityBase: 10,
  },
  {
    name: 'Loose Sugar',
    unit: 'kg' as const,
    isLoose: true,
    hsnCode: '17019100',
    gstRateBps: 0,
    costPricePaise: 3800,
    mrpPaise: 4500,
    quantityBase: 10_000,
  },
];

async function stockOf(name: string): Promise<number> {
  const [row] = await db
    .select({ quantityBase: products.quantityBase })
    .from(products)
    .where(and(eq(products.storeId, STORE), eq(products.name, name)));
  return row!.quantityBase;
}

/** Opens a draft with the given lines and returns its id. */
async function draftWith(lines: Array<{ query: string; qty: number; unit: 'packet' | 'kg' }>) {
  const { billId } = await openBill(STORE);
  for (const line of lines) {
    const result = await addBillItem(STORE, {
      billId,
      productQuery: line.query,
      qty: line.qty,
      unit: line.unit,
    });
    expect(result.status).toBe('added');
  }
  return billId;
}

beforeEach(async () => {
  for (const id of [STORE, OTHER]) {
    await db.delete(stores).where(eq(stores.id, id));
    await db.insert(stores).values({ id, name: 'Test Kirana', gstin: '27AAAAA0000A1Z5' });
    await db.insert(products).values(CATALOGUE.map((p) => ({ ...p, storeId: id })));
  }
});

afterAll(async () => {
  for (const id of [STORE, OTHER]) await db.delete(stores).where(eq(stores.id, id));
  await pool.end();
});

describe('openBill / getBill', () => {
  it('opens an empty draft', async () => {
    const { billId } = await openBill(STORE, { customerName: '  Ramesh  ' });
    const bill = await getBill(STORE, billId);

    expect(bill!.status).toBe('draft');
    expect(bill!.customerName).toBe('Ramesh');
    expect(bill!.items).toEqual([]);
    expect(bill!.totals.totalPaise).toBe(0);
    expect(bill!.invoiceNumber).toBeNull();
  });

  it('allows several drafts at once', async () => {
    const a = await openBill(STORE);
    const b = await openBill(STORE);
    expect(a.billId).not.toBe(b.billId);
  });

  it('never returns another store’s bill', async () => {
    const { billId } = await openBill(OTHER);
    expect(await getBill(STORE, billId)).toBeNull();
  });

  it('treats a malformed bill id as not found rather than crashing', async () => {
    // The id reaches us from the model, so it can be any string at all.
    expect(await getBill(STORE, 'not-a-uuid')).toBeNull();
  });
});

describe('addBillItem', () => {
  it('snapshots price, GST rate and HSN at add time', async () => {
    const billId = await draftWith([{ query: 'noodles', qty: 2, unit: 'packet' }]);

    await db
      .update(products)
      .set({ mrpPaise: 9900, gstRateBps: 1800 })
      .where(and(eq(products.storeId, STORE), eq(products.name, 'Maggi Noodles 70g')));

    const bill = await getBill(STORE, billId);
    expect(bill!.items[0]!.unitPricePaise).toBe(1400);
    expect(bill!.items[0]!.gstRateBps).toBe(1200);
    expect(bill!.items[0]!.hsnCode).toBe('19023010');
  });

  it('accepts a price override', async () => {
    const { billId } = await openBill(STORE);
    await addBillItem(STORE, {
      billId,
      productQuery: 'noodles',
      qty: 1,
      unit: 'packet',
      unitPriceOverridePaise: 1300,
    });

    const bill = await getBill(STORE, billId);
    expect(bill!.items[0]!.unitPricePaise).toBe(1300);
  });

  it('keeps two identical lines as two lines', async () => {
    const billId = await draftWith([
      { query: 'noodles', qty: 1, unit: 'packet' },
      { query: 'noodles', qty: 1, unit: 'packet' },
    ]);

    const bill = await getBill(STORE, billId);
    expect(bill!.items).toHaveLength(2);
  });

  it('returns candidates instead of guessing', async () => {
    const { billId } = await openBill(STORE);
    const result = await addBillItem(STORE, {
      billId,
      productQuery: 'maggi',
      qty: 1,
      unit: 'packet',
    });

    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') expect(result.candidates).toHaveLength(2);
  });

  it('refuses an unknown product', async () => {
    const { billId } = await openBill(STORE);
    const result = await addBillItem(STORE, {
      billId,
      productQuery: 'caviar',
      qty: 1,
      unit: 'packet',
    });
    expect(result.status).toBe('product_not_found');
  });

  it('refuses a quantity in the wrong dimension', async () => {
    // "2 kg of Maggi packets" must not become 2000 packets.
    const { billId } = await openBill(STORE);
    const result = await addBillItem(STORE, {
      billId,
      productQuery: 'noodles',
      qty: 2,
      unit: 'kg',
    });

    expect(result.status).toBe('invalid_quantity');
    if (result.status === 'invalid_quantity') expect(result.reason).toContain('packet');
  });

  it('refuses a fractional packet and a zero quantity', async () => {
    const { billId } = await openBill(STORE);
    expect(
      (await addBillItem(STORE, { billId, productQuery: 'noodles', qty: 1.5, unit: 'packet' }))
        .status,
    ).toBe('invalid_quantity');
    expect(
      (await addBillItem(STORE, { billId, productQuery: 'noodles', qty: 0, unit: 'packet' }))
        .status,
    ).toBe('invalid_quantity');
  });

  it('converts grams into a kilogram-priced product', async () => {
    const { billId } = await openBill(STORE);
    await addBillItem(STORE, { billId, productQuery: 'sugar', qty: 500, unit: 'g' });

    const bill = await getBill(STORE, billId);
    expect(bill!.items[0]!.qtyBase).toBe(500);
    expect(bill!.items[0]!.lineTotalPaise).toBe(2250);
  });

  it('refuses to touch a finalized bill', async () => {
    const billId = await draftWith([{ query: 'noodles', qty: 1, unit: 'packet' }]);
    await finalizeBill(STORE, { billId, paymentMode: 'cash' });

    const result = await addBillItem(STORE, { billId, productQuery: 'sugar', qty: 1, unit: 'kg' });
    expect(result.status).toBe('bill_not_draft');
  });
});

describe('updateBillItem / removeBillItem', () => {
  it('sets the quantity of a line', async () => {
    const billId = await draftWith([{ query: 'noodles', qty: 1, unit: 'packet' }]);
    const result = await updateBillItem(STORE, {
      billId,
      productQuery: 'noodles',
      qty: 3,
      unit: 'packet',
    });

    expect(result.status).toBe('updated');
    if (result.status === 'updated') expect(result.bill.items[0]!.qtyBase).toBe(3);
  });

  it('collapses duplicate lines of the same product into the requested quantity', async () => {
    // "make it 3" is a statement about the bill, not about one of two identical lines.
    const billId = await draftWith([
      { query: 'noodles', qty: 1, unit: 'packet' },
      { query: 'noodles', qty: 1, unit: 'packet' },
    ]);
    await updateBillItem(STORE, { billId, productQuery: 'noodles', qty: 3, unit: 'packet' });

    const bill = await getBill(STORE, billId);
    expect(bill!.items).toHaveLength(1);
    expect(bill!.items[0]!.qtyBase).toBe(3);
  });

  it('refuses to update a product that is not on the bill', async () => {
    const billId = await draftWith([{ query: 'noodles', qty: 1, unit: 'packet' }]);
    const result = await updateBillItem(STORE, {
      billId,
      productQuery: 'sugar',
      qty: 1,
      unit: 'kg',
    });
    expect(result.status).toBe('item_not_on_bill');
  });

  it('removes every line of the product', async () => {
    const billId = await draftWith([
      { query: 'noodles', qty: 1, unit: 'packet' },
      { query: 'noodles', qty: 2, unit: 'packet' },
      { query: 'sugar', qty: 1, unit: 'kg' },
    ]);
    const result = await removeBillItem(STORE, { billId, productQuery: 'noodles' });

    expect(result.status).toBe('removed');
    if (result.status === 'removed') {
      expect(result.bill.items).toHaveLength(1);
      expect(result.bill.items[0]!.name).toBe('Loose Sugar');
    }
  });

  it('refuses to remove something that was never on the bill', async () => {
    const billId = await draftWith([{ query: 'noodles', qty: 1, unit: 'packet' }]);
    const result = await removeBillItem(STORE, { billId, productQuery: 'sugar' });
    expect(result.status).toBe('item_not_on_bill');
  });
});

describe('bill totals', () => {
  it('back-calculates GST out of the MRP and rounds once, at the bill level', async () => {
    // 2 x ₹14.00 at 12% → line ₹28.00, taxable ₹25.00, GST ₹3.00 (₹1.50 + ₹1.50).
    // 1.5 kg sugar at ₹45.00/kg at 0% → line ₹67.50, all taxable.
    // Gross ₹95.50 → ₹96.00 with a 50 paise round-off.
    const billId = await draftWith([
      { query: 'noodles', qty: 2, unit: 'packet' },
      { query: 'sugar', qty: 1.5, unit: 'kg' },
    ]);

    const bill = await getBill(STORE, billId);
    expect(bill!.totals).toEqual({
      subtotalPaise: 9250,
      cgstPaise: 150,
      sgstPaise: 150,
      roundOffPaise: 50,
      totalPaise: 9600,
    });
  });

  it('never adds GST on top of the MRP', async () => {
    const billId = await draftWith([{ query: 'ketchup', qty: 1, unit: 'packet' }]);
    const bill = await getBill(STORE, billId);
    const line = bill!.items[0]!;

    expect(line.lineTotalPaise).toBe(11000);
    expect(line.taxablePaise + line.cgstPaise + line.sgstPaise).toBe(11000);
  });
});

describe('finalizeBill', () => {
  it('decrements stock, numbers the invoice and writes sale movements', async () => {
    const billId = await draftWith([
      { query: 'noodles', qty: 2, unit: 'packet' },
      { query: 'sugar', qty: 1.5, unit: 'kg' },
    ]);
    const result = await finalizeBill(STORE, { billId, paymentMode: 'cash' });

    expect(result.status).toBe('finalized');
    if (result.status !== 'finalized') return;
    expect(result.invoiceNumber).toBe('INV-0001');
    expect(result.totals.totalPaise).toBe(9600);

    expect(await stockOf('Maggi Noodles 70g')).toBe(4);
    expect(await stockOf('Loose Sugar')).toBe(8500);

    const movements = await db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.billId, billId));
    expect(movements).toHaveLength(2);
    expect(movements.every((m) => m.kind === 'sale' && m.qtyBaseDelta < 0)).toBe(true);
  });

  it('stores the totals on the bill so the invoice of record cannot drift', async () => {
    const billId = await draftWith([{ query: 'noodles', qty: 2, unit: 'packet' }]);
    await finalizeBill(STORE, { billId, paymentMode: 'upi', paymentRef: 'UPI-99' });

    const [row] = await db.select().from(bills).where(eq(bills.id, billId));
    expect(row!.subtotalPaise).toBe(2500);
    expect(row!.cgstPaise).toBe(150);
    expect(row!.sgstPaise).toBe(150);
    expect(row!.totalPaise).toBe(2800);
    expect(row!.paymentRef).toBe('UPI-99');
    expect(row!.finalizedAt).not.toBeNull();
  });

  it('treats a repeat finalize as a success, not a second decrement', async () => {
    const billId = await draftWith([{ query: 'noodles', qty: 2, unit: 'packet' }]);
    const first = await finalizeBill(STORE, { billId, paymentMode: 'cash' });
    const second = await finalizeBill(STORE, { billId, paymentMode: 'cash' });

    expect(second.status).toBe('already_finalized');
    if (first.status !== 'finalized' || second.status !== 'already_finalized') return;
    expect(second.invoiceNumber).toBe(first.invoiceNumber);
    expect(second.totals).toEqual(first.totals);
    expect(await stockOf('Maggi Noodles 70g')).toBe(4);

    const movements = await db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.billId, billId));
    expect(movements).toHaveLength(1);
  });

  it('numbers invoices per store, in sequence', async () => {
    const first = await draftWith([{ query: 'noodles', qty: 1, unit: 'packet' }]);
    const second = await draftWith([{ query: 'noodles', qty: 1, unit: 'packet' }]);
    const a = await finalizeBill(STORE, { billId: first, paymentMode: 'cash' });
    const b = await finalizeBill(STORE, { billId: second, paymentMode: 'cash' });

    expect(a.status === 'finalized' && a.invoiceNumber).toBe('INV-0001');
    expect(b.status === 'finalized' && b.invoiceNumber).toBe('INV-0002');

    // A different store keeps its own series.
    const [other] = await db.insert(bills).values({ storeId: OTHER }).returning({ id: bills.id });
    await addBillItem(OTHER, {
      billId: other!.id,
      productQuery: 'noodles',
      qty: 1,
      unit: 'packet',
    });
    const c = await finalizeBill(OTHER, { billId: other!.id, paymentMode: 'cash' });
    expect(c.status === 'finalized' && c.invoiceNumber).toBe('INV-0001');
  });

  it('refuses an oversell and names every short item', async () => {
    const billId = await draftWith([
      { query: 'noodles', qty: 10, unit: 'packet' },
      { query: 'sugar', qty: 25, unit: 'kg' },
      { query: 'ketchup', qty: 1, unit: 'packet' },
    ]);
    const result = await finalizeBill(STORE, { billId, paymentMode: 'cash' });

    expect(result.status).toBe('insufficient_stock');
    if (result.status !== 'insufficient_stock') return;
    // Both short items, not just the first one hit.
    expect(result.shortfalls.map((s) => s.name).sort()).toEqual([
      'Loose Sugar',
      'Maggi Noodles 70g',
    ]);
    expect(result.shortfalls.find((s) => s.name === 'Maggi Noodles 70g')).toMatchObject({
      wanted: '10 packet',
      available: '6 packet',
    });

    // Nothing moved, and the bill is still editable.
    expect(await stockOf('Maggi Noodles 70g')).toBe(6);
    expect(await stockOf('Maggi Ketchup 500g')).toBe(10);
    expect((await getBill(STORE, billId))!.status).toBe('draft');
  });

  it('counts duplicate lines of one product together against stock', async () => {
    const billId = await draftWith([
      { query: 'noodles', qty: 4, unit: 'packet' },
      { query: 'noodles', qty: 4, unit: 'packet' },
    ]);
    const result = await finalizeBill(STORE, { billId, paymentMode: 'cash' });

    expect(result.status).toBe('insufficient_stock');
    expect(await stockOf('Maggi Noodles 70g')).toBe(6);
  });

  it('refuses a below-cost line unless the owner overrides', async () => {
    const { billId } = await openBill(STORE);
    await addBillItem(STORE, {
      billId,
      productQuery: 'noodles',
      qty: 1,
      unit: 'packet',
      unitPriceOverridePaise: 900,
    });

    const refused = await finalizeBill(STORE, { billId, paymentMode: 'cash' });
    expect(refused.status).toBe('below_cost');
    if (refused.status === 'below_cost') {
      expect(refused.lines[0]).toEqual({
        name: 'Maggi Noodles 70g',
        price: '₹9.00',
        cost: '₹10.00',
      });
    }
    expect(await stockOf('Maggi Noodles 70g')).toBe(6);

    const allowed = await finalizeBill(STORE, {
      billId,
      paymentMode: 'cash',
      allowBelowCost: true,
    });
    expect(allowed.status).toBe('finalized');
    expect(await stockOf('Maggi Noodles 70g')).toBe(5);
  });

  it('refuses an empty bill and an unknown bill', async () => {
    const { billId } = await openBill(STORE);
    expect((await finalizeBill(STORE, { billId, paymentMode: 'cash' })).status).toBe('empty_bill');
    expect((await finalizeBill(STORE, { billId: 'not-a-uuid', paymentMode: 'cash' })).status).toBe(
      'bill_not_found',
    );
  });

  it('never finalizes another store’s bill', async () => {
    const billId = await draftWith([{ query: 'noodles', qty: 1, unit: 'packet' }]);
    expect((await finalizeBill(OTHER, { billId, paymentMode: 'cash' })).status).toBe(
      'bill_not_found',
    );
  });
});

describe('finalizeBill on khata', () => {
  it('opens the account, charges it and updates the balance in one go', async () => {
    const billId = await draftWith([{ query: 'noodles', qty: 2, unit: 'packet' }]);
    const result = await finalizeBill(STORE, {
      billId,
      paymentMode: 'khata',
      customerName: 'Ramesh',
    });

    expect(result.status).toBe('finalized');
    if (result.status !== 'finalized') return;

    const [account] = await db
      .select()
      .from(khataAccounts)
      .where(and(eq(khataAccounts.storeId, STORE), eq(khataAccounts.customerName, 'Ramesh')));
    expect(account!.balancePaise).toBe(result.totals.totalPaise);

    const entries = await db
      .select()
      .from(khataEntries)
      .where(eq(khataEntries.accountId, account!.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe('charge');
    expect(entries[0]!.amountPaise).toBe(result.totals.totalPaise);
    expect(entries[0]!.billId).toBe(billId);
  });

  it('adds to an existing account, matching the name case-insensitively', async () => {
    await db.insert(khataAccounts).values({
      storeId: STORE,
      customerName: 'Ramesh',
      balancePaise: 5000,
    });

    const billId = await draftWith([{ query: 'noodles', qty: 2, unit: 'packet' }]);
    await finalizeBill(STORE, { billId, paymentMode: 'khata', customerName: 'ramesh' });

    const rows = await db.select().from(khataAccounts).where(eq(khataAccounts.storeId, STORE));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.balancePaise).toBe(5000 + 2800);
  });

  it('takes the customer from the bill when finalize does not repeat it', async () => {
    const { billId } = await openBill(STORE, { customerName: 'Imran' });
    await addBillItem(STORE, { billId, productQuery: 'noodles', qty: 1, unit: 'packet' });
    const result = await finalizeBill(STORE, { billId, paymentMode: 'khata' });

    expect(result.status).toBe('finalized');
    const [account] = await db.select().from(khataAccounts).where(eq(khataAccounts.storeId, STORE));
    expect(account!.customerName).toBe('Imran');
  });

  it('refuses a khata bill with nobody to charge', async () => {
    const billId = await draftWith([{ query: 'noodles', qty: 2, unit: 'packet' }]);
    const result = await finalizeBill(STORE, { billId, paymentMode: 'khata' });

    expect(result.status).toBe('unknown_customer');
    // Refused before anything moved.
    expect(await stockOf('Maggi Noodles 70g')).toBe(6);
    expect(await db.select().from(khataAccounts).where(eq(khataAccounts.storeId, STORE))).toEqual(
      [],
    );
  });
});

describe('voidBill', () => {
  it('restores stock with reversal movements and keeps every row', async () => {
    const billId = await draftWith([
      { query: 'noodles', qty: 2, unit: 'packet' },
      { query: 'sugar', qty: 1, unit: 'kg' },
    ]);
    await finalizeBill(STORE, { billId, paymentMode: 'cash' });

    const result = await voidBill(STORE, billId);
    expect(result.status).toBe('voided');
    if (result.status === 'voided') {
      expect(result.invoiceNumber).toBe('INV-0001');
      expect(result.restored).toHaveLength(2);
    }

    expect(await stockOf('Maggi Noodles 70g')).toBe(6);
    expect(await stockOf('Loose Sugar')).toBe(10_000);

    const movements = await db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.billId, billId));
    expect(movements).toHaveLength(4);
    expect(movements.filter((m) => m.kind === 'reversal')).toHaveLength(2);

    // Nothing is deleted: the bill, its lines and its invoice number all survive.
    const [row] = await db.select().from(bills).where(eq(bills.id, billId));
    expect(row!.status).toBe('void');
    expect(row!.invoiceNumber).toBe('INV-0001');
    expect(row!.totalPaise).toBe(7300);
    expect(await db.select().from(billItems).where(eq(billItems.billId, billId))).toHaveLength(2);
  });

  it('reverses the khata charge with a signed adjustment', async () => {
    const billId = await draftWith([{ query: 'noodles', qty: 2, unit: 'packet' }]);
    await finalizeBill(STORE, { billId, paymentMode: 'khata', customerName: 'Ramesh' });

    const result = await voidBill(STORE, billId);
    expect(result.status === 'voided' && result.khataReversedPaise).toBe(2800);

    const [account] = await db.select().from(khataAccounts).where(eq(khataAccounts.storeId, STORE));
    expect(account!.balancePaise).toBe(0);

    const entries = await db
      .select()
      .from(khataEntries)
      .where(eq(khataEntries.accountId, account!.id));
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.kind === 'adjustment')!.amountPaise).toBe(-2800);
  });

  it('is idempotent — a second void changes nothing', async () => {
    const billId = await draftWith([{ query: 'noodles', qty: 2, unit: 'packet' }]);
    await finalizeBill(STORE, { billId, paymentMode: 'cash' });
    await voidBill(STORE, billId);

    const second = await voidBill(STORE, billId);
    expect(second.status).toBe('already_void');
    expect(await stockOf('Maggi Noodles 70g')).toBe(6);
  });

  it('closes a draft without touching stock', async () => {
    const billId = await draftWith([{ query: 'noodles', qty: 2, unit: 'packet' }]);
    const result = await voidBill(STORE, billId);

    expect(result.status).toBe('voided');
    if (result.status === 'voided') expect(result.restored).toEqual([]);
    expect(await stockOf('Maggi Noodles 70g')).toBe(6);
  });

  it('refuses to void another store’s bill', async () => {
    const billId = await draftWith([{ query: 'noodles', qty: 1, unit: 'packet' }]);
    expect((await voidBill(OTHER, billId)).status).toBe('bill_not_found');
  });
});

describe('findBills', () => {
  it('finds by customer, newest first, and never crosses stores', async () => {
    const mine = await draftWith([{ query: 'noodles', qty: 1, unit: 'packet' }]);
    await finalizeBill(STORE, { billId: mine, paymentMode: 'khata', customerName: 'Ramesh' });
    await openBill(STORE, { customerName: 'Sunita' });
    await openBill(OTHER, { customerName: 'Ramesh' });

    const found = await findBills(STORE, { customer: 'rame' });
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(mine);
    expect(found[0]!.itemCount).toBe(1);
    expect(found[0]!.invoiceNumber).toBe('INV-0001');
    expect(found[0]!.totalPaise).toBe(1400);
  });

  it('filters by date and honours the limit', async () => {
    await openBill(STORE);
    await openBill(STORE);
    await openBill(STORE);

    expect(await findBills(STORE, { limit: 2 })).toHaveLength(2);
    expect(await findBills(STORE, { since: new Date(Date.now() + 60_000) })).toEqual([]);
  });
});

describe('fix round 1 — regression guards', () => {
  it('refuses a line priced above MRP, with no override available', async () => {
    // MRP is the maximum price at which the goods may legally be sold. Unlike below-cost,
    // which is the owner's money to lose, this one has no override argument at all.
    const { billId } = await openBill(STORE);
    const added = await addBillItem(STORE, {
      billId,
      productQuery: 'Maggi Noodles',
      qty: 1,
      unit: 'packet',
      unitPriceOverridePaise: 200_000, // ₹2000 for a ₹14 packet
    });
    expect(added.status).toBe('added');

    const result = await finalizeBill(STORE, { billId, paymentMode: 'cash' });

    expect(result.status).toBe('above_mrp');
    if (result.status === 'above_mrp') {
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0]!.price).toBe('₹2000.00');
      expect(result.lines[0]!.mrp).toBe('₹14.00');
    }
    // Refused before any write.
    expect(await stockOf('Maggi Noodles 70g')).toBe(6);
  });

  it('allows a line priced exactly at MRP', async () => {
    const { billId } = await openBill(STORE);
    await addBillItem(STORE, {
      billId,
      productQuery: 'Maggi Noodles',
      qty: 1,
      unit: 'packet',
      unitPriceOverridePaise: 1400, // exactly MRP — the boundary must not refuse
    });

    const result = await finalizeBill(STORE, { billId, paymentMode: 'cash' });
    expect(result.status).toBe('finalized');
  });

  it('decrements once by the aggregate but records one movement per line', async () => {
    // The riskiest invariant in this file: the decrement is aggregated per product while
    // movements stay per line. If those ever stop reconciling, the audit trail silently
    // disagrees with the stock figure.
    const billId = await draftWith([
      { query: 'Maggi Noodles', qty: 2, unit: 'packet' },
      { query: 'Maggi Noodles', qty: 2, unit: 'packet' },
    ]);

    const result = await finalizeBill(STORE, { billId, paymentMode: 'cash' });
    expect(result.status).toBe('finalized');

    expect(await stockOf('Maggi Noodles 70g')).toBe(2); // 6 - 4, decremented once

    const movements = await db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.billId, billId));

    expect(movements).toHaveLength(2); // one per line
    expect(movements.reduce((sum, m) => sum + m.qtyBaseDelta, 0)).toBe(-4); // and they reconcile
  });

  it('collapses duplicate lines deterministically, keeping the first line', async () => {
    // Before line_no existed this ordered by a random uuid, so with two lines at different
    // snapshotted prices the survivor — and therefore the bill total — was a coin flip.
    const { billId } = await openBill(STORE);

    await addBillItem(STORE, {
      billId,
      productQuery: 'Maggi Noodles',
      qty: 2,
      unit: 'packet',
    }); // line 1 @ MRP 1400

    await addBillItem(STORE, {
      billId,
      productQuery: 'Maggi Noodles',
      qty: 1,
      unit: 'packet',
      unitPriceOverridePaise: 1300,
    }); // line 2 @ discounted 1300

    await updateBillItem(STORE, {
      billId,
      productQuery: 'Maggi Noodles',
      qty: 3,
      unit: 'packet',
    });

    const rows = await db
      .select()
      .from(billItems)
      .where(eq(billItems.billId, billId))
      .orderBy(billItems.lineNo);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.lineNo).toBe(1);
    // Deterministically the FIRST line's snapshot, never the second's.
    expect(rows[0]!.unitPricePaise).toBe(1400);
    expect(rows[0]!.qtyBase).toBe(3);
  });

  it('renders bill lines in a stable order across repeated reads', async () => {
    // selectLines used to end on a random uuid, so the invoice PDF would reshuffle its own
    // lines between two renders of the same bill.
    const billId = await draftWith([
      { query: 'Maggi Noodles', qty: 1, unit: 'packet' },
      { query: 'Maggi Ketchup', qty: 1, unit: 'packet' },
      { query: 'Sugar', qty: 1, unit: 'kg' },
    ]);

    const first = await getBill(STORE, billId);
    const second = await getBill(STORE, billId);
    const third = await getBill(STORE, billId);

    const names = (b: typeof first) => b!.items.map((l) => l.name);
    expect(names(second)).toEqual(names(first));
    expect(names(third)).toEqual(names(first));
  });
});
