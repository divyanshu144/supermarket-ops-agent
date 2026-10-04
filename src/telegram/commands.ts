import { hasStore, redeemInvite } from '../repositories/access.js';
import { clearSession } from '../repositories/updates.js';
import { reseedStore } from '../seed/index.js';
import { INVALID_CODE, PRIVATE_MESSAGE, RESET_EXPLAINER, WELCOME } from './messages.js';

/**
 * Command logic as plain functions. bot.ts only adapts grammY to these, so they can be
 * tested against the real database without a Telegram update in sight.
 */

export async function startCommand(chatId: bigint, arg: string): Promise<string> {
  // An existing owner never spends a code, whatever they typed after /start.
  if (await hasStore(chatId)) return WELCOME;
  if (arg.trim() === '') return PRIVATE_MESSAGE;
  return (await redeemInvite(arg, chatId)) === 'redeemed' ? WELCOME : INVALID_CODE;
}

export async function newCommand(chatId: bigint): Promise<string> {
  await clearSession(chatId);
  return 'Fresh chat. Your stock, khata and preferences are unchanged.';
}

/** Destructive, so it takes an explicit second word. Anything else explains and does nothing. */
export async function resetCommand(chatId: bigint, arg: string): Promise<string> {
  if (arg.trim().toLowerCase() !== 'confirm') return RESET_EXPLAINER;
  await reseedStore(chatId);
  await clearSession(chatId);
  return 'Shop restored to its starting state.';
}
