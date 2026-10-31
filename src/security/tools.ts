import { validateMoneyArguments } from './arguments.js';
import { requireContext } from '../tools/context.js';
import { z } from 'zod';
import { proposeConfirmation } from '../tools/confirmation.js';
import { toolResult } from '../tools/present.js';
import { wrapToolData } from './boundaries.js';

export const CONFIRM_TOOLS = new Set([
  'add_product',
  'receive_stock',
  'adjust_stock',
  'add_bill_item',
  'update_bill_item',
  'remove_bill_item',
  'finalize_bill',
  'charge_khata',
  'settle_khata',
  'set_preference',
]);
interface Definition {
  name: string;
  inputSchema: Record<string, z.ZodType>;
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
}
export function secureTools<T>(tools: readonly T[]): T[] {
  return tools.map((raw) => {
    const definition = raw as Definition;
    return {
      ...definition,
      handler: async (input: unknown, extra: unknown) => {
        const args = z.object(definition.inputSchema).strict().parse(input);
        if (JSON.stringify(args).length > 2800)
          return toolResult({ status: 'refused', refusal_code: 'arguments_too_long' });
        const refusal = await validateMoneyArguments(
          requireContext().storeId,
          definition.name,
          args,
        );
        if (refusal) return toolResult({ status: 'refused', refusal_code: refusal });
        let result: unknown;
        if (CONFIRM_TOOLS.has(definition.name)) {
          result = toolResult(
            await proposeConfirmation({
              tool: ['finalize_bill', 'settle_khata'].includes(definition.name)
                ? definition.name
                : `guard:${definition.name}`,
              action: `${definition.name}: ${JSON.stringify(args)}`,
              arguments: args,
              ...(typeof args.bill_id === 'string' ? { billId: args.bill_id } : {}),
            }),
          );
        } else result = await definition.handler(args, extra);
        const response = result as { content: Array<{ type: string; text?: string }> };
        return {
          ...response,
          content: response.content.map((block) =>
            block.type === 'text' && block.text
              ? { ...block, text: wrapToolData(block.text) }
              : block,
          ),
        };
      },
    } as T;
  });
}
