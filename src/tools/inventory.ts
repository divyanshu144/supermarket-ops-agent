import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { findStock, type StockResult } from '../repositories/products.js';
import { requireContext } from './context.js';

/** Exported separately from the tool wrapper so it is testable without the SDK. */
export async function handleGetStock(query: string): Promise<StockResult> {
  const { storeId } = requireContext();
  return findStock(storeId, query);
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
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
);
