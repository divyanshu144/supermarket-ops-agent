import { getBill } from '../repositories/bills.js';
import { createPendingAction, hashBillSnapshot } from '../repositories/confirmations.js';
import { requireContext } from './context.js';

export async function proposeConfirmation(input: {
  tool: string;
  action: string;
  arguments: Record<string, unknown>;
  billId?: string;
  billFingerprint?: string;
}): Promise<{ status: 'awaiting_confirmation'; action: string }> {
  const context = requireContext();
  if (!context.ownerUserId) {
    throw new Error('Owner identity is required to request a confirmation.');
  }
  let billFingerprint = input.billFingerprint;
  if (input.billId && !billFingerprint) {
    const bill = await getBill(context.storeId, input.billId);
    if (!bill) throw new Error('The bill is no longer available for confirmation.');
    billFingerprint = hashBillSnapshot(
      bill.items.map((line) => ({
        lineNo: line.lineNo,
        productId: line.productId,
        qtyBase: line.qtyBase,
        unitPricePaise: line.unitPricePaise,
        gstRateBps: line.gstRateBps,
        hsnCode: line.hsnCode,
      })),
    );
  }
  const pending = await createPendingAction({
    storeId: context.storeId,
    ownerUserId: context.ownerUserId,
    originatingUpdateId: context.updateId,
    tool: input.tool,
    arguments: input.arguments,
    billFingerprint,
  });
  context.pendingConfirmations.push({ callbackId: pending.callbackId, action: input.action });
  return { status: 'awaiting_confirmation', action: input.action };
}
