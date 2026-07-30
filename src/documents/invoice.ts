import { writeFile } from 'node:fs/promises';
import pdfmake from 'pdfmake';
import type { TDocumentDefinitions, Content } from 'pdfmake/interfaces.js';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { stores } from '../db/schema.js';
import { getBill, type BillView } from '../repositories/bills.js';
import { formatPaise } from '../domain/money.js';
import { artifactPath, type ArtifactHandle } from './artifacts.js';

/**
 * pdfmake needs font files. The standard 14 PDF fonts are built into every reader, so using
 * Helvetica avoids shipping and embedding a TTF — no binary assets, no container weight.
 */
const FONTS = {
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
};

/**
 * Rupee amounts are rendered as "Rs." rather than "₹" in the PDF.
 *
 * The built-in Helvetica encoding has no glyph for U+20B9, and pdfmake silently emits a blank
 * where it should be — so an invoice would show bare numbers with no currency at all. Embedding
 * a Unicode TTF would fix it properly; "Rs." is legal on a GST invoice and costs nothing.
 */
function rupees(paise: number): string {
  return formatPaise(paise).replace('₹', 'Rs.');
}

interface TaxSlabRow {
  gstRateBps: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
}

/** GST invoices must show tax grouped by slab, not only per line. */
function taxSummary(bill: BillView): TaxSlabRow[] {
  const bySlab = new Map<number, TaxSlabRow>();

  for (const item of bill.items) {
    const row = bySlab.get(item.gstRateBps) ?? {
      gstRateBps: item.gstRateBps,
      taxablePaise: 0,
      cgstPaise: 0,
      sgstPaise: 0,
    };
    row.taxablePaise += item.taxablePaise;
    row.cgstPaise += item.cgstPaise;
    row.sgstPaise += item.sgstPaise;
    bySlab.set(item.gstRateBps, row);
  }

  return [...bySlab.values()].sort((a, b) => a.gstRateBps - b.gstRateBps);
}

export type InvoiceResult =
  | { status: 'generated'; artifact: ArtifactHandle; invoiceNumber: string }
  | { status: 'bill_not_found'; billId: string }
  | { status: 'not_finalized'; billId: string };

/**
 * Builds the invoice document definition.
 *
 * Exported separately from rendering so its contents can be asserted directly. The rendered
 * PDF compresses its content streams, so grepping the bytes for "TAX INVOICE" or a GSTIN finds
 * nothing — a test written that way passes or fails for reasons unrelated to the invoice.
 */
export function buildInvoiceDoc(
  bill: BillView,
  store: { name: string; gstin: string } | undefined,
): TDocumentDefinitions {
  const lineHeader = ['#', 'Item', 'HSN', 'Qty', 'Rate', 'Taxable', 'CGST', 'SGST', 'Amount'].map(
    (text) => ({ text, bold: true, fontSize: 8 }),
  );

  const lineRows = bill.items.map((item) => [
    { text: String(item.lineNo), fontSize: 8 },
    { text: item.name, fontSize: 8 },
    { text: item.hsnCode, fontSize: 8 },
    { text: item.quantity, fontSize: 8 },
    { text: rupees(item.unitPricePaise), fontSize: 8, alignment: 'right' as const },
    { text: rupees(item.taxablePaise), fontSize: 8, alignment: 'right' as const },
    { text: rupees(item.cgstPaise), fontSize: 8, alignment: 'right' as const },
    { text: rupees(item.sgstPaise), fontSize: 8, alignment: 'right' as const },
    { text: rupees(item.lineTotalPaise), fontSize: 8, alignment: 'right' as const },
  ]);

  const slabHeader = ['GST Rate', 'Taxable Value', 'CGST', 'SGST', 'Total Tax'].map((text) => ({
    text,
    bold: true,
    fontSize: 8,
  }));

  const slabRows = taxSummary(bill).map((slab) => [
    { text: `${slab.gstRateBps / 100}%`, fontSize: 8 },
    { text: rupees(slab.taxablePaise), fontSize: 8, alignment: 'right' as const },
    { text: rupees(slab.cgstPaise), fontSize: 8, alignment: 'right' as const },
    { text: rupees(slab.sgstPaise), fontSize: 8, alignment: 'right' as const },
    {
      text: rupees(slab.cgstPaise + slab.sgstPaise),
      fontSize: 8,
      alignment: 'right' as const,
      bold: true,
    },
  ]);

  const totalsRows: Content = {
    table: {
      widths: ['*', 90],
      body: [
        [
          { text: 'Taxable Value', fontSize: 9 },
          { text: rupees(bill.totals.subtotalPaise), fontSize: 9, alignment: 'right' },
        ],
        [
          { text: 'CGST', fontSize: 9 },
          { text: rupees(bill.totals.cgstPaise), fontSize: 9, alignment: 'right' },
        ],
        [
          { text: 'SGST', fontSize: 9 },
          { text: rupees(bill.totals.sgstPaise), fontSize: 9, alignment: 'right' },
        ],
        [
          { text: 'Round Off', fontSize: 9 },
          { text: rupees(bill.totals.roundOffPaise), fontSize: 9, alignment: 'right' },
        ],
        [
          { text: 'TOTAL', bold: true, fontSize: 11 },
          { text: rupees(bill.totals.totalPaise), bold: true, fontSize: 11, alignment: 'right' },
        ],
      ],
    },
    layout: 'lightHorizontalLines',
  };

  const doc: TDocumentDefinitions = {
    defaultStyle: { font: 'Helvetica' },
    pageMargins: [30, 30, 30, 40],
    content: [
      { text: store?.name ?? 'Kirana Store', fontSize: 16, bold: true },
      { text: `GSTIN: ${store?.gstin ?? '-'}`, fontSize: 9, margin: [0, 2, 0, 0] },
      { text: 'TAX INVOICE', fontSize: 12, bold: true, alignment: 'center', margin: [0, 10, 0, 8] },
      {
        columns: [
          {
            text: [
              { text: 'Invoice No: ', bold: true },
              bill.invoiceNumber ?? '',
              { text: '\nDate: ', bold: true },
              (bill.finalizedAt ?? bill.createdAt).toLocaleString('en-IN'),
            ],
            fontSize: 9,
          },
          {
            text: [
              { text: 'Customer: ', bold: true },
              bill.customerName ?? 'Walk-in',
              { text: '\nPayment: ', bold: true },
              `${bill.paymentMode ?? '-'}${bill.paymentRef ? ` (${bill.paymentRef})` : ''}`,
            ],
            fontSize: 9,
            alignment: 'right',
          },
        ],
        margin: [0, 0, 0, 10],
      },
      {
        table: {
          headerRows: 1,
          widths: [14, '*', 46, 46, 46, 50, 44, 44, 52],
          body: [lineHeader, ...lineRows],
        },
        layout: 'lightHorizontalLines',
      },
      { text: 'Tax Summary', fontSize: 10, bold: true, margin: [0, 14, 0, 4] },
      {
        table: { headerRows: 1, widths: ['*', 90, 70, 70, 80], body: [slabHeader, ...slabRows] },
        layout: 'lightHorizontalLines',
      },
      { text: '', margin: [0, 10, 0, 0] },
      totalsRows,
      {
        text: 'Intra-state supply. CGST and SGST as shown above. Prices are inclusive of GST.',
        fontSize: 7,
        italics: true,
        margin: [0, 14, 0, 0],
      },
    ],
  };

  return doc;
}

export async function generateInvoicePdf(storeId: bigint, billId: string): Promise<InvoiceResult> {
  const bill = await getBill(storeId, billId);
  if (!bill) return { status: 'bill_not_found', billId };
  if (bill.status !== 'finalized' || !bill.invoiceNumber) {
    // A draft has no invoice number and no fixed totals; it is not a tax document yet.
    return { status: 'not_finalized', billId };
  }

  const [store] = await db.select().from(stores).where(eq(stores.id, storeId));
  const doc = buildInvoiceDoc(bill, store);

  // pdfmake 0.3 replaced the 0.2 `new PdfPrinter(fonts)` class with a module-level singleton.
  // Fonts are registered once, globally, rather than per printer instance.
  pdfmake.setFonts(FONTS);
  const bytes = await pdfmake.createPdf(doc).getBuffer();

  const artifact = await artifactPath(`invoice-${bill.invoiceNumber}.pdf`);
  await writeFile(artifact.path, bytes);

  return { status: 'generated', artifact, invoiceNumber: bill.invoiceNumber };
}
