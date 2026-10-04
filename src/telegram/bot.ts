import { Bot, type CommandContext, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { loadEnv } from '../config/env.js';
import { downloadTelegramFile } from '../media/download.js';
import { transcribe } from '../media/transcribe.js';
import { claimUpdate, completeUpdate } from '../repositories/updates.js';
import { newCommand, resetCommand, startCommand } from './commands.js';
import { accessGate } from './gate.js';
import { RATE_LIMITED_REPLY, WELCOME } from './messages.js';
import { turnLimiter } from './rate-limit.js';
import { redact } from './redact.js';
import { handleTurn } from './turn.js';

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

  // First: nothing below runs for a chat that has no store and is not redeeming a code.
  bot.use(accessGate);

  bot.command(
    'start',
    guarded(async (ctx) => {
      await ctx.reply(await startCommand(BigInt(ctx.chat.id), argOf(ctx)));
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
