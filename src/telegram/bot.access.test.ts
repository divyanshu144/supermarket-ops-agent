import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { inviteCodes, processedUpdates, stores } from '../db/schema.js';

vi.mock('../agent/runtime.js', () => ({
  runAgent: vi.fn().mockResolvedValue({
    reply: 'agent says hi',
    sessionId: 'sess-1',
    toolsUsed: [],
    outcome: 'ok',
    totalCostUsd: 0.01,
    turnCostUsd: 0.01,
    numTurns: 1,
  }),
}));
vi.mock('../media/download.js', () => ({
  downloadTelegramFile: vi.fn().mockResolvedValue(Buffer.from('x')),
}));
vi.mock('../media/transcribe.js', () => ({ transcribe: vi.fn().mockResolvedValue('hello') }));

const { createBot } = await import('./bot.js');
const { runAgent } = await import('../agent/runtime.js');
const { downloadTelegramFile } = await import('../media/download.js');
const { createInvite } = await import('../repositories/access.js');
const { recordUsage } = await import('../repositories/usage.js');
const { provisionStore } = await import('../repositories/stores.js');
const { loadEnv } = await import('../config/env.js');
const { PRIVATE_MESSAGE, DAILY_CAP_REPLY, RATE_LIMITED_REPLY, WELCOME } =
  await import('./messages.js');
const { microUsd } = await import('../agent/limits.js');

const STRANGER = 999100030n;
const OWNER = 999100031n;
const CAPPED = 999100032n;
const SPAMMER = 999100033n;
const GROUP = -999100034n;
const ALL = [STRANGER, OWNER, CAPPED, SPAMMER, GROUP];
const made: string[] = [];
const env = loadEnv();

const sent: { method: string; payload: Record<string, unknown> }[] = [];

function makeBot() {
  const bot = createBot('123456:test-token-not-real', {
    id: 1,
    is_bot: true,
    first_name: 'Test',
    username: 'test_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  } as never);
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: true } as never;
  });
  return bot;
}

let nextId = 5_000_000;
function textUpdate(chatId: bigint, text: string) {
  const id = nextId++;
  const isCommand = text.startsWith('/');
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: {
        id: Number(chatId),
        type: chatId < 0n ? 'group' : 'private',
        title: 'T',
        first_name: 'T',
      },
      from: { id: Number(chatId), is_bot: false, first_name: 'T' },
      text,
      ...(isCommand
        ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] }
        : {}),
    },
  };
}

function voiceUpdate(chatId: bigint) {
  const id = nextId++;
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: Number(chatId), type: 'private', first_name: 'T' },
      from: { id: Number(chatId), is_bot: false, first_name: 'T' },
      voice: { file_id: 'f', file_unique_id: 'u', duration: 3, mime_type: 'audio/ogg' },
    },
  };
}

const replies = () =>
  sent.filter((s) => s.method === 'sendMessage').map((s) => String(s.payload.text));

beforeEach(async () => {
  sent.length = 0;
  vi.mocked(runAgent).mockClear();
  vi.mocked(downloadTelegramFile).mockClear();
  await db.delete(stores).where(inArray(stores.id, ALL));
});

afterAll(async () => {
  await db.delete(stores).where(inArray(stores.id, ALL));
  await db.delete(processedUpdates).where(inArray(processedUpdates.chatId, ALL));
  if (made.length) await db.delete(inviteCodes).where(inArray(inviteCodes.id, made));
  await pool.end();
});

describe('access gate', () => {
  it('turns a stranger away with one fixed reply and makes no agent call', async () => {
    const bot = makeBot();
    await bot.handleUpdate(textUpdate(STRANGER, 'how much sugar is left?') as never);
    expect(replies()).toEqual([PRIVATE_MESSAGE]);
    expect(runAgent).not.toHaveBeenCalled();
    expect(
      await db
        .select()
        .from(stores)
        .where(inArray(stores.id, [STRANGER])),
    ).toHaveLength(0);
  });

  it('does not let a stranger run /reset', async () => {
    const bot = makeBot();
    await bot.handleUpdate(textUpdate(STRANGER, '/reset confirm') as never);
    expect(replies()).toEqual([PRIVATE_MESSAGE]);
  });

  it('answers a stranger voice note without downloading or transcribing it', async () => {
    const bot = makeBot();
    await bot.handleUpdate(voiceUpdate(STRANGER) as never);
    expect(replies()).toEqual([PRIVATE_MESSAGE]);
    expect(downloadTelegramFile).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('redeems a code via /start, then lets the new owner talk to the agent', async () => {
    const { id, code } = await createInvite();
    made.push(id);
    const bot = makeBot();

    await bot.handleUpdate(textUpdate(STRANGER, `/start ${code}`) as never);
    expect(replies()).toEqual([WELCOME]);

    await bot.handleUpdate(textUpdate(STRANGER, 'how much sugar is left?') as never);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(replies()).toContain('agent says hi');
  });

  it('redeems from a group chat and lets the group talk afterwards', async () => {
    const { id, code } = await createInvite();
    made.push(id);
    const bot = makeBot();

    await bot.handleUpdate(textUpdate(GROUP, `/start ${code}`) as never);
    await bot.handleUpdate(textUpdate(GROUP, 'stock check') as never);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it('keeps an existing owner working with no code at all', async () => {
    await provisionStore(OWNER);
    const bot = makeBot();
    await bot.handleUpdate(textUpdate(OWNER, 'hello') as never);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });
});

describe('spend and rate guards', () => {
  it('refuses a turn once the store has spent its daily budget, with no agent call', async () => {
    await provisionStore(CAPPED);
    await recordUsage(CAPPED, microUsd(env.STORE_DAILY_BUDGET_USD)); // exactly at the cap
    const bot = makeBot();

    await bot.handleUpdate(textUpdate(CAPPED, 'hello') as never);

    expect(replies()).toEqual([DAILY_CAP_REPLY]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('rate-limits a chat after RATE_LIMIT_TURNS turns in the window', async () => {
    await provisionStore(SPAMMER);
    const bot = makeBot();

    for (let i = 0; i < env.RATE_LIMIT_TURNS; i++) {
      await bot.handleUpdate(textUpdate(SPAMMER, `msg ${i}`) as never);
    }
    expect(runAgent).toHaveBeenCalledTimes(env.RATE_LIMIT_TURNS);

    await bot.handleUpdate(textUpdate(SPAMMER, 'one too many') as never);
    expect(runAgent).toHaveBeenCalledTimes(env.RATE_LIMIT_TURNS);
    expect(replies().at(-1)).toBe(RATE_LIMITED_REPLY);
  });
});
