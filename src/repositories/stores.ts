import { db } from '../db/client.js';
import { stores } from '../db/schema.js';

const DEFAULT_NAME = 'Sharma Kirana Store';
const DEFAULT_GSTIN = '27AAAAA0000A1Z5';

/**
 * Provisions the store for a Telegram chat, idempotently.
 *
 * One store per chat: reviewers driving the same demo script concurrently must not share
 * stock, or one reviewer's stock-in silently defeats another's oversell-guard scenario.
 * The chat id IS the store id, which is what lets the adapter inject tenancy without ever
 * exposing it as a tool parameter.
 */
export async function provisionStore(chatId: bigint): Promise<{ id: bigint; created: boolean }> {
  const inserted = await db
    .insert(stores)
    .values({ id: chatId, name: DEFAULT_NAME, gstin: DEFAULT_GSTIN })
    .onConflictDoNothing()
    .returning({ id: stores.id });

  return { id: chatId, created: inserted.length > 0 };
}
