import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import {
  addProduct,
  adjustStock,
  findStock,
  lowStockReport,
  receiveStock,
  type StockResult,
} from '../repositories/products.js';
import { formatQuantity, toBaseUnits, type Unit } from '../domain/units.js';
import { formatPaise } from '../domain/money.js';
import { requireContext } from './context.js';
import { toolResult } from './present.js';

/** Exported separately from the tool wrapper so it is testable without the SDK. */
export async function handleGetStock(query: string): Promise<StockResult> {
  const { storeId } = requireContext();
  return findStock(storeId, query);
}

/**
 * Shapes a repository result into what the model actually needs.
 *
 * Two reasons this is not just `JSON.stringify(result)`:
 *  - `storeId` is a JS BigInt and `JSON.stringify` throws on those outright.
 *  - Internal columns (ids, cost price, base-unit integers) are noise to the model at best
 *    and a leak at worst. Cost price in particular is the shop's margin, not the customer's
 *    business, and nothing in a stock lookup needs it.
 */
export function presentStockResult(result: StockResult): unknown {
  switch (result.status) {
    case 'found': {
      const p = result.product;
      return {
        status: 'found',
        product: {
          name: p.name,
          brand: p.brand,
          pack_size: p.packSize,
          in_stock: formatQuantity(p.quantityBase, p.unit as Unit),
          reorder_level: formatQuantity(p.reorderLevelBase, p.unit as Unit),
          below_reorder_level: p.quantityBase <= p.reorderLevelBase,
          price: formatPaise(p.mrpPaise),
          gst_rate: `${p.gstRateBps / 100}%`,
          hsn_code: p.hsnCode,
          sold_loose: p.isLoose,
        },
      };
    }
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
    case 'not_found':
      return {
        status: 'not_found',
        query: result.query,
        message: 'No such product in this shop. Do not invent one.',
      };
  }
}

export const getStockTool = tool(
  'get_stock',
  'Look up how much of a product is currently in stock. Accepts a partial product name such ' +
    'as "sugar", "maggi" or "aashirvaad". If the name matches more than one product the result ' +
    'lists the candidates, so you can ask the owner which one they mean. If nothing matches, ' +
    'say so — never guess at a product or a price.',
  // NOTE: no store_id parameter. Tenancy is injected server-side from the verified Telegram
  // chat and is not addressable by the model.
  { query: z.string().min(1).describe('Partial or full product name to look up.') },
  async ({ query }) => {
    const result = await handleGetStock(query);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(presentStockResult(result)) }],
    };
  },
);

export const receiveStockTool = tool(
  'receive_stock',
  'Book stock in when a delivery arrives, e.g. "50 packets of Maggi came in, cost ₹12, MRP ₹14". ' +
    'Prices are only updated when the owner states them.',
  {
    product_query: z.string().min(1),
    qty: z.number().positive(),
    unit: z.enum(['kg', 'g', 'litre', 'ml', 'packet', 'dozen', 'piece']),
    cost_price_paise: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Per selling unit, PAISE.'),
    mrp_paise: z.number().int().nonnegative().optional().describe('Per selling unit, PAISE.'),
  },
  async ({ product_query, qty, unit, cost_price_paise, mrp_paise }) => {
    const { storeId } = requireContext();
    const result = await receiveStock(storeId, {
      productQuery: product_query,
      qty,
      unit,
      costPricePaise: cost_price_paise,
      mrpPaise: mrp_paise,
    });
    if (result.status === 'ambiguous') {
      return toolResult({
        status: 'ambiguous',
        message: 'Several products match. Ask which one.',
        candidates: result.candidates.map((c) => ({ name: c.name, pack_size: c.packSize })),
      });
    }
    return toolResult(result);
  },
);

export const addProductTool = tool(
  'add_product',
  'Register a product the shop has never stocked, e.g. "new item: Amul Butter 100g, GST 12%, ' +
    'MRP ₹62". GST slabs: 0 for loose staples, 500 for packaged staples, 1200-1800 for FMCG.',
  {
    name: z.string().min(1),
    brand: z.string().optional(),
    pack_size: z.string().optional().describe('e.g. "5kg", "100g", "1L".'),
    unit: z.enum(['kg', 'g', 'litre', 'ml', 'packet', 'dozen', 'piece']),
    is_loose: z.boolean().optional(),
    hsn_code: z.string().min(4).describe('HSN code for the GST slab.'),
    gst_rate_bps: z.number().int().describe('Basis points: 0, 500, 1200 or 1800.'),
    cost_price_paise: z.number().int().nonnegative(),
    mrp_paise: z.number().int().positive(),
    opening_qty: z.number().nonnegative().optional(),
    reorder_level: z.number().nonnegative().optional(),
  },
  async (args) => {
    const { storeId } = requireContext();
    const unit = args.unit;
    const result = await addProduct(storeId, {
      name: args.name,
      brand: args.brand,
      packSize: args.pack_size,
      unit,
      isLoose: args.is_loose,
      hsnCode: args.hsn_code,
      gstRateBps: args.gst_rate_bps,
      costPricePaise: args.cost_price_paise,
      mrpPaise: args.mrp_paise,
      openingQtyBase: args.opening_qty ? toBaseUnits(args.opening_qty, unit) : undefined,
      reorderLevelBase: args.reorder_level ? toBaseUnits(args.reorder_level, unit) : undefined,
    });
    return toolResult(result);
  },
);

export const adjustStockTool = tool(
  'adjust_stock',
  'Correct a stock figure up or down with a reason, e.g. spoilage or a miscount. There is no ' +
    'delete: the correction is recorded as a movement so the trail survives it.',
  {
    product_query: z.string().min(1),
    delta: z.number().describe('Signed change in the given unit. Negative reduces stock.'),
    unit: z.enum(['kg', 'g', 'litre', 'ml', 'packet', 'dozen', 'piece']),
    reason: z.string().min(1),
  },
  async ({ product_query, delta, unit, reason }) => {
    const { storeId } = requireContext();
    const magnitude = toBaseUnits(Math.abs(delta), unit);
    const result = await adjustStock(storeId, {
      productQuery: product_query,
      deltaBase: delta < 0 ? -magnitude : magnitude,
      reason,
    });
    return toolResult(result);
  },
);

export const lowStockReportTool = tool(
  'low_stock_report',
  'List everything at or below its reorder level — answers "what\'s running out?".',
  {},
  async () => {
    const { storeId } = requireContext();
    const items = await lowStockReport(storeId);
    return toolResult({
      count: items.length,
      items: items.map((i) => ({
        name: i.name,
        in_stock: i.inStock,
        reorder_level: i.reorderLevel,
      })),
    });
  },
);

export const INVENTORY_TOOLS = [
  getStockTool,
  receiveStockTool,
  addProductTool,
  adjustStockTool,
  lowStockReportTool,
];

export const INVENTORY_TOOL_NAMES = [
  'get_stock',
  'receive_stock',
  'add_product',
  'adjust_stock',
  'low_stock_report',
] as const;
