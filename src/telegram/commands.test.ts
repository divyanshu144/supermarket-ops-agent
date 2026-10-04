import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { inviteCodes, products, sessionEntries, stores } from '../db/schema.js';
import { createInvite, hasStore, redeemInvite } from '../repositories/access.js';
import { appendEntries, sessionHasEntries } from '../repositories/session-entries.js';
import { provisionStore } from '../repositories/stores.js';
import { getSessionCostMicroUsd, getSessionId, setSessionId } from '../repositories/updates.js';
import { newCommand, resetCommand, startCommand } from './commands.js';
import { INVALID_CODE, PRIVATE_MESSAGE, RESET_EXPLAINER, WELCOME } from './messages.js';

const STRANGER = 999100020n;
const OWNER = 999100021n;
const OTHER = 999100022n;
const made: string[] = [];

async function invite() {
  const created = await createInvite();
  made.push(created.id);
  return created;
}

afterEach(async () => {
  await db.delete(stores).where(inArray(stores.id, [STRANGER, OWNER, OTHER]));
});

afterAll(async () => {
  await db.delete(sessionEntries).where(eq(sessionEntries.sessionId, 's'));
  if (made.length) await db.delete(inviteCodes).where(inArray(inviteCodes.id, made));
  await pool.end();
});

describe('startCommand', () => {
  it('turns a stranger with no code away and creates nothing', async () => {
    expect(await startCommand(STRANGER, '')).toBe(PRIVATE_MESSAGE);
    expect(await hasStore(STRANGER)).toBe(false);
  });

  it('rejects an invalid code and creates nothing', async () => {
    expect(await startCommand(STRANGER, 'nonsense')).toBe(INVALID_CODE);
    expect(await hasStore(STRANGER)).toBe(false);
  });

  it('welcomes a stranger who presents a valid code, and creates their store', async () => {
    const { code } = await invite();
    expect(await startCommand(STRANGER, code)).toBe(WELCOME);
    expect(await hasStore(STRANGER)).toBe(true);
  });

  it('welcomes an existing owner without spending a code', async () => {
    await provisionStore(OWNER);
    const { code } = await invite();
    expect(await startCommand(OWNER, code)).toBe(WELCOME);
    // The code is still good for someone else.
    expect(await redeemInvite(code, OTHER)).toBe('redeemed');
  });
});

describe('resetCommand', () => {
  async function ownerWithEditedStock(): Promise<void> {
    await provisionStore(OWNER);
    const [row] = await db.select().from(products).where(eq(products.storeId, OWNER)).limit(1);
    await db.update(products).set({ quantityBase: 777 }).where(eq(products.id, row!.id));
  }

  async function edited(): Promise<number> {
    const rows = await db.select().from(products).where(eq(products.storeId, OWNER));
    return rows.filter((r) => r.quantityBase === 777).length;
  }

  it('explains and changes nothing without the confirm argument', async () => {
    await ownerWithEditedStock();
    expect(await resetCommand(OWNER, '')).toBe(RESET_EXPLAINER);
    expect(await resetCommand(OWNER, 'please')).toBe(RESET_EXPLAINER);
    expect(await edited()).toBe(1);
  });

  it('restores the starting state on /reset confirm, in any case', async () => {
    await ownerWithEditedStock();
    await resetCommand(OWNER, 'CONFIRM');
    expect(await edited()).toBe(0);
  });

  it('clears the conversation session on /reset confirm but not on a bare /reset', async () => {
    await provisionStore(OWNER);
    await setSessionId(OWNER, 's', 123_456);
    await appendEntries({ projectKey: '/p', sessionId: 's' }, [{ type: 'user', uuid: 'x' }]);

    await resetCommand(OWNER, '');
    expect(await getSessionId(OWNER)).toBe('s');
    expect(await getSessionCostMicroUsd(OWNER)).toBe(123_456);
    expect(await sessionHasEntries('s')).toBe(true);

    await resetCommand(OWNER, 'confirm');
    expect(await getSessionId(OWNER)).toBeUndefined();
    expect(await getSessionCostMicroUsd(OWNER)).toBe(0);
    expect(await sessionHasEntries('s')).toBe(false);
  });
});

describe('newCommand', () => {
  it('confirms that stock and preferences are kept', async () => {
    await provisionStore(OWNER);
    expect(await newCommand(OWNER)).toMatch(/unchanged/i);
  });

  it('clears the conversation session and its cost total', async () => {
    await provisionStore(OWNER);
    await setSessionId(OWNER, 's', 123_456);
    await appendEntries({ projectKey: '/p', sessionId: 's' }, [{ type: 'user', uuid: 'x' }]);
    await newCommand(OWNER);
    expect(await getSessionId(OWNER)).toBeUndefined();
    expect(await getSessionCostMicroUsd(OWNER)).toBe(0);
    expect(await sessionHasEntries('s')).toBe(false);
  });
});
