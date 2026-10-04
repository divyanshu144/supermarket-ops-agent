import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { inviteCodes } from '../db/schema.js';

vi.mock('./stores.js', () => ({
  provisionStore: vi.fn().mockRejectedValue(new Error('database blip')),
}));

const { createInvite, redeemInvite } = await import('./access.js');

const ids: string[] = [];

afterAll(async () => {
  for (const id of ids) await db.delete(inviteCodes).where(eq(inviteCodes.id, id));
  await pool.end();
});

describe('redeemInvite when provisioning fails', () => {
  it('releases the code instead of burning it', async () => {
    const { id, code } = await createInvite();
    ids.push(id);

    await expect(redeemInvite(code, 999100005n)).rejects.toThrow('database blip');

    const [row] = await db.select().from(inviteCodes).where(eq(inviteCodes.id, id));
    expect(row!.usedAt).toBeNull();
    expect(row!.usedByChat).toBeNull();
  });
});
