import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { inviteCodes, stores } from '../db/schema.js';

vi.mock('./stores.js', () => ({
  provisionStore: vi.fn(),
}));

const { createInvite, redeemInvite, hasStore } = await import('./access.js');
const { provisionStore } = await import('./stores.js');
const provision = vi.mocked(provisionStore);

const CHAT_A = 999100005n;
const CHAT_B = 999100006n;
const ids: string[] = [];

beforeEach(async () => {
  provision.mockReset();
  await db.delete(stores).where(inArray(stores.id, [CHAT_A, CHAT_B]));
});

afterAll(async () => {
  await db.delete(stores).where(inArray(stores.id, [CHAT_A, CHAT_B]));
  for (const id of ids) await db.delete(inviteCodes).where(eq(inviteCodes.id, id));
  await pool.end();
});

describe('redeemInvite when provisioning fails', () => {
  it('releases the code instead of burning it, so another chat can still redeem it', async () => {
    const { id, code } = await createInvite();
    ids.push(id);
    provision.mockRejectedValueOnce(new Error('database blip'));

    await expect(redeemInvite(code, CHAT_A)).rejects.toThrow('database blip');

    const [row] = await db.select().from(inviteCodes).where(eq(inviteCodes.id, id));
    expect(row!.usedAt).toBeNull();
    expect(row!.usedByChat).toBeNull();

    // The released code works for another chat (the mock now inserts a real store row).
    provision.mockImplementationOnce(async (chatId: bigint) => {
      await db.insert(stores).values({ id: chatId, name: 'Test', gstin: 'X' });
    });
    expect(await redeemInvite(code, CHAT_B)).toBe('redeemed');
    expect(await hasStore(CHAT_B)).toBe(true);
  });

  it('keeps the code consumed when the store row already committed before the failure', async () => {
    const { id, code } = await createInvite();
    ids.push(id);
    provision.mockImplementationOnce(async (chatId: bigint) => {
      await db.insert(stores).values({ id: chatId, name: 'Half made', gstin: 'X' });
      throw new Error('seeding failed');
    });

    await expect(redeemInvite(code, CHAT_A)).rejects.toThrow('seeding failed');

    const [row] = await db.select().from(inviteCodes).where(eq(inviteCodes.id, id));
    expect(row!.usedAt).not.toBeNull();
    expect(row!.usedByChat).toBe(CHAT_A);
    // So a second chat cannot turn the same invite into a second store.
    expect(await redeemInvite(code, CHAT_B)).toBe('invalid');
  });
});
