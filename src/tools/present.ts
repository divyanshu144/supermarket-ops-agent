import type { BillSummary, BillTotals, BillView } from '../repositories/bills.js';
import { formatPaise } from '../domain/money.js';

/**
 * Shared shaping helpers for tool output.
 *
 * Two rules, both learned the hard way. `JSON.stringify` throws outright on a BigInt, and
 * `storeId` is one — returning a raw row broke every `get_stock` call in production while the
 * unit tests stayed green. And cost price is the shop's margin: it belongs in the below-cost
 * guard, not in anything the model can repeat back to a customer.
 */

export function presentTotals(totals: BillTotals): Record<string, string> {
  return {
    subtotal: formatPaise(totals.subtotalPaise),
    cgst: formatPaise(totals.cgstPaise),
    sgst: formatPaise(totals.sgstPaise),
    round_off: formatPaise(totals.roundOffPaise),
    total: formatPaise(totals.totalPaise),
  };
}

export function presentBill(bill: BillView): Record<string, unknown> {
  return {
    bill_id: bill.id,
    status: bill.status,
    customer: bill.customerName,
    payment_mode: bill.paymentMode,
    payment_ref: bill.paymentRef,
    invoice_number: bill.invoiceNumber,
    lines: bill.items.map((item) => ({
      line_no: item.lineNo,
      name: item.name,
      quantity: item.quantity,
      unit_price: formatPaise(item.unitPricePaise),
      hsn_code: item.hsnCode,
      gst_rate: `${item.gstRateBps / 100}%`,
      line_total: formatPaise(item.lineTotalPaise),
    })),
    totals: presentTotals(bill.totals),
  };
}

export function presentBillSummary(bill: BillSummary): Record<string, unknown> {
  return {
    bill_id: bill.id,
    status: bill.status,
    invoice_number: bill.invoiceNumber,
    customer: bill.customerName,
    payment_mode: bill.paymentMode,
    total: bill.totalPaise === null ? null : formatPaise(bill.totalPaise),
    item_count: bill.itemCount,
    created_at: bill.createdAt.toISOString(),
  };
}

/** Wraps any JSON-serialisable value in the content shape the SDK expects from a tool. */
export function toolResult(value: unknown): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}
