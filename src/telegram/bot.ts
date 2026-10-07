import { Bot, type CommandContext, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { handleConfirmation } from '../agent/confirmation.js';
import { loadEnv } from '../config/env.js';
import { downloadTelegramFile } from '../media/download.js';
import { transcribe, whisperCostMicroUsd } from '../media/transcribe.js';
import { claimUpdate, completeUpdate } from '../repositories/updates.js';
import { recordUsage } from '../repositories/usage.js';
import { newCommand, resetCommand, startCommand } from './commands.js';
import { drainGate } from './drain.js';
import { accessGate } from './gate.js';
import { DAILY_CAP_REPLY, PRIVATE_MESSAGE, RATE_LIMITED_REPLY, WELCOME } from './messages.js';
import { turnLimiter } from './rate-limit.js';
import { redact } from './redact.js';
import { dailyCapReached, handleTurn } from './turn.js';

const env = loadEnv();

/** Voice notes are ~60s of Opus at most; anything longer is a mis-tap, not a shop instruction. */
const MAX_VOICE_SECONDS = 60;

/**
 * Wraps a command handler so a failure replies instead of propagating.
 *
 * Without this, an error inside a command reaches grammY's default handler, which calls
 * bot.stop() — a single database blip would take the bot down.
 */
function guarded(handler: (ctx: CommandContext<Context>) => Promise<void>) {
  return async (ctx: CommandContext<Context>): Promise<void> => {
    try {
      await handler(ctx);
    } catch (error) {
      console.error(redact({ scope: 'command', chatId: String(ctx.chat.id), error }));
      await ctx.reply('Something went wrong on my side. Try that again?');
    }
  };
}

/** The text after the command, e.g. the code in `/start abc123`. */
function argOf(ctx: CommandContext<Context>): string {
  return typeof ctx.match === 'string' ? ctx.match : '';
}

/**
 * Builds the bot. A factory so tests can pass `botInfo` (skipping the network `getMe`) and
 * intercept outgoing API calls; production uses the `bot` export below.
 */
export function createBot(token: string, botInfo?: UserFromGetMe): Bot {
  const bot = new Bot(token, botInfo ? { botInfo } : undefined);

  // The drain gate is first: during shutdown nothing below runs and nothing is claimed.
  bot.use(drainGate);
  // Then: nothing below runs for a chat that has no store and is not redeeming a code.
  bot.use(accessGate);

  bot.on('callback_query:data', async (ctx) => {
    const match = /^rai:([cx]):([A-Za-z0-9_-]{12})$/.exec(ctx.callbackQuery.data);
    if (!match || !ctx.chat || ctx.chat.type !== 'private') {
      await ctx.answerCallbackQuery({
        text: 'This confirmation is unavailable.',
        show_alert: true,
      });
      return;
    }
    const [, decision, callbackId] = match;
    try {
      const result = await handleConfirmation({
        decision: decision === 'c' ? 'confirm' : 'cancel',
        callbackId: callbackId!,
        storeId: BigInt(ctx.chat.id),
        ownerUserId: BigInt(ctx.from.id),
        updateId: BigInt(ctx.update.update_id),
      });
      const message =
        result.status === 'confirmed'
          ? `Confirmation processed (${result.outcome}).`
          : result.status === 'cancelled'
            ? 'Cancelled. Nothing was changed.'
            : result.status === 'stale_bill'
              ? 'The bill changed after this request. Nothing was changed; review it and try again.'
              : 'This confirmation has expired or is no longer available.';
      await ctx.answerCallbackQuery({ text: message, show_alert: result.status !== 'confirmed' });
      await ctx.reply(message);
    } catch (error) {
      console.error(redact({ scope: 'confirmation', error }));
      await ctx.answerCallbackQuery({
        text: 'I could not process that confirmation.',
        show_alert: true,
      });
    }
  });

  bot.command(
    'start',
    guarded(async (ctx) => {
      if (ctx.chat.type !== 'private' || !ctx.from) {
        await ctx.reply(PRIVATE_MESSAGE);
        return;
      }
      await ctx.reply(await startCommand(BigInt(ctx.chat.id), argOf(ctx), BigInt(ctx.from.id)));
    }),
  );

  bot.command(
    'help',
    guarded(async (ctx) => {
      await ctx.reply(WELCOME);
    }),
  );

  bot.command(
    'new',
    guarded(async (ctx) => {
      await ctx.reply(await newCommand(BigInt(ctx.chat.id)));
    }),
  );

  bot.command(
    'reset',
    guarded(async (ctx) => {
      await ctx.reply(await resetCommand(BigInt(ctx.chat.id), argOf(ctx)));
    }),
  );

  bot.on('message:text', async (ctx) => {
    await handleTurn(ctx, ctx.message.text);
  });

  bot.on('message:voice', async (ctx) => {
    // Guard on the metadata Telegram already sent, before spending a download.
    if (ctx.message.voice.duration > MAX_VOICE_SECONDS) {
      await ctx.reply(`That is a long one — keep voice notes under ${MAX_VOICE_SECONDS} seconds.`);
      return;
    }

    // Claim before spending anything, not after. handleTurn's own claim runs too late for
    // voice: by the time it would run, the file is already downloaded and the Whisper call
    // already paid for. A genuine redelivery (the crash-mid-turn case claimUpdate exists for)
    // must not repeat either of those, so this handler claims the update itself and hands the
    // result down.
    const updateId = BigInt(ctx.update.update_id);
    const storeId = BigInt(ctx.chat.id);
    const claim = await claimUpdate(updateId, storeId);
    if (claim === 'duplicate') return;

    // Voice spends before handleTurn does, so it must be rate-limited before the download.
    // handleTurn consumes one more, which makes a voice note count double — it costs double.
    if (!turnLimiter.tryConsume(String(storeId))) {
      await ctx.reply(RATE_LIMITED_REPLY);
      await completeUpdate(updateId);
      return;
    }

    // Whisper is paid for before handleTurn can refuse, so the daily cap applies here too.
    if (await dailyCapReached(storeId)) {
      await ctx.reply(DAILY_CAP_REPLY);
      await completeUpdate(updateId);
      return;
    }

    let transcript: string;
    try {
      const audio = await downloadTelegramFile(ctx, env.TELEGRAM_BOT_TOKEN);
      transcript = await transcribe(
        audio,
        ctx.message.voice.mime_type ?? 'audio/ogg',
        env.OPENAI_API_KEY,
      );
    } catch (error) {
      console.error(redact({ scope: 'voice', chatId: String(ctx.chat.id), error }));
      await ctx.reply('I could not make out that voice note. Try again, or type it?');
      return;
    }

    // Whisper bills the clip whether or not it contained speech, so record it before the empty
    // check. recordUsage also bumps the informational `turns` counter; accepted. A bookkeeping
    // failure must never fail the turn.
    try {
      await recordUsage(storeId, whisperCostMicroUsd(ctx.message.voice.duration));
    } catch (error) {
      console.error(redact({ scope: 'voice-usage', chatId: String(ctx.chat.id), error }));
    }

    if (!transcript) {
      await ctx.reply('That sounded empty — say it again?');
      return;
    }

    // Echo before acting. "Do" (2) and "das" (10) differ by one phoneme, and a misheard
    // quantity silently becomes a wrong bill. This does NOT wait for confirmation — it makes
    // the mistake visible in the same turn the money moves.
    await ctx.reply(`Heard: ${transcript}`);
    await handleTurn(ctx, transcript, { alreadyClaimed: true });
  });

  /**
   * Replaces grammY's default handler, which logs the error, calls bot.stop() and rethrows.
   * Keeping the bot alive matters more than surfacing the failure loudly, and the redactor is
   * what keeps ctx.api.token out of the log.
   */
  bot.catch((error) => {
    console.error(redact({ scope: 'bot', error }));
  });

  return bot;
}

export const bot = createBot(env.TELEGRAM_BOT_TOKEN);
