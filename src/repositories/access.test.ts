import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { inviteCodes, stores } from '../db/schema.js';
import { createInvite, hasStore, listInvites, redeemInvite, revokeInvite } from './access.js';

const A = 999100002n;
const B = 999100003n;
const made: string[] = [];

async function invite() {
  const created = await createInvite();
  made.push(created.id);
  return created;
}

afterEach(async () => {
  await db.delete(stores).where(inArray(stores.id, [A, B]));
});

afterAll(async () => {
  if (made.length) await db.delete(inviteCodes).where(inArray(inviteCodes.id, made));
  await db.delete(stores).where(inArray(stores.id, [A, B]));
  await pool.end();
});

describe('hasStore', () => {
  it('is false before provisioning and true after redemption', async () => {
    expect(await hasStore(A)).toBe(false);
    const { code } = await invite();
    await redeemInvite(code, A, 7001n);
    expect(await hasStore(A)).toBe(true);
  });
});

describe('createInvite', () => {
  it('stores only a hash, never the plaintext code', async () => {
    const { id, code } = await invite();
    const [row] = await db.select().from(inviteCodes).where(eq(inviteCodes.id, id));
    expect(row!.codeHash).not.toContain(code);
    expect(row!.codeHash).toHaveLength(64);
  });

  it('issues a lowercase code with no ambiguous characters', async () => {
    const { code } = await invite();
    expect(code).toMatch(/^[a-hj-km-np-z2-9]{12}$/);
  });
});

describe('redeemInvite', () => {
  it('provisions a store and records who used the code', async () => {
    const { id, code } = await invite();
    expect(await redeemInvite(code, A, 7001n)).toBe('redeemed');
    expect(await hasStore(A)).toBe(true);
    const [row] = await db.select().from(inviteCodes).where(eq(inviteCodes.id, id));
    expect(row!.usedByChat).toBe(A);
    expect(row!.usedAt).not.toBeNull();
    const [store] = await db.select().from(stores).where(eq(stores.id, A));
    expect(store!.ownerUserId).toBe(7001n);
  });

  it('refuses a second redemption and creates no second store', async () => {
    const { code } = await invite();
    await redeemInvite(code, A, 7001n);
    expect(await redeemInvite(code, B, 7002n)).toBe('invalid');
    expect(await hasStore(B)).toBe(false);
  });

  it('lets exactly one of two simultaneous redemptions win', async () => {
    const { code } = await invite();
    const results = await Promise.all([redeemInvite(code, A, 7001n), redeemInvite(code, B, 7002n)]);
    expect([...results].sort()).toEqual(['invalid', 'redeemed']);
    const owners = [await hasStore(A), await hasStore(B)].filter(Boolean);
    expect(owners).toHaveLength(1);
  });

  it('rejects an unknown code', async () => {
    expect(await redeemInvite('zzzzzzzzzzzz', A, 7001n)).toBe('invalid');
    expect(await hasStore(A)).toBe(false);
  });

  it('rejects a revoked code', async () => {
    const { id, code } = await invite();
    expect(await revokeInvite(id)).toBe(true);
    expect(await redeemInvite(code, A, 7001n)).toBe('invalid');
    expect(await hasStore(A)).toBe(false);
  });

  it('accepts a code typed in upper case with stray spaces', async () => {
    const { code } = await invite();
    expect(await redeemInvite(`  ${code.toUpperCase()} `, A, 7001n)).toBe('redeemed');
  });

  it('rejects a missing owner identity', async () => {
    const { code } = await invite();
    await expect(redeemInvite(code, A, null)).rejects.toThrow(/owner/i);
    expect(await hasStore(A)).toBe(false);
  });
});

describe('revokeInvite', () => {
  it('does not revoke a code that was already redeemed', async () => {
    const { id, code } = await invite();
    await redeemInvite(code, A, 7001n);
    expect(await revokeInvite(id)).toBe(false);
    expect(await hasStore(A)).toBe(true);
  });
});

describe('listInvites', () => {
  it('lists codes without any code material', async () => {
    const { id } = await invite();
    const rows = await listInvites();
    const row = rows.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(Object.keys(row!)).not.toContain('codeHash');
  });
});
