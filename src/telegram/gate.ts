import type { Context, NextFunction } from 'grammy';
import { getStoreOwnerId } from '../repositories/access.js';
import { markGeneratedArtifactsActive } from '../repositories/artifacts.js';
import { PRIVATE_MESSAGE } from './messages.js';

/**
 * Authorization, not intent routing: does this chat own a store, and if not, is it asking to
 * redeem a code? Nothing here looks at what the owner is trying to do with the shop.
 */
export function decideAccess(input: {
  hasStore: boolean;
  isStartCommand: boolean;
}): 'allow' | 'deny' {
  if (input.hasStore) return 'allow';
  return input.isStartCommand ? 'allow' : 'deny';
}

/**
 * First middleware on the bot. A denied chat gets one fixed reply and costs nothing.
 *
 * "Is this /start" is grammY's own matcher — the exact logic `bot.command('start')` uses — so the
 * gate and the command handler agree by construction: nothing the gate lets through as /start can
 * fall past the handler into the agent.
 */
export async function accessGate(ctx: Context, next: NextFunction): Promise<void> {
  if (!ctx.chat) return;
  if (ctx.chat.type !== 'private') {
    if (ctx.message) await ctx.reply(PRIVATE_MESSAGE);
    else if (ctx.callbackQuery)
      await ctx.answerCallbackQuery({ text: PRIVATE_MESSAGE, show_alert: true });
    return;
  }
  const ownerUserId = await getStoreOwnerId(BigInt(ctx.chat.id));
  const decision = decideAccess({
    hasStore: ownerUserId !== null && ownerUserId === BigInt(ctx.from?.id ?? 0),
    isStartCommand: ctx.hasCommand('start'),
  });
  if (decision === 'allow') {
    if (ownerUserId !== null && ownerUserId === BigInt(ctx.from?.id ?? 0)) {
      await markGeneratedArtifactsActive(BigInt(ctx.chat.id));
    }
    return next();
  }
  // Fail closed for every update type; only answer an actual message.
  if (ctx.message) await ctx.reply(PRIVATE_MESSAGE);
  else if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: PRIVATE_MESSAGE, show_alert: true });
  }
}
