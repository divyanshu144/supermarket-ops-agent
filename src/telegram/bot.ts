import { Bot, type CommandContext, type Context } from 'grammy';
import { loadEnv } from '../config/env.js';
import { downloadTelegramFile } from '../media/download.js';
import { transcribe } from '../media/transcribe.js';
import { provisionStore } from '../repositories/stores.js';
import { claimUpdate, clearSession } from '../repositories/updates.js';
import { reseedStore } from '../seed/index.js';
import { redact } from './redact.js';
import { handleTurn } from './turn.js';

const env = loadEnv();

export const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

const WELCOME = [
  'Namaste! I run your shop from this chat.',
  '',
  'Try: "how much sugar is left?", "50 packets of Maggi came in, cost ₹12, MRP ₹14",',
  '"make a bill: 2kg sugar, 4 Maggi, UPI", "what\'s running out?"',
  '',
  '/new — fresh conversation (your stock, khata and preferences stay)',
  '/reset — restore this shop to its starting state',
].join('\n');

/**
 * Wraps a command handler so a failure replies instead of propagating.
 *
 * Without this, an error inside provisionStore reaches grammY's default handler, which calls
 * bot.stop() — a single database blip would take the bot down mid-review.
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

bot.command(
  'start',
  guarded(async (ctx) => {
    await provisionStore(BigInt(ctx.chat.id));
    await ctx.reply(WELCOME);
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
    const storeId = BigInt(ctx.chat.id);
    await provisionStore(storeId);
    await clearSession(storeId);
    await ctx.reply('Fresh chat. Your stock, khata and preferences are unchanged.');
  }),
);

bot.command(
  'reset',
  guarded(async (ctx) => {
    const storeId = BigInt(ctx.chat.id);
    await provisionStore(storeId);
    await reseedStore(storeId);
    await clearSession(storeId);
    await ctx.reply('Shop restored to its starting state.');
  }),
);

bot.on('message:text', async (ctx) => {
  await handleTurn(ctx, ctx.message.text);
});

/** Voice notes are ~60s of Opus at most; anything longer is a mis-tap, not a shop instruction. */
const MAX_VOICE_SECONDS = 60;

bot.on('message:voice', async (ctx) => {
  // Guard on the metadata Telegram already sent, before spending a download.
  if (ctx.message.voice.duration > MAX_VOICE_SECONDS) {
    await ctx.reply(`That is a long one — keep voice notes under ${MAX_VOICE_SECONDS} seconds.`);
    return;
  }

  // Claim before spending anything, not after. handleTurn's own claim runs too late for voice:
  // by the time it would run, the file is already downloaded and the Whisper call already paid
  // for. A genuine redelivery (the crash-mid-turn case claimUpdate exists for) must not repeat
  // either of those, so this handler claims the update itself and hands the result down.
  const updateId = BigInt(ctx.update.update_id);
  const storeId = BigInt(ctx.chat.id);
  const claim = await claimUpdate(updateId, storeId);
  if (claim === 'duplicate') return;

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

  // Echo before acting. "Do" (2) and "das" (10) differ by one phoneme, and a misheard quantity
  // silently becomes a wrong bill. This does NOT wait for confirmation — it makes the mistake
  // visible in the same turn the money moves.
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
