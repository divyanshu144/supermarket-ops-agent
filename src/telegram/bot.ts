import { Bot, type CommandContext, type Context } from 'grammy';
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
import { readPreferences } from '../tools/preferences.js';
import { InputFile } from 'grammy';
import { newToolContext, toolContext } from '../tools/context.js';
import { redact } from './redact.js';

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
  const updateId = BigInt(ctx.update.update_id);
  const storeId = BigInt(ctx.chat.id);

  // Claim, don't mark done. See repositories/updates.ts for why the difference matters.
  const claim = await claimUpdate(updateId, storeId);
  if (claim === 'duplicate') return;

  await provisionStore(storeId);
  await ctx.replyWithChatAction('typing');

  try {
    const sessionId = await getSessionId(storeId);
    const preferences = await readPreferences(storeId);

    const turnContext = newToolContext(storeId, updateId);
    const result = await toolContext.run(turnContext, () =>
      runAgent({ text: ctx.message.text, sessionId, preferences }),
    );

    if (result.sessionId) await setSessionId(storeId, result.sessionId);
    await ctx.reply(result.reply || 'Sorry, I could not work that out.');

    // Files the tools produced this turn go out after the reply, so the owner reads the answer
    // first and the document lands underneath it.
    for (const artifact of turnContext.artifacts) {
      await ctx.replyWithDocument(new InputFile(artifact.path, artifact.filename));
    }

    await completeUpdate(updateId);
  } catch (error) {
    console.error(redact({ updateId: String(updateId), storeId: String(storeId), error }));
    await ctx.reply('Something went wrong on my side. Try that again?');
    // Deliberately NOT completed: the claim goes stale and a retry can reprocess it.
  }
});

/**
 * Replaces grammY's default handler, which logs the error, calls bot.stop() and rethrows.
 * Keeping the bot alive matters more than surfacing the failure loudly, and the redactor is
 * what keeps ctx.api.token out of the log.
 */
bot.catch((error) => {
  console.error(redact({ scope: 'bot', error }));
});
