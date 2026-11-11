import { describe, expect, it } from 'vitest';
import { EvalBudget } from './budget.js';

describe('EvalBudget', () => {
  it('admits exactly the cap, charges unknown usage conservatively, and rejects further work', () => {
    const budget = new EvalBudget(10);
    const settle = budget.reserve(10);
    settle();
    expect(budget.snapshot()).toEqual({
      capMicroUsd: 10,
      spentMicroUsd: 10,
      reservedMicroUsd: 0,
      remainingMicroUsd: 0,
    });
    expect(() => budget.reserve(1)).toThrow('Eval budget exhausted');
  });

  it('rejects refunds and double settlement', () => {
    const budget = new EvalBudget(10);
    const settle = budget.reserve(10);
    expect(() => settle(-1)).toThrow('Invalid reservation settlement');
    settle(2);
    expect(() => settle(2)).toThrow('already settled');
    expect(budget.snapshot().spentMicroUsd).toBe(2);
  });

  it('records actual usage above its estimate while preserving the overall cap', () => {
    const budget = new EvalBudget(10);
    const settle = budget.reserve(4);
    settle(7);
    expect(budget.snapshot()).toEqual({
      capMicroUsd: 10,
      spentMicroUsd: 7,
      reservedMicroUsd: 0,
      remainingMicroUsd: 3,
    });
    expect(() => budget.reserve(4)).toThrow('Eval budget exhausted');
  });

  it('records an over-cap actual charge and blocks all further work', () => {
    const budget = new EvalBudget(10);
    const settle = budget.reserve(4);
    settle(11);
    expect(budget.snapshot()).toEqual({
      capMicroUsd: 10,
      spentMicroUsd: 11,
      reservedMicroUsd: 0,
      remainingMicroUsd: -1,
    });
    expect(() => budget.reserve(1)).toThrow('Eval budget exhausted');
  });
});
