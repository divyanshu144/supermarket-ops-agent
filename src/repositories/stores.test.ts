import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { stores } from '../db/schema.js';
import { provisionStore } from './stores.js';

const CHAT = 999000002n;

beforeEach(async () => {
  await db.delete(stores).where(eq(stores.id, CHAT));
});

afterAll(async () => {
  await db.delete(stores).where(eq(stores.id, CHAT));
  await pool.end();
});

describe('provisionStore', () => {
  it('creates a store on first contact', async () => {
    const result = await provisionStore(CHAT);
    expect(result).toEqual({ id: CHAT, created: true });
  });

  it('is idempotent on second contact', async () => {
    await provisionStore(CHAT);
    const result = await provisionStore(CHAT);
    expect(result.created).toBe(false);
  });

  it('leaves the existing row untouched on re-provision', async () => {
    await provisionStore(CHAT);
    await db.update(stores).set({ name: 'Renamed By Owner' }).where(eq(stores.id, CHAT));

    await provisionStore(CHAT);

    const rows = await db.select().from(stores).where(eq(stores.id, CHAT));
    expect(rows[0]!.name).toBe('Renamed By Owner');
  });
});
