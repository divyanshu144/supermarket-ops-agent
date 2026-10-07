import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { preferences, products } from '../db/schema.js';
import { PREFERENCE_KEYS, parsePreference } from '../domain/preferences.js';
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
  const brands = await db
    .selectDistinct({ brand: products.brand })
    .from(products)
    .where(and(eq(products.storeId, storeId), isNotNull(products.brand)));
  const brandSet = new Set(brands.flatMap(({ brand }) => (brand ? [brand] : [])));
  const valid: Record<string, unknown> = {};
  let invalidCount = 0;
  for (const row of rows) {
    const parsed = parsePreference(row.key, row.value);
    if (!parsed || (parsed.key === 'preferred_brand' && !brandSet.has(parsed.value))) {
      invalidCount++;
      continue;
    }
    valid[parsed.key] = parsed.value;
  }
  if (invalidCount > 0) {
    console.warn(
      JSON.stringify({
        scope: 'preferences',
        event: 'ignored_invalid_legacy_values',
        count: invalidCount,
      }),
    );
  }
  return valid;
}

export async function writePreference(
  storeId: bigint,
  key: string,
  value: unknown,
): Promise<{ status: 'saved' | 'invalid' }> {
  const parsed = parsePreference(key, value);
  if (!parsed) return { status: 'invalid' };
  if (parsed.key === 'preferred_brand') {
    const [catalogueBrand] = await db
      .select({ brand: products.brand })
      .from(products)
      .where(and(eq(products.storeId, storeId), eq(products.brand, parsed.value)))
      .limit(1);
    if (!catalogueBrand) return { status: 'invalid' };
  }
  await db
    .insert(preferences)
    .values({ storeId, key: parsed.key, value: parsed.value })
    .onConflictDoUpdate({
      target: [preferences.storeId, preferences.key],
      set: { value: parsed.value, updatedAt: new Date() },
    });
  return { status: 'saved' };
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
    key: z.enum(PREFERENCE_KEYS).describe('A supported preference key.'),
    value: z.string().min(1).max(80).describe('A value matching the selected preference format.'),
  },
  async ({ key, value }) => {
    const { storeId } = requireContext();
    const result = await writePreference(storeId, key, value);
    if (result.status === 'invalid') {
      return toolResult({
        status: 'invalid_preference',
        message: 'That value does not match a supported preference or this store catalogue.',
      });
    }
    return toolResult({
      status: 'remembered',
      key,
      message: 'Saved. This will still apply after /new.',
    });
  },
);

export const PREFERENCE_TOOLS = [getPreferencesTool, setPreferenceTool];
export const PREFERENCE_TOOL_NAMES = ['get_preferences', 'set_preference'] as const;
