import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import {
  addBillItem,
  finalizeBill,
  findBills,
  getBill,
  openBill,
  removeBillItem,
  updateBillItem,
  voidBill,
  type AddItemResult,
  type FinalizeResult,
  type RemoveItemResult,
  type UpdateItemResult,
} from '../repositories/bills.js';
import { requireContext } from './context.js';
import { presentBill, presentBillSummary, toolResult } from './present.js';

const UNITS = ['kg', 'g', 'litre', 'ml', 'packet', 'dozen', 'piece'] as const;

/** Line-edit results share a shape, so they share a presenter. */
function presentEdit(result: AddItemResult | UpdateItemResult | RemoveItemResult): unknown {
  switch (result.status) {
    case 'added':
    case 'updated':
    case 'removed':
      return { status: result.status, bill: presentBill(result.bill) };
    case 'ambiguous':
      return {
        status: 'ambiguous',
        message: 'Several products match. Ask the owner which one they mean.',
        candidates: result.candidates.map((c) => ({
          name: c.name,
          brand: c.brand,
          pack_size: c.packSize,
        })),
      };
    default:
      return result;
  }
}

function presentFinalize(result: FinalizeResult): unknown {
  switch (result.status) {
    case 'finalized':
    case 'already_finalized':
      return {
        status: result.status,
        bill_id: result.billId,
        invoice_number: result.invoiceNumber,
        totals: {
          subtotal: result.totals.subtotalPaise,
          total: result.totals.totalPaise,
        },
        message:
          result.status === 'already_finalized'
            ? 'This bill was already finalized. Same invoice, stock untouched.'
            : 'Bill finalized and stock updated.',
      };
    case 'insufficient_stock':
      return {
        status: 'insufficient_stock',
        message: 'Not enough stock. Nothing was billed and no stock moved. Tell the owner.',
        shortfalls: result.shortfalls,
      };
    case 'below_cost':
      return {
        status: 'below_cost',
        message:
          'One or more lines are priced below cost. Confirm with the owner, then retry with allow_below_cost.',
        lines: result.lines,
      };
    case 'above_mrp':
      return {
        status: 'above_mrp',
        message:
          'One or more lines are priced above MRP. This cannot be overridden — MRP is the legal maximum. Correct the price.',
        lines: result.lines,
      };
    default:
      return result;
  }
}

export const openBillTool = tool(
  'open_bill',
  'Start a new draft bill. Returns a bill_id to add items to. Stock is NOT touched until the ' +
    'bill is finalized, so a bill can be built up and edited over several messages.',
  { customer_name: z.string().optional().describe('Customer name, if the owner named one.') },
  async ({ customer_name }) => {
    const { storeId } = requireContext();
    const result = await openBill(storeId, { customerName: customer_name });
    return toolResult({ status: 'opened', bill_id: result.billId });
  },
);

export const addBillItemTool = tool(
  'add_bill_item',
  'Add a line to a draft bill. Accepts a partial product name. Does NOT move stock — that ' +
    'happens only at finalize. If the name matches several products the result lists them so ' +
    'you can ask which one the owner means.',
  {
    bill_id: z.string().describe('The draft bill to add to.'),
    product_query: z.string().min(1).describe('Partial or full product name.'),
    qty: z.number().positive().describe('Quantity in the given unit.'),
    unit: z.enum(UNITS).describe('Unit the owner spoke, e.g. kg for loose goods.'),
    unit_price_override: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Price per selling unit in PAISE. Only when the owner names a different price.'),
  },
  async ({ bill_id, product_query, qty, unit, unit_price_override }) => {
    const { storeId } = requireContext();
    const result = await addBillItem(storeId, {
      billId: bill_id,
      productQuery: product_query,
      qty,
      unit,
      unitPriceOverridePaise: unit_price_override,
    });
    return toolResult(presentEdit(result));
  },
);

export const updateBillItemTool = tool(
  'update_bill_item',
  'Change the quantity of a line already on a draft bill, e.g. "make it 6 Maggi".',
  {
    bill_id: z.string(),
    product_query: z.string().min(1),
    qty: z.number().positive(),
    unit: z.enum(UNITS),
  },
  async ({ bill_id, product_query, qty, unit }) => {
    const { storeId } = requireContext();
    const result = await updateBillItem(storeId, {
      billId: bill_id,
      productQuery: product_query,
      qty,
      unit,
    });
    return toolResult(presentEdit(result));
  },
);

export const removeBillItemTool = tool(
  'remove_bill_item',
  'Take a product off a draft bill entirely, e.g. "drop the butter".',
  { bill_id: z.string(), product_query: z.string().min(1) },
  async ({ bill_id, product_query }) => {
    const { storeId } = requireContext();
    const result = await removeBillItem(storeId, { billId: bill_id, productQuery: product_query });
    return toolResult(presentEdit(result));
  },
);

export const getBillTool = tool(
  'get_bill',
  'Read a bill back: its lines, GST breakup and running total.',
  { bill_id: z.string() },
  async ({ bill_id }) => {
    const { storeId } = requireContext();
    const bill = await getBill(storeId, bill_id);
    return toolResult(bill ? presentBill(bill) : { status: 'bill_not_found', bill_id });
  },
);

export const findBillsTool = tool(
  'find_bills',
  'Find recent bills, newest first. Use this when the owner refers to a bill you do not have ' +
    'an id for — "that bill", "Ramesh\'s bill from yesterday" — before generating a PDF.',
  {
    customer: z.string().optional().describe('Filter by customer name.'),
    days_back: z.number().int().positive().optional().describe('Only bills from the last N days.'),
    limit: z.number().int().positive().max(20).optional(),
    include_stale_drafts: z
      .boolean()
      .optional()
      .describe('Include drafts older than a day. Off by default — they are usually abandoned.'),
  },
  async ({ customer, days_back, limit, include_stale_drafts }) => {
    const { storeId } = requireContext();
    const since = days_back ? new Date(Date.now() - days_back * 86_400_000) : undefined;
    const bills = await findBills(storeId, {
      customer,
      since,
      limit,
      includeStaleDrafts: include_stale_drafts,
    });
    return toolResult({ count: bills.length, bills: bills.map(presentBillSummary) });
  },
);

export const finalizeBillTool = tool(
  'finalize_bill',
  'Close a bill and take the stock. This is the only point at which stock moves. Refuses if ' +
    'stock is short, if a line is below cost (overridable) or above MRP (never overridable). ' +
    'Use payment_mode "khata" to put the bill on a customer\'s credit — the ledger entry is ' +
    'written in the same transaction, so it cannot half-happen.',
  {
    bill_id: z.string(),
    payment_mode: z.enum(['cash', 'upi', 'card', 'khata']),
    payment_ref: z.string().optional().describe('UPI reference or card last-4, if given.'),
    customer_name: z.string().optional().describe('Required when payment_mode is khata.'),
    allow_below_cost: z
      .boolean()
      .optional()
      .describe('Only after the owner has explicitly confirmed a below-cost sale.'),
  },
  async ({ bill_id, payment_mode, payment_ref, customer_name, allow_below_cost }) => {
    const { storeId } = requireContext();
    const result = await finalizeBill(storeId, {
      billId: bill_id,
      paymentMode: payment_mode,
      paymentRef: payment_ref,
      customerName: customer_name,
      allowBelowCost: allow_below_cost,
    });
    return toolResult(presentFinalize(result));
  },
);

export const voidBillTool = tool(
  'void_bill',
  'Reverse a finalized bill: stock goes back and any khata charge is reversed. Nothing is ' +
    'deleted — the reversal is recorded. Confirm with the owner before using this.',
  { bill_id: z.string() },
  async ({ bill_id }) => {
    const { storeId } = requireContext();
    const result = await voidBill(storeId, bill_id);
    return toolResult(result);
  },
);

export const BILLING_TOOLS = [
  openBillTool,
  addBillItemTool,
  updateBillItemTool,
  removeBillItemTool,
  getBillTool,
  findBillsTool,
  finalizeBillTool,
  voidBillTool,
];

export const BILLING_TOOL_NAMES = [
  'open_bill',
  'add_bill_item',
  'update_bill_item',
  'remove_bill_item',
  'get_bill',
  'find_bills',
  'finalize_bill',
  'void_bill',
] as const;
