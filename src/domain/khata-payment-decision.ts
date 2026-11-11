export interface KhataPaymentDecisionInput {
  balancePaise: number;
  amountPaise: number;
  allowOverpay: boolean;
}

/** Pure business decision: customer identity is intentionally absent from the input. */
export function paymentDecision(
  input: KhataPaymentDecisionInput,
): 'settle' | 'confirm_overpayment' {
  return !input.allowOverpay && input.amountPaise > input.balancePaise
    ? 'confirm_overpayment'
    : 'settle';
}
