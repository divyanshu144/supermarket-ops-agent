import { Bot } from 'grammy';
import { loadEnv } from '../config/env.js';
import { runAgent } from '../agent/runtime.js';
import { provisionStore } from '../repositories/stores.js';
import {
  claimUpdate,
  clearSession,
  completeUpdate,
  getSessionId,
  setSessionId,
} from '../repositories/updates.js';
import { reseedStore } from '../seed/index.js';
import { IdempotencyIssuer, toolContext } from '../tools/context.js';

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

bot.command('start', async (ctx) => {
  await provisionStore(BigInt(ctx.chat.id));
  await ctx.reply(WELCOME);
});

bot.command('help', async (ctx) => {
  await ctx.reply(WELCOME);
});

bot.command('new', async (ctx) => {
  const storeId = BigInt(ctx.chat.id);
  await provisionStore(storeId);
  await clearSession(storeId);
  await ctx.reply('Fresh chat. Your stock, khata and preferences are unchanged.');
});

bot.command('reset', async (ctx) => {
  const storeId = BigInt(ctx.chat.id);
  await provisionStore(storeId);
  await reseedStore(storeId);
  await clearSession(storeId);
  await ctx.reply('Shop restored to its starting state.');
});

bot.on('message:text', async (ctx) => {
  const updateId = BigInt(ctx.update.update_id);
  const storeId = BigInt(ctx.chat.id);

  // Claim, don't mark done. See repositories/updates.ts for why the difference matters.
  const claim = await claimUpdate(updateId, storeId);
  if (claim === 'duplicate') return;

  await provisionStore(storeId);
  await ctx.replyWithChatAction('typing');

  try {
    const sessionId = await getSessionId(storeId);

    const result = await toolContext.run(
      { storeId, updateId, idempotency: new IdempotencyIssuer(updateId) },
      () => runAgent({ text: ctx.message.text, sessionId }),
    );

    if (result.sessionId) await setSessionId(storeId, result.sessionId);
    await ctx.reply(result.reply || 'Sorry, I could not work that out.');
    await completeUpdate(updateId);
  } catch (error) {
    console.error({ updateId: String(updateId), storeId: String(storeId), error });
    await ctx.reply('Something went wrong on my side. Try that again?');
    // Deliberately NOT completed: the claim goes stale and a retry can reprocess it.
  }
});
