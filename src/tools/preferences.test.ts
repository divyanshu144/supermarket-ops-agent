import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { sessions, stores } from '../db/schema.js';
import { clearSession, setSessionId } from '../repositories/updates.js';
import { deletePreference, readPreferences, writePreference } from './preferences.js';

const STORE = 999000040n;

beforeEach(async () => {
  await db.delete(stores).where(eq(stores.id, STORE));
  await db.insert(stores).values({ id: STORE, name: 'Pref Kirana', gstin: '27AAAAA0000A1Z5' });
});

afterAll(async () => {
  await db.delete(stores).where(eq(stores.id, STORE));
  await pool.end();
});

describe('preferences', () => {
  it('round-trips a value', async () => {
    await writePreference(STORE, 'default_payment_mode', 'upi');
    expect(await readPreferences(STORE)).toEqual({ default_payment_mode: 'upi' });
  });

  it('overwrites rather than duplicating', async () => {
    await writePreference(STORE, 'default_payment_mode', 'upi');
    await writePreference(STORE, 'default_payment_mode', 'cash');
    expect(await readPreferences(STORE)).toEqual({ default_payment_mode: 'cash' });
  });

  it('SURVIVES /new — this is the memory-outside-the-context-window demo', async () => {
    // /new clears the conversation session and nothing else. If preferences lived in the
    // conversation, a fresh chat would forget the owner defaults to UPI.
    await writePreference(STORE, 'default_payment_mode', 'upi');
    await writePreference(STORE, 'preferred_atta', 'Aashirvaad 5kg');
    await setSessionId(STORE, 'sess-before');

    await clearSession(STORE);

    const sessionRows = await db.select().from(sessions).where(eq(sessions.storeId, STORE));
    expect(sessionRows).toHaveLength(0); // conversation gone

    expect(await readPreferences(STORE)).toEqual({
      default_payment_mode: 'upi',
      preferred_atta: 'Aashirvaad 5kg',
    }); // shop memory intact
  });

  it('is scoped per store', async () => {
    const OTHER = 999000041n;
    await db.delete(stores).where(eq(stores.id, OTHER));
    await db.insert(stores).values({ id: OTHER, name: 'Other', gstin: '27AAAAA0000A1Z5' });

    await writePreference(STORE, 'default_payment_mode', 'upi');
    expect(await readPreferences(OTHER)).toEqual({});

    await db.delete(stores).where(eq(stores.id, OTHER));
  });

  it('can forget a preference', async () => {
    await writePreference(STORE, 'temp', 'x');
    await deletePreference(STORE, 'temp');
    expect(await readPreferences(STORE)).toEqual({});
  });
});
