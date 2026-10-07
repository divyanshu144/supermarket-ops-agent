import { hasStore, isAuthorizedOwner, redeemInvite } from '../repositories/access.js';
import { createPendingAction } from '../repositories/confirmations.js';
import { previewCustomerPseudonymisation } from '../tools/privacy.js';
import { clearSession } from '../repositories/updates.js';
import { reseedStore } from '../seed/index.js';
import {
  INVALID_CODE,
  PRIVATE_MESSAGE,
  RESET_EXPLAINER,
  WELCOME,
  privacyMessage,
} from './messages.js';

/**
 * Command logic as plain functions. bot.ts only adapts grammY to these, so they can be
 * tested against the real database without a Telegram update in sight.
 */

export async function startCommand(
  chatId: bigint,
  arg: string,
  ownerUserId: bigint,
): Promise<string> {
  // Existing stores are usable only by the user who redeemed the invite. Legacy stores fail closed.
  if (await hasStore(chatId)) {
    return (await isAuthorizedOwner(chatId, ownerUserId)) ? WELCOME : PRIVATE_MESSAGE;
  }
  if (arg.trim() === '') return PRIVATE_MESSAGE;
  return (await redeemInvite(arg, chatId, ownerUserId)) === 'redeemed' ? WELCOME : INVALID_CODE;
}

export async function newCommand(chatId: bigint): Promise<string> {
  await clearSession(chatId);
  return 'Fresh chat. Your stock, khata and preferences are unchanged.';
}

export function privacyCommand(contact?: string, retentionDays = 30): string {
  return privacyMessage(contact, retentionDays);
}

export type CustomerPseudonymisationRequest =
  | { status: 'forbidden' }
  | { status: 'not_found' }
  | { status: 'cross_store_link' }
  | {
      status: 'awaiting_confirmation';
      callbackId: string;
      accounts: 1;
      bills: number;
      notes: number;
    };

export async function requestCustomerPseudonymisation(input: {
  storeId: bigint;
  ownerUserId: bigint;
  updateId: bigint;
  customerName: string;
}): Promise<CustomerPseudonymisationRequest> {
  if (!(await isAuthorizedOwner(input.storeId, input.ownerUserId))) return { status: 'forbidden' };
  const preview = await previewCustomerPseudonymisation(input.storeId, input.customerName);
  if (preview.status !== 'preview') return preview;
  const pending = await createPendingAction({
    storeId: input.storeId,
    ownerUserId: input.ownerUserId,
    originatingUpdateId: input.updateId,
    tool: 'pseudonymise_customer',
    arguments: { account_id: preview.accountId },
  });
  return {
    status: 'awaiting_confirmation',
    callbackId: pending.callbackId,
    accounts: preview.accounts,
    bills: preview.bills,
    notes: preview.notes,
  };
}

/** Destructive, so it takes an explicit second word. Anything else explains and does nothing. */
export async function resetCommand(chatId: bigint, arg: string): Promise<string> {
  if (arg.trim().toLowerCase() !== 'confirm') return RESET_EXPLAINER;
  await reseedStore(chatId);
  await clearSession(chatId);
  return 'Shop restored to its starting state.';
}
