import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, pool } from '../db/client.js';
import {
  inviteCodes,
  khataAccounts,
  pendingActions,
  processedUpdates,
  stores,
} from '../db/schema.js';

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
vi.mock('../media/transcribe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../media/transcribe.js')>()),
  transcribe: vi.fn().mockResolvedValue('hello'),
}));

const { createBot } = await import('./bot.js');
const { beginDrain, resetDrainForTests } = await import('./drain.js');
const { runAgent } = await import('../agent/runtime.js');
const { downloadTelegramFile } = await import('../media/download.js');
const { createInvite } = await import('../repositories/access.js');
const { createPendingAction } = await import('../repositories/confirmations.js');
const { recordUsage, spentTodayMicroUsd } = await import('../repositories/usage.js');
const { getSessionCostMicroUsd } = await import('../repositories/updates.js');
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

let nextId = Date.now() % 2_000_000_000;
function textUpdate(chatId: bigint, text: string, opts: { entity?: boolean } = {}) {
  const id = nextId++;
  const isCommand = opts.entity ?? text.startsWith('/');
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

function callbackUpdate(chatId: bigint, userId: bigint, data: string) {
  const id = nextId++;
  return {
    update_id: id,
    callback_query: {
      id: `callback-${id}`,
      from: { id: Number(userId), is_bot: false, first_name: 'T' },
      chat_instance: 'private-chat-instance',
      message: {
        message_id: id,
        date: 0,
        chat: { id: Number(chatId), type: 'private', first_name: 'T' },
        text: 'Awaiting confirmation',
      },
      data,
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

  it('redeems in a private chat and only lets the redeeming Telegram user talk to the agent', async () => {
    const { id, code } = await createInvite();
    made.push(id);
    const bot = makeBot();

    await bot.handleUpdate(textUpdate(STRANGER, `/start ${code}`) as never);
    expect(replies()).toEqual([WELCOME]);

    await bot.handleUpdate(textUpdate(STRANGER, 'how much sugar is left?') as never);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(replies()).toContain('agent says hi');

    const otherUser = textUpdate(STRANGER, 'stock please');
    otherUser.message.from.id = 700099;
    await bot.handleUpdate(otherUser as never);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(replies().at(-1)).toMatch(/private|owner/i);
  });

  it('fails closed for group chat invite redemption and group turns', async () => {
    const { id, code } = await createInvite();
    made.push(id);
    const bot = makeBot();

    await bot.handleUpdate(textUpdate(GROUP, `/start ${code}`) as never);
    expect(replies()).toEqual([PRIVATE_MESSAGE]);
    await bot.handleUpdate(textUpdate(GROUP, 'stock check') as never);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('does not let another private-chat user use a leaked confirmation callback', async () => {
    const { id, code } = await createInvite();
    made.push(id);
    const bot = makeBot();
    await bot.handleUpdate(textUpdate(OWNER, `/start ${code}`) as never);
    const pending = await createPendingAction({
      storeId: OWNER,
      ownerUserId: OWNER,
      originatingUpdateId: 7001n,
      tool: 'void_bill',
      arguments: { bill_id: '123e4567-e89b-42d3-a456-426614174000' },
    });

    await bot.handleUpdate(callbackUpdate(OWNER, 700099n, `rai:c:${pending.callbackId}`) as never);

    const { pendingActions } = await import('../db/schema.js');
    const { eq } = await import('drizzle-orm');
    const [row] = await db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.callbackId, pending.callbackId));
    expect(row!.status).toBe('pending');
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('keeps a legacy store with no bound owner inaccessible', async () => {
    await provisionStore(OWNER);
    const bot = makeBot();

    await bot.handleUpdate(textUpdate(OWNER, 'stock check') as never);

    expect(replies()).toEqual([PRIVATE_MESSAGE]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('does not let a stranger slip through with /start addressed to another bot', async () => {
    const bot = makeBot();
    const update = textUpdate(STRANGER, '/start@otherbot hi');
    await bot.handleUpdate(update as never);
    expect(replies()).toEqual([PRIVATE_MESSAGE]);
    expect(runAgent).not.toHaveBeenCalled();
    expect(
      await db
        .select()
        .from(stores)
        .where(inArray(stores.id, [STRANGER])),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(processedUpdates)
        .where(eq(processedUpdates.updateId, BigInt(update.update_id))),
    ).toHaveLength(0); // denied by the gate before any claim; handleTurn would have claimed it
  });

  it('does not treat /start text with no command entity as a start', async () => {
    const bot = makeBot();
    const update = textUpdate(STRANGER, '/start hello', { entity: false });
    await bot.handleUpdate(update as never);
    expect(replies()).toEqual([PRIVATE_MESSAGE]);
    expect(runAgent).not.toHaveBeenCalled();
    expect(
      await db
        .select()
        .from(stores)
        .where(inArray(stores.id, [STRANGER])),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(processedUpdates)
        .where(eq(processedUpdates.updateId, BigInt(update.update_id))),
    ).toHaveLength(0); // denied by the gate before any claim; handleTurn would have claimed it
  });

  it('redeems /start@<this bot> <code>', async () => {
    const { id, code } = await createInvite();
    made.push(id);
    const bot = makeBot();
    await bot.handleUpdate(textUpdate(STRANGER, `/start@test_bot ${code}`) as never);
    expect(replies()).toEqual([WELCOME]);
    expect(
      await db
        .select()
        .from(stores)
        .where(inArray(stores.id, [STRANGER])),
    ).toHaveLength(1);
  });

  it('keeps an existing owner working with no code at all', async () => {
    await provisionStore(OWNER, OWNER);
    const bot = makeBot();
    await bot.handleUpdate(textUpdate(OWNER, 'hello') as never);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it('serves /privacy to the owner as plain text', async () => {
    await provisionStore(OWNER, OWNER);
    const bot = makeBot();
    await bot.handleUpdate(textUpdate(OWNER, '/privacy') as never);

    expect(replies().join('\n')).toContain('Anthropic');
    expect(replies().join('\n')).toContain('OpenAI');
    expect(replies().join('\n')).toContain('30 days without activity');
    expect(replies().join('\n')).not.toContain('no automatic expiry');
    expect(sent.at(-1)?.method).toBe('sendMessage');
    expect(sent.at(-1)?.payload.parse_mode).toBeUndefined();
  });

  it('exports only for the owner and sends a document without calling the model', async () => {
    await provisionStore(OWNER, OWNER);
    const bot = makeBot();

    await bot.handleUpdate(textUpdate(OWNER, '/export') as never);

    expect(sent.some((call) => call.method === 'sendDocument')).toBe(true);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('previews customer pseudonymisation and creates a short owner-bound W1 callback', async () => {
    await provisionStore(OWNER, OWNER);
    await db.insert(khataAccounts).values({
      storeId: OWNER,
      customerName: 'Privacy Test Customer',
      phone: '9876543210',
      balancePaise: 5000,
    });
    const bot = makeBot();

    await bot.handleUpdate(textUpdate(OWNER, '/pseudonymise Privacy Test Customer') as never);

    expect(replies()[0]).toContain('Preview: 1 account');
    expect(replies()[0]).toContain('Existing transcript mentions are not changed');
    const reply = sent.find((call) => call.method === 'sendMessage' && call.payload.reply_markup);
    const keyboard = reply!.payload.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    const callbackData = keyboard.inline_keyboard.flat().map((button) => button.callback_data);
    expect(callbackData).toHaveLength(2);
    expect(callbackData.every((data) => Buffer.byteLength(data, 'utf8') <= 64)).toBe(true);
    const pending = await db.select().from(pendingActions).where(eq(pendingActions.storeId, OWNER));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.tool).toBe('pseudonymise_customer');
    expect(pending[0]!.status).toBe('pending');
    expect(runAgent).not.toHaveBeenCalled();
  });
});

describe('turn to ledger wiring', () => {
  it('records each turn against the daily budget and the session, passing the prior total', async () => {
    await provisionStore(OWNER, OWNER);
    const bot = makeBot();

    await bot.handleUpdate(textUpdate(OWNER, 'one') as never);
    expect(await spentTodayMicroUsd(OWNER)).toBe(10_000);
    expect(await getSessionCostMicroUsd(OWNER)).toBe(10_000);

    vi.mocked(runAgent).mockResolvedValueOnce({
      reply: 'again',
      sessionId: 'sess-1',
      toolsUsed: [],
      outcome: 'ok',
      totalCostUsd: 0.03,
      turnCostUsd: 0.02,
      numTurns: 1,
      resumeDropped: false,
      attempts: [],
    });
    await bot.handleUpdate(textUpdate(OWNER, 'two') as never);

    expect(runAgent).toHaveBeenLastCalledWith(expect.objectContaining({ priorCostUsd: 0.01 }));
    expect(await spentTodayMicroUsd(OWNER)).toBe(30_000);
    expect(await getSessionCostMicroUsd(OWNER)).toBe(30_000);
  });

  it('records the Whisper cost of a voice note against the daily budget', async () => {
    await provisionStore(OWNER, OWNER);
    const bot = makeBot();
    const before = await spentTodayMicroUsd(OWNER);

    await bot.handleUpdate(voiceUpdate(OWNER) as never);

    // 3 s of audio = 300 micro-USD of Whisper, plus the mocked agent turn's 10_000.
    expect((await spentTodayMicroUsd(OWNER)) - before).toBe(10_300);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it('keeps the Telegram voice handler in memory without writing audio files', async () => {
    await provisionStore(OWNER, OWNER);
    const originalCwd = process.cwd();
    const isolated = await mkdtemp(join(tmpdir(), 'rai-telegram-audio-'));
    try {
      process.chdir(isolated);
      const bot = makeBot();
      await bot.handleUpdate(voiceUpdate(OWNER) as never);
      expect(await readdir(isolated)).toEqual([]);
    } finally {
      process.chdir(originalCwd);
      await rm(isolated, { recursive: true, force: true });
    }
  });
});

describe('spend and rate guards', () => {
  it('refuses a turn once the store has spent its daily budget, with no agent call', async () => {
    await provisionStore(CAPPED, CAPPED);
    await recordUsage(CAPPED, microUsd(env.STORE_DAILY_BUDGET_USD)); // exactly at the cap
    const bot = makeBot();

    await bot.handleUpdate(textUpdate(CAPPED, 'hello') as never);

    expect(replies()).toEqual([DAILY_CAP_REPLY]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('refuses a voice note at the cap before downloading or transcribing', async () => {
    await provisionStore(CAPPED, CAPPED);
    await recordUsage(CAPPED, microUsd(env.STORE_DAILY_BUDGET_USD));
    const bot = makeBot();

    await bot.handleUpdate(voiceUpdate(CAPPED) as never);

    expect(replies()).toEqual([DAILY_CAP_REPLY]);
    expect(downloadTelegramFile).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('rate-limits a chat after RATE_LIMIT_TURNS turns in the window', async () => {
    await provisionStore(SPAMMER, SPAMMER);
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

describe('draining', () => {
  afterEach(() => resetDrainForTests());

  it('neither handles nor claims an update that arrives during shutdown', async () => {
    await provisionStore(OWNER, OWNER);
    const bot = makeBot();

    // Control: the harness can handle an update when not draining.
    await bot.handleUpdate(textUpdate(OWNER, 'how much sugar is left?') as never);
    expect(runAgent).toHaveBeenCalledTimes(1);
    vi.mocked(runAgent).mockClear();
    const sentBefore = sent.length;

    await beginDrain(10); // nothing in flight: drained at once, but the gate now holds

    const update = textUpdate(OWNER, 'bill 2 sugar');
    void bot.handleUpdate(update as never); // never settles by design; do not await it
    await new Promise((r) => setTimeout(r, 150));

    expect(runAgent).not.toHaveBeenCalled();
    expect(sent).toHaveLength(sentBefore);
    const claimed = await db
      .select()
      .from(processedUpdates)
      .where(eq(processedUpdates.updateId, BigInt(update.update_id)));
    expect(claimed).toHaveLength(0);
  });
});
