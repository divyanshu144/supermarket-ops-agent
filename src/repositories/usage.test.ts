import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { idempotencyKeys, processedUpdates, stores, usage } from '../db/schema.js';
import { recordCostOnly, recordUsage, spentTodayMicroUsd } from './usage.js';
import { recordTurnCost } from '../observability/turn-accounting.js';
import { readUsageReport } from './usage-report.js';

const A = 999100010n;
const B = 999100011n;

beforeEach(async () => {
  await db.delete(stores).where(inArray(stores.id, [A, B]));
  for (const id of [A, B]) {
    await db.insert(stores).values({ id, name: 'S', gstin: '27AAAAA0000A1Z5' });
  }
});

afterAll(async () => {
  await db.delete(stores).where(inArray(stores.id, [A, B]));
  await pool.end();
});

describe('usage', () => {
  it('is zero for a store that has spent nothing', async () => {
    expect(await spentTodayMicroUsd(A)).toBe(0);
  });

  it('accumulates cost within the day', async () => {
    await recordUsage(A, 120_000);
    await recordUsage(A, 30_000);
    expect(await spentTodayMicroUsd(A)).toBe(150_000);
    const [row] = await db.select().from(usage).where(eq(usage.storeId, A));
    expect(row!.turns).toBe(2);
  });

  it('accumulates operational counters beside the same per-turn cost', async () => {
    await recordUsage(A, 120_000, { toolCalls: 2, toolErrors: 1, cacheLookups: 1, cacheHits: 0 });
    await recordUsage(A, 80_000, { toolCalls: 1, toolErrors: 0, cacheLookups: 1, cacheHits: 1 });
    const [row] = await db.select().from(usage).where(eq(usage.storeId, A));
    expect(row).toMatchObject({
      costMicroUsd: 200_000,
      turns: 2,
      toolCalls: 3,
      toolErrors: 1,
      cacheLookups: 2,
      cacheHits: 1,
    });
  });

  it('keeps the traced per-turn cost equal to the aggregate usage increment, including prepaid voice cost', async () => {
    const before = await spentTodayMicroUsd(A);
    await recordCostOnly(A, 500);
    let traced = 0;
    await recordTurnCost(A, 0.25, {}, (cost) => (traced = cost), undefined, 500);
    expect(traced).toBe(250_500);
    expect((await spentTodayMicroUsd(A)) - before).toBe(traced);
  });

  it('reports requests, thrown tool errors, cache hits, replays and cost without exposing store IDs', async () => {
    await db.insert(processedUpdates).values({ updateId: 123456789n, chatId: A });
    await db.insert(idempotencyKeys).values({
      storeId: A,
      key: 'report-test-key',
      operation: 'open_bill',
      result: {},
      replayCount: 2,
    });
    await recordUsage(A, 100_000, {
      toolCalls: 4,
      toolErrors: 1,
      cacheLookups: 2,
      cacheHits: 1,
    });

    const report = await readUsageReport(pool);
    const today = report.days[0]!;
    expect(report.observedStoreCount).toBe(2);
    expect(today).toMatchObject({
      requests: 1,
      toolErrorRate: 0.25,
      idempotentReplays: 2,
      cacheHitRate: 0.5,
      costPerModelTurnUsd: 0.1,
    });
    expect(JSON.stringify(report)).not.toContain(String(A));
  });

  it('keeps stores separate', async () => {
    await recordUsage(A, 500_000);
    expect(await spentTodayMicroUsd(B)).toBe(0);
  });

  it('stamps the row with the IST date, not the database session date', async () => {
    await recordUsage(A, 1);
    // Compared inside Postgres with the same IST expression the code uses. A `current_date`
    // implementation would only disagree when the session timezone's date differs from IST's
    // (e.g. UTC between 18:30 and 24:00), so this pins the contract rather than the clock. (Verified by mutation with
    // PGOPTIONS='-c timezone=Pacific/Kiritimati', where `current_date` fails it.)
    const { rows } = await pool.query(
      `select (day = (now() at time zone 'Asia/Kolkata')::date) as ok from usage where store_id = $1`,
      [A.toString()],
    );
    expect(rows).toEqual([{ ok: true }]);
  });

  it("ignores a previous day's spend", async () => {
    await db.insert(usage).values({
      storeId: A,
      day: sql`(now() at time zone 'Asia/Kolkata')::date - 1`,
      costMicroUsd: 9_000_000,
    });
    expect(await spentTodayMicroUsd(A)).toBe(0);
  });
});
