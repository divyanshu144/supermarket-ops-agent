import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { processedUpdates, sessions, stores } from '../db/schema.js';
import {
  claimUpdate,
  clearSession,
  completeUpdate,
  getSessionCostMicroUsd,
  getSessionId,
  setSessionId,
} from './updates.js';

const UPD = 88800001n;
const CHAT = 999000007n;

beforeEach(async () => {
  await db.delete(processedUpdates).where(eq(processedUpdates.updateId, UPD));
  await db.delete(stores).where(eq(stores.id, CHAT));
  await db.insert(stores).values({ id: CHAT, name: 'S', gstin: '27AAAAA0000A1Z5' });
});

afterAll(async () => {
  await db.delete(processedUpdates).where(eq(processedUpdates.updateId, UPD));
  await db.delete(stores).where(eq(stores.id, CHAT));
  await pool.end();
});

async function ageTheClaim(seconds: number): Promise<void> {
  await db
    .update(processedUpdates)
    .set({ claimedAt: sql`now() - make_interval(secs => ${seconds})` })
    .where(eq(processedUpdates.updateId, UPD));
}

describe('claimUpdate', () => {
  it('claims an unseen update', async () => {
    expect(await claimUpdate(UPD, CHAT)).toBe('claimed');
  });

  it('rejects a redelivery of a completed update', async () => {
    await claimUpdate(UPD, CHAT);
    await completeUpdate(UPD);
    expect(await claimUpdate(UPD, CHAT)).toBe('duplicate');
  });

  it('RECLAIMS a stale claim so a crashed turn is reprocessed', async () => {
    // The regression test for the lost-message bug. A naive insert-on-receipt dedupe returns
    // 'duplicate' here, and the owner's message is silently dropped — which under long-polling
    // is the ONLY case where a redelivery actually happens.
    await claimUpdate(UPD, CHAT);
    await ageTheClaim(600);

    expect(await claimUpdate(UPD, CHAT)).toBe('reclaimed');
  });

  it('does not reclaim a fresh in-flight claim', async () => {
    await claimUpdate(UPD, CHAT);
    expect(await claimUpdate(UPD, CHAT)).toBe('duplicate');
  });

  it('never reclaims a completed update, however old', async () => {
    await claimUpdate(UPD, CHAT);
    await completeUpdate(UPD);
    await ageTheClaim(86_400);

    expect(await claimUpdate(UPD, CHAT)).toBe('duplicate');
  });

  it('marks the row done on completion', async () => {
    await claimUpdate(UPD, CHAT);
    await completeUpdate(UPD);

    const rows = await db.select().from(processedUpdates).where(eq(processedUpdates.updateId, UPD));

    expect(rows[0]!.status).toBe('done');
    expect(rows[0]!.completedAt).not.toBeNull();
  });
});

describe('sessions', () => {
  it('round-trips a session id', async () => {
    await setSessionId(CHAT, 'sess-abc');
    expect(await getSessionId(CHAT)).toBe('sess-abc');
  });

  it('overwrites rather than duplicating on re-set', async () => {
    await setSessionId(CHAT, 'sess-one');
    await setSessionId(CHAT, 'sess-two');
    expect(await getSessionId(CHAT)).toBe('sess-two');

    const rows = await db.select().from(sessions).where(eq(sessions.storeId, CHAT));
    expect(rows).toHaveLength(1);
  });

  it('clearSession removes the conversation and leaves the store standing', async () => {
    await setSessionId(CHAT, 'sess-abc');
    await clearSession(CHAT);

    expect(await getSessionId(CHAT)).toBeUndefined();

    // /new must not wipe the shop.
    const store = await db.select().from(stores).where(eq(stores.id, CHAT));
    expect(store).toHaveLength(1);
  });
});

describe('session cost', () => {
  it('is zero when there is no session', async () => {
    expect(await getSessionCostMicroUsd(CHAT)).toBe(0);
  });

  it('stores and updates the cumulative cost with the session id', async () => {
    await setSessionId(CHAT, 's1', 400_000);
    expect(await getSessionCostMicroUsd(CHAT)).toBe(400_000);
    await setSessionId(CHAT, 's1', 650_000);
    expect(await getSessionCostMicroUsd(CHAT)).toBe(650_000);
  });

  it('resets when the conversation is cleared with /new', async () => {
    await setSessionId(CHAT, 's1', 400_000);
    await clearSession(CHAT);
    expect(await getSessionCostMicroUsd(CHAT)).toBe(0);
  });
});
