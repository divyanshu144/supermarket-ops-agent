import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'grammy';
import type { AgentResult } from '../agent/runtime.js';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { processedUpdates, stores } from '../db/schema.js';
import {
  claimUpdate,
  getSessionCostMicroUsd,
  getSessionId,
  setSessionId,
} from '../repositories/updates.js';
import { spentTodayMicroUsd } from '../repositories/usage.js';
import {
  appendEntries,
  deleteSessionEntries,
  sessionHasEntries,
} from '../repositories/session-entries.js';
import { provisionStore } from '../repositories/stores.js';
import { PRIVATE_MESSAGE } from './messages.js';

// handleTurn calls runAgent, which calls the real Anthropic API. Mocked so this test exercises
// only the claim/skip-claim branch the alreadyClaimed option controls, with no network call and
// no dependency on API credit.
const runAgentMock = vi.fn(async (): Promise<AgentResult> => ({
  reply: 'ok',
  sessionId: 'sess-1',
  toolsUsed: [],
  outcome: 'ok' as const,
  totalCostUsd: 0,
  turnCostUsd: 0,
  numTurns: 1,
  resumeDropped: false,
  attempts: [],
}));
vi.mock('../agent/runtime.js', () => ({
  runAgent: () => runAgentMock(),
  AgentRunFailure: class AgentRunFailure extends Error {
    constructor(
      readonly original: unknown,
      readonly attempts: unknown[],
      readonly conservativelyChargedTurnCostUsd: number,
    ) {
      super('agent run failed after retry');
    }
  },
}));

const { handleTurn } = await import('./turn.js');
const { AgentRunFailure } = await import('../agent/runtime.js');

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
  // handleTurn never creates a store, so the owner under test must already exist.
  await provisionStore(CHAT);
});

afterAll(async () => {
  for (const id of ['old-sess', 'same-sess']) await deleteSessionEntries(id);
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

  it('never creates a store: a chat with no store gets the private message and no agent run', async () => {
    await db.delete(stores).where(eq(stores.id, CHAT));
    const ctx = fakeCtx();

    await handleTurn(ctx, 'hello');

    expect(ctx.replies).toEqual([PRIVATE_MESSAGE]);
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(await db.select().from(stores).where(eq(stores.id, CHAT))).toHaveLength(0);
  });
});

describe('handleTurn — dropped resume', () => {
  it('records the conservative charge when both resumed and fresh attempts fail', async () => {
    runAgentMock.mockRejectedValueOnce(new AgentRunFailure(undefined, [], 1));

    const ctx = fakeCtx();
    await handleTurn(ctx, 'hello');

    expect(await spentTodayMicroUsd(CHAT)).toBe(1_000_000);
    expect(await updateStatus()).toBe('claimed');
    expect(ctx.replies).toEqual(['Something went wrong on my side. Try that again?']);
  });

  it('replaces a stale session row with the new session id and cost', async () => {
    await setSessionId(CHAT, 'stale-id', 900_000);
    runAgentMock.mockResolvedValueOnce({
      reply: 'ok',
      sessionId: 'new-id',
      toolsUsed: [],
      outcome: 'ok',
      totalCostUsd: 0.2,
      turnCostUsd: 0.2,
      numTurns: 1,
      resumeDropped: true,
      attempts: [],
    } satisfies AgentResult);
    await handleTurn(fakeCtx(), 'hello');
    expect(await getSessionId(CHAT)).toBe('new-id');
    expect(await getSessionCostMicroUsd(CHAT)).toBe(200_000);
  });

  it('clears the stale session row when the resume was dropped and no new id arrived', async () => {
    await setSessionId(CHAT, 'stale-id', 900_000);
    runAgentMock.mockResolvedValueOnce({
      reply: 'sorry',
      sessionId: '',
      toolsUsed: [],
      outcome: 'timeout',
      totalCostUsd: 0,
      turnCostUsd: 0.5,
      numTurns: 0,
      resumeDropped: true,
      attempts: [],
    } satisfies AgentResult);
    await handleTurn(fakeCtx(), 'hello');
    expect(await getSessionId(CHAT)).toBeUndefined();
  });

  it('deletes the old transcript when a retried resume produced a new session id', async () => {
    await setSessionId(CHAT, 'old-sess', 100_000);
    await appendEntries({ projectKey: '/p', sessionId: 'old-sess' }, [
      { type: 'user', uuid: 'orphan-check' },
    ]);
    runAgentMock.mockResolvedValueOnce({
      reply: 'ok',
      sessionId: 'new-sess',
      toolsUsed: [],
      outcome: 'ok',
      totalCostUsd: 0.2,
      turnCostUsd: 0.2,
      numTurns: 1,
      resumeDropped: true,
      attempts: [],
    } satisfies AgentResult);
    await handleTurn(fakeCtx(), 'hello');
    expect(await getSessionId(CHAT)).toBe('new-sess');
    expect(await sessionHasEntries('old-sess')).toBe(false);
  });

  it('keeps the transcript on a normal resumed turn', async () => {
    await setSessionId(CHAT, 'same-sess', 100_000);
    await appendEntries({ projectKey: '/p', sessionId: 'same-sess' }, [
      { type: 'user', uuid: 'keep-me' },
    ]);
    runAgentMock.mockResolvedValueOnce({
      reply: 'ok',
      sessionId: 'same-sess',
      toolsUsed: [],
      outcome: 'ok',
      totalCostUsd: 0.2,
      turnCostUsd: 0.1,
      numTurns: 1,
      resumeDropped: false,
      attempts: [],
    } satisfies AgentResult);
    await handleTurn(fakeCtx(), 'hello');
    expect(await sessionHasEntries('same-sess')).toBe(true);
  });
});
