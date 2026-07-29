import { describe, expect, it } from 'vitest';
import { baseUnitsPerSellingUnit, formatQuantity, toBaseUnits } from './units.js';

describe('toBaseUnits', () => {
  it.each([
    [2.5, 'kg', 2500],
    [500, 'g', 500],
    [1, 'litre', 1000],
    [750, 'ml', 750],
    [4, 'packet', 4],
    [2, 'dozen', 24],
    [3, 'piece', 3],
  ] as const)('toBaseUnits(%s, %s) === %i', (qty, unit, expected) => {
    expect(toBaseUnits(qty, unit)).toBe(expected);
  });

  it('always returns an integer', () => {
    for (const qty of [0.25, 1.125, 2.5, 10]) {
      expect(Number.isInteger(toBaseUnits(qty, 'kg'))).toBe(true);
    }
  });

  it('rejects a fractional quantity for a discrete unit', () => {
    expect(() => toBaseUnits(1.5, 'packet')).toThrow(/whole/);
  });

  it('rejects a quantity finer than one base unit', () => {
    expect(() => toBaseUnits(0.0001, 'kg')).toThrow(/precision/);
  });

  it('rejects a negative quantity', () => {
    expect(() => toBaseUnits(-1, 'kg')).toThrow(/negative/);
  });
});

describe('baseUnitsPerSellingUnit', () => {
  it.each([
    ['kg', 1000],
    ['g', 1],
    ['litre', 1000],
    ['ml', 1],
    ['packet', 1],
    ['dozen', 12],
    ['piece', 1],
  ] as const)('%s → %i', (unit, expected) => {
    expect(baseUnitsPerSellingUnit(unit)).toBe(expected);
  });
});

describe('formatQuantity', () => {
  it.each([
    [2500, 'kg', '2.5 kg'],
    [18000, 'kg', '18 kg'],
    [500, 'g', '500 g'],
    [4, 'packet', '4 packet'],
  ] as const)('formatQuantity(%i, %s) === %s', (qty, unit, expected) => {
    expect(formatQuantity(qty, unit)).toBe(expected);
  });

  it('round-trips through toBaseUnits', () => {
    expect(formatQuantity(toBaseUnits(2.5, 'kg'), 'kg')).toBe('2.5 kg');
  });
});
