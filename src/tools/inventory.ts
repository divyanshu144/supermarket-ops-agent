import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { findStock, type StockResult } from '../repositories/products.js';
import { formatQuantity, type Unit } from '../domain/units.js';
import { formatPaise } from '../domain/money.js';
import { requireContext } from './context.js';

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
