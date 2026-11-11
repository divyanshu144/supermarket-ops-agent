import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { graphOutbox } from '../db/schema.js';
import { currentGraphActionId } from '../graph/action-context.js';
import type { GraphEvent } from '../graph/mapping.js';

export interface GraphOutboxExecutor {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}

/** Append an immutable event using the caller's Postgres transaction. */
export async function appendGraphEvent(tx: GraphOutboxExecutor, event: GraphEvent): Promise<void> {
  const actionId = currentGraphActionId();
  const payload =
    actionId && (event.type === 'stock_movement' || event.type === 'khata_entry')
      ? { ...event, pendingActionId: actionId }
      : event;
  await tx.execute(sql`
    INSERT INTO graph_outbox (store_id, event_type, entity_id, payload)
    VALUES (${payload.storeId}::bigint, ${payload.type}, ${payload.id}, ${JSON.stringify(payload)}::jsonb)
  `);
}

export type ClaimedGraphEvent = typeof graphOutbox.$inferSelect & { claimToken: string };
export type GraphErrorCode = 'unavailable' | 'authentication' | 'timeout' | 'query' | 'unknown';

export async function claimGraphEvents(
  limit = 25,
  now = new Date(),
  leaseMs = 120_000,
): Promise<ClaimedGraphEvent[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(graphOutbox)
      .where(
        and(
          isNull(graphOutbox.processedAt),
          lte(graphOutbox.nextAttemptAt, now),
          or(isNull(graphOutbox.lockedUntil), lte(graphOutbox.lockedUntil, now)),
        ),
      )
      .orderBy(asc(graphOutbox.createdAt), asc(graphOutbox.id))
      .limit(safeLimit)
      .for('update', { skipLocked: true });

    const claimed: ClaimedGraphEvent[] = [];
    for (const row of rows) {
      const claimToken = randomUUID();
      const [updated] = await tx
        .update(graphOutbox)
        .set({
          lockedUntil: new Date(now.getTime() + leaseMs),
          claimToken,
          attempts: sql`${graphOutbox.attempts} + 1`,
        })
        .where(eq(graphOutbox.id, row.id))
        .returning();
      if (updated) claimed.push({ ...updated, claimToken });
    }
    return claimed;
  });
}

export async function acknowledgeGraphEvent(id: string, claimToken: string): Promise<boolean> {
  const [row] = await db
    .update(graphOutbox)
    .set({ processedAt: new Date(), lockedUntil: null, claimToken: null, lastErrorCode: null })
    .where(
      and(
        eq(graphOutbox.id, id),
        eq(graphOutbox.claimToken, claimToken),
        isNull(graphOutbox.processedAt),
      ),
    )
    .returning({ id: graphOutbox.id });
  return Boolean(row);
}

export async function failGraphEvent(
  id: string,
  claimToken: string,
  errorCode: GraphErrorCode,
  now = new Date(),
): Promise<boolean> {
  const [row] = await db
    .update(graphOutbox)
    .set({
      lockedUntil: null,
      claimToken: null,
      lastErrorCode: errorCode,
      nextAttemptAt: sql`${now}::timestamptz + (LEAST(60000, 1000 * power(2, LEAST(${graphOutbox.attempts}, 6))) * interval '1 millisecond')`,
    })
    .where(
      and(
        eq(graphOutbox.id, id),
        eq(graphOutbox.claimToken, claimToken),
        isNull(graphOutbox.processedAt),
      ),
    )
    .returning({ id: graphOutbox.id });
  return Boolean(row);
}

export async function graphOutboxLag(): Promise<{
  pendingCount: number;
  oldestPendingAt: Date | null;
}> {
  const [row] = await db
    .select({
      pendingCount: sql<number>`count(*)::int`,
      oldestPendingAt: sql<Date | null>`min(${graphOutbox.createdAt})`,
    })
    .from(graphOutbox)
    .where(isNull(graphOutbox.processedAt));
  return { pendingCount: row?.pendingCount ?? 0, oldestPendingAt: row?.oldestPendingAt ?? null };
}
