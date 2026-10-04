import type { Context, NextFunction } from 'grammy';
import { hasStore } from '../repositories/access.js';
import { PRIVATE_MESSAGE } from './messages.js';

/** True for `/start` and `/start@botname …` — the one command a stranger may send. */
export function isStartCommand(text: string | undefined): boolean {
  if (!text) return false;
  const first = text.trim().split(/\s+/)[0] ?? '';
  return first.split('@')[0] === '/start';
}

/**
 * Authorization, not intent routing: does this chat own a store, and if not, is it asking to
 * redeem a code? Nothing here looks at what the owner is trying to do with the shop.
 */
export function decideAccess(input: {
  hasStore: boolean;
  text: string | undefined;
}): 'allow' | 'deny' {
  if (input.hasStore) return 'allow';
  return isStartCommand(input.text) ? 'allow' : 'deny';
}

/** First middleware on the bot. A denied chat gets one fixed reply and costs nothing. */
export async function accessGate(ctx: Context, next: NextFunction): Promise<void> {
  if (!ctx.chat) return;
  const decision = decideAccess({
    hasStore: await hasStore(BigInt(ctx.chat.id)),
    text: ctx.message?.text,
  });
  if (decision === 'allow') return next();
  await ctx.reply(PRIVATE_MESSAGE);
}
