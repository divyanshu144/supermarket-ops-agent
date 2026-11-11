import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { explainStockChange, frequentlyBoughtWith } from '../graph/reader.js';
import { requireContext } from './context.js';
import { toolResult } from './present.js';

export const graphQuerySchema = z
  .object({
    product_query: z.string().trim().min(1).max(120),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    limit: z.number().int().positive().max(20).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.from && input.to) {
      const from = Date.parse(`${input.from}T00:00:00.000Z`);
      const to = Date.parse(`${input.to}T23:59:59.999Z`);
      if (from > to) context.addIssue({ code: 'custom', message: 'from must be on or before to' });
      if (to - from > 90 * 86_400_000) {
        context.addIssue({ code: 'custom', message: 'date range cannot exceed 90 days' });
      }
    }
  });

function range(input: z.infer<typeof graphQuerySchema>) {
  const to = input.to ? new Date(`${input.to}T23:59:59.999Z`) : new Date();
  const from = input.from
    ? new Date(`${input.from}T00:00:00.000Z`)
    : new Date(to.getTime() - 30 * 86_400_000);
  return { from, to };
}

export function validateGraphQuery(
  input: unknown,
):
  | { status: 'valid'; input: z.infer<typeof graphQuerySchema>; range: { from: Date; to: Date } }
  | { status: 'invalid' } {
  const parsed = graphQuerySchema.safeParse(input);
  if (!parsed.success) return { status: 'invalid' };
  const dates = range(parsed.data);
  const span = dates.to.getTime() - dates.from.getTime();
  if (span < 0 || span > 90 * 86_400_000) return { status: 'invalid' };
  return { status: 'valid', input: parsed.data, range: dates };
}

function unavailable() {
  return toolResult({
    status: 'graph_unavailable',
    message:
      'The graph is temporarily unavailable. Stock, billing and credit records are still in Postgres.',
  });
}

export const explainStockChangeTool = tool(
  'explain_stock_change',
  'Trace stock changes for a product to their source bill or confirmed action and audit record. Read-only; use the stock tools for current quantity.',
  graphQuerySchema.shape,
  async (input) => {
    const validated = validateGraphQuery(input);
    if (validated.status === 'invalid') return toolResult({ status: 'invalid_input' });
    const { storeId } = requireContext();
    const result = await explainStockChange(storeId, {
      productQuery: validated.input.product_query,
      ...validated.range,
      limit: validated.input.limit,
    });
    return result.status === 'unavailable' ? unavailable() : toolResult(result);
  },
);

export const frequentlyBoughtWithTool = tool(
  'frequently_bought_with',
  'Find products often purchased on the same finalized bills as a given product. Read-only and limited to this store.',
  graphQuerySchema.shape,
  async (input) => {
    const validated = validateGraphQuery(input);
    if (validated.status === 'invalid') return toolResult({ status: 'invalid_input' });
    const { storeId } = requireContext();
    const result = await frequentlyBoughtWith(storeId, {
      productQuery: validated.input.product_query,
      ...validated.range,
      limit: validated.input.limit,
    });
    return result.status === 'unavailable' ? unavailable() : toolResult(result);
  },
);

export const GRAPH_TOOLS = [explainStockChangeTool, frequentlyBoughtWithTool];
export const GRAPH_TOOL_NAMES = ['explain_stock_change', 'frequently_bought_with'] as const;
