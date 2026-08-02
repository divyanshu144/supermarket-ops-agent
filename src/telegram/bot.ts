import { Bot, type CommandContext, type Context } from 'grammy';
import { loadEnv } from '../config/env.js';
import { provisionStore } from '../repositories/stores.js';
import { clearSession } from '../repositories/updates.js';
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

/**
 * Replaces grammY's default handler, which logs the error, calls bot.stop() and rethrows.
 * Keeping the bot alive matters more than surfacing the failure loudly, and the redactor is
 * what keeps ctx.api.token out of the log.
 */
bot.catch((error) => {
  console.error(redact({ scope: 'bot', error }));
});
