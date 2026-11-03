import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { usage } from '../db/schema.js';

// A shop's day is an Indian day. UTC would roll the budget over at 05:30 in the morning.
const TODAY_IST = sql`(now() at time zone 'Asia/Kolkata')::date`;

/** Adds one turn's estimated model cost to the store's row for today (IST). */
export interface UsageTurnMetrics {
  toolCalls?: number;
  toolErrors?: number;
  cacheLookups?: number;
  cacheHits?: number;
}

export async function recordUsage(
  storeId: bigint,
  costMicroUsd: number,
  metrics: UsageTurnMetrics = {},
): Promise<void> {
  await db
    .insert(usage)
    .values({
      storeId,
      day: TODAY_IST,
      costMicroUsd,
      turns: 1,
      toolCalls: metrics.toolCalls ?? 0,
      toolErrors: metrics.toolErrors ?? 0,
      cacheLookups: metrics.cacheLookups ?? 0,
      cacheHits: metrics.cacheHits ?? 0,
    })
    .onConflictDoUpdate({
      target: [usage.storeId, usage.day],
      set: {
        costMicroUsd: sql`${usage.costMicroUsd} + ${costMicroUsd}`,
        turns: sql`${usage.turns} + 1`,
        toolCalls: sql`${usage.toolCalls} + ${metrics.toolCalls ?? 0}`,
        toolErrors: sql`${usage.toolErrors} + ${metrics.toolErrors ?? 0}`,
        cacheLookups: sql`${usage.cacheLookups} + ${metrics.cacheLookups ?? 0}`,
        cacheHits: sql`${usage.cacheHits} + ${metrics.cacheHits ?? 0}`,
      },
    });
}

/** Records preprocessing spend (e.g. Whisper) before the agent turn, without counting a turn. */
export async function recordCostOnly(storeId: bigint, costMicroUsd: number): Promise<void> {
  await db
    .insert(usage)
    .values({ storeId, day: TODAY_IST, costMicroUsd, turns: 0 })
    .onConflictDoUpdate({
      target: [usage.storeId, usage.day],
      set: { costMicroUsd: sql`${usage.costMicroUsd} + ${costMicroUsd}` },
    });
}

export async function spentTodayMicroUsd(storeId: bigint): Promise<number> {
  const rows = await db
    .select({ cost: usage.costMicroUsd })
    .from(usage)
    .where(and(eq(usage.storeId, storeId), sql`${usage.day} = ${TODAY_IST}`))
    .limit(1);
  return rows[0]?.cost ?? 0;
}
