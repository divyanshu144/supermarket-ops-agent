import { describe, expect, expectTypeOf, it } from 'vitest';
import { paymentDecision } from './khata-payment-decision.js';

describe('identity-free khata payment rule', () => {
  it('accepts a payment within balance and requires confirmation for overpayment', () => {
    expect(paymentDecision({ balancePaise: 5000, amountPaise: 3000, allowOverpay: false })).toBe(
      'settle',
    );
    expect(paymentDecision({ balancePaise: 5000, amountPaise: 6000, allowOverpay: false })).toBe(
      'confirm_overpayment',
    );
    expect(paymentDecision({ balancePaise: 5000, amountPaise: 6000, allowOverpay: true })).toBe(
      'settle',
    );
  });

  it('keeps customer identity out of the decision input type', () => {
    expectTypeOf<Parameters<typeof paymentDecision>[0]>().toEqualTypeOf<{
      balancePaise: number;
      amountPaise: number;
      allowOverpay: boolean;
    }>();
  });
});
