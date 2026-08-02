import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'grammy';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { processedUpdates, stores } from '../db/schema.js';
import { claimUpdate } from '../repositories/updates.js';

// handleTurn calls runAgent, which calls the real Anthropic API. Mocked so this test exercises
// only the claim/skip-claim branch the alreadyClaimed option controls, with no network call and
// no dependency on API credit.
const runAgentMock = vi.fn(async () => ({ reply: 'ok', sessionId: 'sess-1', toolsUsed: [] }));
vi.mock('../agent/runtime.js', () => ({ runAgent: () => runAgentMock() }));

const { handleTurn } = await import('./turn.js');

const UPD = 88800099n;
const CHAT = 999000088n;

function fakeCtx(): Context & { replies: string[] } {
  const replies: string[] = [];
  return {
    update: { update_id: Number(UPD) },
    chat: { id: Number(CHAT) },
    reply: vi.fn(async (text: string) => {
      replies.push(text);
    }),
    replyWithChatAction: vi.fn(async () => {}),
    replyWithDocument: vi.fn(async () => {}),
    replies,
  } as unknown as Context & { replies: string[] };
}

async function updateStatus(): Promise<string | undefined> {
  const rows = await db.select().from(processedUpdates).where(eq(processedUpdates.updateId, UPD));
  return rows[0]?.status;
}

beforeEach(async () => {
  runAgentMock.mockClear();
  await db.delete(processedUpdates).where(eq(processedUpdates.updateId, UPD));
  await db.delete(stores).where(eq(stores.id, CHAT));
});

afterAll(async () => {
  await db.delete(processedUpdates).where(eq(processedUpdates.updateId, UPD));
  await db.delete(stores).where(eq(stores.id, CHAT));
  await pool.end();
});

describe('handleTurn — alreadyClaimed', () => {
  it('default behaviour is unchanged: a duplicate claim short-circuits before the agent runs', async () => {
    // Simulates a genuine Telegram redelivery racing a still-fresh claim from elsewhere.
    await claimUpdate(UPD, CHAT);
    const ctx = fakeCtx();

    await handleTurn(ctx, 'hello');

    expect(runAgentMock).not.toHaveBeenCalled();
    expect(ctx.replies).toHaveLength(0);
  });

  it('with no pre-claim, handleTurn claims for itself and completes the turn (unchanged default path)', async () => {
    const ctx = fakeCtx();

    await handleTurn(ctx, 'hello');

    expect(runAgentMock).toHaveBeenCalledOnce();
    expect(await updateStatus()).toBe('done');
  });

  it('alreadyClaimed:true proceeds even though the caller already holds the claim', async () => {
    // This is the voice-handler shape: the caller claims first (before downloading/transcribing),
    // then hands the turn to handleTurn. Without the option, handleTurn's own claimUpdate call
    // would see its own fresh claim and treat it as a duplicate, and the turn would never run.
    await claimUpdate(UPD, CHAT);
    const ctx = fakeCtx();

    await handleTurn(ctx, 'hello', { alreadyClaimed: true });

    expect(runAgentMock).toHaveBeenCalledOnce();
    expect(await updateStatus()).toBe('done');
  });
});
