import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { preferences } from '../db/schema.js';
import { requireContext } from './context.js';
import { toolResult } from './present.js';

/**
 * Standing preferences live in Postgres, not in the conversation.
 *
 * That is the whole point: `/new` clears the chat, and the shop still knows the owner defaults
 * to UPI and means Aashirvaad when they say atta. Memory outside the context window.
 */
export async function readPreferences(storeId: bigint): Promise<Record<string, unknown>> {
  const rows = await db.select().from(preferences).where(eq(preferences.storeId, storeId));
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function writePreference(storeId: bigint, key: string, value: unknown): Promise<void> {
  await db
    .insert(preferences)
    .values({ storeId, key, value })
    .onConflictDoUpdate({
      target: [preferences.storeId, preferences.key],
      set: { value, updatedAt: new Date() },
    });
}

export async function deletePreference(storeId: bigint, key: string): Promise<void> {
  await db
    .delete(preferences)
    .where(and(eq(preferences.storeId, storeId), eq(preferences.key, key)));
}

export const getPreferencesTool = tool(
  'get_preferences',
  "Read the owner's standing preferences. These are already injected into your instructions " +
    'each turn, so you rarely need this — use it to confirm what is currently set.',
  {},
  async () => {
    const { storeId } = requireContext();
    return toolResult({ preferences: await readPreferences(storeId) });
  },
);

export const setPreferenceTool = tool(
  'set_preference',
  'Remember a standing preference, e.g. "always assume UPI unless I say cash" or "default ' +
    'atta = Aashirvaad 5kg". These survive /new and every future chat.',
  {
    key: z
      .string()
      .min(1)
      .describe('Short stable key, e.g. default_payment_mode, preferred_atta, shop_name.'),
    value: z.string().min(1).describe('The value to remember.'),
  },
  async ({ key, value }) => {
    const { storeId } = requireContext();
    await writePreference(storeId, key, value);
    return toolResult({
      status: 'remembered',
      key,
      value,
      message: 'Saved. This will still apply after /new.',
    });
  },
);

export const PREFERENCE_TOOLS = [getPreferencesTool, setPreferenceTool];
export const PREFERENCE_TOOL_NAMES = ['get_preferences', 'set_preference'] as const;
