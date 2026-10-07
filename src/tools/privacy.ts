import { z } from 'zod';
import {
  previewCustomerPseudonymisation as previewCustomerRecords,
  pseudonymiseCustomerAccount,
} from '../repositories/privacy.js';

/** The confirmed operation is bound to an account identifier, never a free-form customer name. */
export const pseudonymiseCustomerArgsSchema = z.object({ account_id: z.string().uuid() }).strict();

export function previewCustomerPseudonymisation(storeId: bigint, customerName: string) {
  return previewCustomerRecords(storeId, customerName);
}

export function applyCustomerPseudonymisation(storeId: bigint, accountId: string) {
  return pseudonymiseCustomerAccount(storeId, accountId);
}
