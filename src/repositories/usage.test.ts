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
