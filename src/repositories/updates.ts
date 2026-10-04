import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { processedUpdates, sessions } from '../db/schema.js';
import { deleteSessionEntries } from './session-entries.js';

/** A turn still 'claimed' after this long is assumed to have died mid-handling. */
const STALE_AFTER_SECONDS = 300;

export type ClaimResult = 'claimed' | 'duplicate' | 'reclaimed';

/**
 * Claim a Telegram update for processing.
 *
 * This is deliberately a CLAIM, not a completion marker, and the distinction is load-bearing.
 * Under long-polling Telegram only redelivers when the offset did not advance — which is
 * exactly when the previous attempt crashed mid-turn. An insert-on-receipt dedupe would reject
 * precisely the redelivery that must be reprocessed, and the owner's message would vanish with
 * no error anywhere.
 *
 *   no row                → 'claimed'   process it
 *   row done              → 'duplicate' genuine redelivery, skip
 *   row claimed, stale    → 'reclaimed' previous attempt died, reprocess
 *   row claimed, fresh    → 'duplicate' still in flight elsewhere, skip
 */
export async function claimUpdate(updateId: bigint, chatId: bigint): Promise<ClaimResult> {
  const inserted = await db
    .insert(processedUpdates)
    .values({ updateId, chatId, status: 'claimed' })
    .onConflictDoNothing()
    .returning({ updateId: processedUpdates.updateId });

  if (inserted.length > 0) return 'claimed';

  const reclaimed = await db
    .update(processedUpdates)
    .set({ claimedAt: sql`now()` })
    .where(
      and(
        eq(processedUpdates.updateId, updateId),
        eq(processedUpdates.status, 'claimed'),
        lt(processedUpdates.claimedAt, sql`now() - make_interval(secs => ${STALE_AFTER_SECONDS})`),
      ),
    )
    .returning({ updateId: processedUpdates.updateId });

  return reclaimed.length > 0 ? 'reclaimed' : 'duplicate';
}

export async function completeUpdate(updateId: bigint): Promise<void> {
  await db
    .update(processedUpdates)
    .set({ status: 'done', completedAt: sql`now()` })
    .where(eq(processedUpdates.updateId, updateId));
}

/**
 * Boot-time recovery for a process that died mid-turn.
 *
 * A claim younger than STALE_AFTER_SECONDS is treated as "still running elsewhere", which is
 * right while the owner's process is alive and wrong after a restart: Telegram redelivers the
 * update immediately, finds a fresh claim and drops it, so the owner's message is lost. With one
 * replica (DEPLOY.md) every claim present at boot belongs to a dead process, so expire them all.
 * Completed updates are untouched: a redelivery of finished work must stay a duplicate.
 * Do not call this with more than one replica running.
 */
export async function expireInFlightClaims(): Promise<number> {
  const rows = await db
    .update(processedUpdates)
    .set({ claimedAt: sql`now() - make_interval(secs => ${STALE_AFTER_SECONDS + 1})` })
    .where(eq(processedUpdates.status, 'claimed'))
    .returning({ updateId: processedUpdates.updateId });
  return rows.length;
}

export async function getSessionId(storeId: bigint): Promise<string | undefined> {
  const rows = await db.select().from(sessions).where(eq(sessions.storeId, storeId)).limit(1);
  return rows[0]?.agentSessionId;
}

export async function getSessionCostMicroUsd(storeId: bigint): Promise<number> {
  const rows = await db
    .select({ cost: sessions.costMicroUsd })
    .from(sessions)
    .where(eq(sessions.storeId, storeId))
    .limit(1);
  return rows[0]?.cost ?? 0;
}

export async function setSessionId(
  storeId: bigint,
  agentSessionId: string,
  costMicroUsd = 0,
): Promise<void> {
  await db
    .insert(sessions)
    .values({ storeId, agentSessionId, costMicroUsd })
    .onConflictDoUpdate({
      target: sessions.storeId,
      set: { agentSessionId, costMicroUsd, updatedAt: sql`now()` },
    });
}

/**
 * Backs `/new` and `/reset`: clears the conversation and nothing else. Stock, khata and
 * preferences stay. The mirrored transcript goes too, or every cleared conversation would
 * accumulate in session_entries forever.
 */
export async function clearSession(storeId: bigint): Promise<void> {
  const sessionId = await getSessionId(storeId);
  if (sessionId) await deleteSessionEntries(sessionId);
  await db.delete(sessions).where(eq(sessions.storeId, storeId));
}
