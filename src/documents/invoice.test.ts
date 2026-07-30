import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { products, stores } from '../db/schema.js';
import { addBillItem, finalizeBill, getBill, openBill } from '../repositories/bills.js';
import { buildInvoiceDoc, generateInvoicePdf } from './invoice.js';
import { formatPaise } from '../domain/money.js';

/** Mirrors the PDF's currency rendering — Helvetica has no glyph for the rupee sign. */
const rupees = (paise: number) => formatPaise(paise).replace('₹', 'Rs.');

const STORE = 999000030n;
const generated: string[] = [];

beforeEach(async () => {
  await db.delete(stores).where(eq(stores.id, STORE));
  await db
    .insert(stores)
    .values({ id: STORE, name: 'Sharma Kirana Store', gstin: '27AAAAA0000A1Z5' });
  await db.insert(products).values([
    {
      storeId: STORE,
      name: 'Maggi Noodles 70g',
      unit: 'packet',
      hsnCode: '19023010',
      gstRateBps: 1200,
      costPricePaise: 1000,
      mrpPaise: 1400,
      quantityBase: 50,
    },
    {
      storeId: STORE,
      name: 'Loose Sugar',
      unit: 'kg',
      isLoose: true,
      hsnCode: '17019100',
      gstRateBps: 0,
      costPricePaise: 3800,
      mrpPaise: 5200,
      quantityBase: 20_000,
    },
  ]);
});

afterAll(async () => {
  for (const path of generated) await rm(path, { force: true });
  await db.delete(stores).where(eq(stores.id, STORE));
  await pool.end();
});

async function finalizedBill(): Promise<string> {
  const { billId } = await openBill(STORE);
  await addBillItem(STORE, { billId, productQuery: 'Maggi', qty: 4, unit: 'packet' });
  await addBillItem(STORE, { billId, productQuery: 'Sugar', qty: 2.5, unit: 'kg' });
  const result = await finalizeBill(STORE, {
    billId,
    paymentMode: 'upi',
    paymentRef: 'UPI-9911',
  });
  expect(result.status).toBe('finalized');
  return billId;
}

describe('generateInvoicePdf', () => {
  it('writes a real PDF file', async () => {
    const billId = await finalizedBill();
    const result = await generateInvoicePdf(STORE, billId);

    expect(result.status).toBe('generated');
    if (result.status !== 'generated') return;
    generated.push(result.artifact.path);

    const bytes = await readFile(result.artifact.path);
    // Magic bytes, not just "a file exists".
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1000);
    expect(result.artifact.mime).toBe('application/pdf');
    expect(result.artifact.filename).toMatch(/^invoice-INV-\d+\.pdf$/);
  });

  it('puts totals in the document that match the database exactly', async () => {
    const billId = await finalizedBill();
    const bill = await getBill(STORE, billId);
    const doc = buildInvoiceDoc(bill!, { name: 'Sharma Kirana Store', gstin: '27AAAAA0000A1Z5' });
    const flat = JSON.stringify(doc);

    // The rendered PDF compresses its content streams, so asserting on the document definition
    // is both deterministic and actually checks the numbers rather than the compressor.
    expect(flat).toContain(rupees(bill!.totals.totalPaise));
    expect(flat).toContain(rupees(bill!.totals.cgstPaise));
    expect(flat).toContain(rupees(bill!.totals.sgstPaise));
    expect(flat).toContain(bill!.invoiceNumber!);
  });

  it('includes the shop identity a GST invoice legally needs', async () => {
    const billId = await finalizedBill();
    const bill = await getBill(STORE, billId);
    const flat = JSON.stringify(
      buildInvoiceDoc(bill!, { name: 'Sharma Kirana Store', gstin: '27AAAAA0000A1Z5' }),
    );

    expect(flat).toContain('27AAAAA0000A1Z5'); // GSTIN
    expect(flat).toContain('TAX INVOICE');
    expect(flat).toContain('19023010'); // HSN of a billed line
    expect(flat).toContain('Sharma Kirana Store');
  });

  it('groups the tax summary by slab, not by line', async () => {
    // The bill has a 12% line and a 0% line, so exactly two slab rows must appear.
    const billId = await finalizedBill();
    const bill = await getBill(STORE, billId);
    const flat = JSON.stringify(
      buildInvoiceDoc(bill!, { name: 'Sharma Kirana Store', gstin: '27AAAAA0000A1Z5' }),
    );

    expect(flat).toContain('Tax Summary');
    expect(flat).toContain('"12%"');
    expect(flat).toContain('"0%"');
  });

  it('refuses to invoice a draft — it is not a tax document yet', async () => {
    const { billId } = await openBill(STORE);
    await addBillItem(STORE, { billId, productQuery: 'Maggi', qty: 1, unit: 'packet' });

    const result = await generateInvoicePdf(STORE, billId);
    expect(result.status).toBe('not_finalized');
  });

  it('refuses an unknown bill rather than throwing', async () => {
    const result = await generateInvoicePdf(STORE, '00000000-0000-4000-8000-000000000000');
    expect(result.status).toBe('bill_not_found');
  });
});
