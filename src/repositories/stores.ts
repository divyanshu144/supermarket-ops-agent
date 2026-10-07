import { db } from '../db/client.js';
import { stores } from '../db/schema.js';
import { seedStore } from '../seed/index.js';

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
export async function provisionStore(
  chatId: bigint,
  ownerUserId?: bigint,
): Promise<{ id: bigint; created: boolean }> {
  const inserted = await db
    .insert(stores)
    .values({
      id: chatId,
      ownerUserId: ownerUserId ?? null,
      name: DEFAULT_NAME,
      gstin: DEFAULT_GSTIN,
    })
    .onConflictDoNothing()
    .returning({ id: stores.id });

  if (inserted.length === 0) return { id: chatId, created: false };

  // Seed only on creation. A fresh store with no sales history would produce an empty
  // analysis deck, and the deck is one of the two headline artifacts.
  await seedStore(chatId);
  return { id: chatId, created: true };
}
