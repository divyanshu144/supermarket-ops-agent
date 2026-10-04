import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { stores, usage } from '../db/schema.js';
import { recordUsage, spentTodayMicroUsd } from './usage.js';

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

  it('keeps stores separate', async () => {
    await recordUsage(A, 500_000);
    expect(await spentTodayMicroUsd(B)).toBe(0);
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
