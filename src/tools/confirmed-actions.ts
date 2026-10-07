import { z } from 'zod';
import { getBill, finalizeBill, voidBill } from '../repositories/bills.js';
import {
  cancelPendingAction,
  claimPendingAction,
  completePendingAction,
  hashActionArguments,
  hashBillSnapshot,
  rejectPendingAction,
} from '../repositories/confirmations.js';
import { settleAccount } from '../repositories/khata.js';

const FinalizeArgs = z
  .object({
    bill_id: z.string().uuid(),
    payment_mode: z.enum(['cash', 'upi', 'card', 'khata']),
    payment_ref: z.string().optional(),
    customer_name: z.string().optional(),
    allow_below_cost: z.boolean().optional(),
  })
  .strict();
const VoidArgs = z.object({ bill_id: z.string().uuid() }).strict();
const SettleArgs = z
  .object({
    customer: z.string().min(1),
    amount_paise: z.number().int().positive(),
    note: z.string().optional(),
    allow_overpay: z.boolean().optional(),
  })
  .strict();

export type ConfirmationResult =
  | { status: 'confirmed'; outcome: string }
  | { status: 'cancelled' }
  | { status: 'stale_bill' }
  | { status: 'unavailable' }
  | { status: 'failed' };

/** Model-free action path, called only by the Telegram callback adapter after owner validation. */
export async function handleConfirmation(input: {
  decision: 'confirm' | 'cancel';
  callbackId: string;
  storeId: bigint;
  ownerUserId: bigint;
  updateId: bigint;
}): Promise<ConfirmationResult> {
  if (input.decision === 'cancel') {
    const cancelled = await cancelPendingAction(input);
    return cancelled ? { status: 'cancelled' } : { status: 'unavailable' };
  }

  const pending = await claimPendingAction(input);
  if (!pending) return { status: 'unavailable' };

  if (hashActionArguments(pending.arguments) !== pending.argumentHash) {
    await rejectPendingAction({
      id: pending.id,
      storeId: input.storeId,
      updateId: input.updateId,
      tool: pending.tool,
      action: 'invalid_pending_action',
      outcome: 'argument_hash_mismatch',
    });
    return { status: 'failed' };
  }

  if (pending.billFingerprint) {
    const parsed = z
      .object({ bill_id: z.string().uuid() })
      .passthrough()
      .safeParse(pending.arguments);
    const current = parsed.success ? await getBill(input.storeId, parsed.data.bill_id) : null;
    const currentFingerprint = current
      ? hashBillSnapshot(
          current.items.map((line) => ({
            lineNo: line.lineNo,
            productId: line.productId,
            qtyBase: line.qtyBase,
            unitPricePaise: line.unitPricePaise,
            gstRateBps: line.gstRateBps,
            hsnCode: line.hsnCode,
          })),
        )
      : null;
    if (currentFingerprint !== pending.billFingerprint) {
      await rejectPendingAction({
        id: pending.id,
        storeId: input.storeId,
        updateId: input.updateId,
        tool: pending.tool,
        action: 'stale_bill_confirmation',
        outcome: 'stale_bill',
      });
      return { status: 'stale_bill' };
    }
  }

  let outcome: string;
  if (pending.tool === 'finalize_bill') {
    const parsed = FinalizeArgs.safeParse(pending.arguments);
    if (!parsed.success) {
      await rejectPendingAction({
        id: pending.id,
        storeId: input.storeId,
        updateId: input.updateId,
        tool: pending.tool,
        action: 'invalid_pending_action',
        outcome: 'invalid_arguments',
      });
      return { status: 'failed' };
    }
    const result = await finalizeBill(input.storeId, {
      billId: parsed.data.bill_id,
      paymentMode: parsed.data.payment_mode,
      paymentRef: parsed.data.payment_ref,
      customerName: parsed.data.customer_name,
      allowBelowCost: true,
      expectedBillFingerprint: pending.billFingerprint ?? undefined,
    });
    outcome = result.status;
  } else if (pending.tool === 'void_bill') {
    const parsed = VoidArgs.safeParse(pending.arguments);
    if (!parsed.success) {
      await rejectPendingAction({
        id: pending.id,
        storeId: input.storeId,
        updateId: input.updateId,
        tool: pending.tool,
        action: 'invalid_pending_action',
        outcome: 'invalid_arguments',
      });
      return { status: 'failed' };
    }
    outcome = (
      await voidBill(input.storeId, parsed.data.bill_id, pending.billFingerprint ?? undefined)
    ).status;
  } else if (pending.tool === 'settle_khata') {
    const parsed = SettleArgs.safeParse(pending.arguments);
    if (!parsed.success) {
      await rejectPendingAction({
        id: pending.id,
        storeId: input.storeId,
        updateId: input.updateId,
        tool: pending.tool,
        action: 'invalid_pending_action',
        outcome: 'invalid_arguments',
      });
      return { status: 'failed' };
    }
    const result = await settleAccount(input.storeId, {
      customerQuery: parsed.data.customer,
      amountPaise: parsed.data.amount_paise,
      note: parsed.data.note,
      allowOverpay: true,
      idempotencyKey: `pending-action:${pending.id}`,
    });
    outcome = result.status;
  } else {
    await rejectPendingAction({
      id: pending.id,
      storeId: input.storeId,
      updateId: input.updateId,
      tool: pending.tool,
      action: 'unsupported_pending_action',
      outcome: 'unsupported_tool',
    });
    return { status: 'failed' };
  }

  if (outcome === 'stale_confirmation') {
    await rejectPendingAction({
      id: pending.id,
      storeId: input.storeId,
      updateId: input.updateId,
      tool: pending.tool,
      action: 'stale_bill_confirmation',
      outcome,
    });
    return { status: 'stale_bill' };
  }

  const completed = await completePendingAction({
    id: pending.id,
    storeId: input.storeId,
    updateId: input.updateId,
    tool: pending.tool,
    action: pending.tool,
    outcome,
  });
  return completed ? { status: 'confirmed', outcome } : { status: 'unavailable' };
}
