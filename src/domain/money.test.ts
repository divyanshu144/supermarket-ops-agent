import { describe, expect, it } from 'vitest';
import { divRoundHalfUp, formatPaise, roundToNearestRupee } from './money.js';

describe('divRoundHalfUp', () => {
  it.each([
    [10, 4, 3], // 2.5 → 3, half rounds up
    [11, 4, 3], // 2.75 → 3
    [9, 4, 2], // 2.25 → 2
    [7, 2, 4], // 3.5 → 4
    [5, 1, 5],
    [0, 7, 0],
  ])('divRoundHalfUp(%i, %i) === %i', (n, d, expected) => {
    expect(divRoundHalfUp(n, d)).toBe(expected);
  });

  it('stays exact at magnitudes where float division would drift', () => {
    // 999_999_999 paise ≈ ₹10 million. Well inside 2^53 with the doubling.
    expect(divRoundHalfUp(999_999_999 * 10_000, 10_500)).toBe(952_380_951);
  });

  it('rejects non-integer input rather than silently producing float error', () => {
    expect(() => divRoundHalfUp(1.5, 2)).toThrow(/integer/);
  });

  it('rejects a zero denominator', () => {
    expect(() => divRoundHalfUp(1, 0)).toThrow(/denominator/);
  });
});

describe('roundToNearestRupee', () => {
  it.each([
    [12345, 12300, -45],
    [12355, 12400, 45],
    [12350, 12400, 50],
    [12300, 12300, 0],
  ])('roundToNearestRupee(%i) → total %i, roundOff %i', (input, total, roundOff) => {
    expect(roundToNearestRupee(input)).toEqual({ totalPaise: total, roundOffPaise: roundOff });
  });

  it('always yields a total divisible by 100', () => {
    for (let p = 0; p < 500; p++) {
      expect(roundToNearestRupee(p).totalPaise % 100).toBe(0);
    }
  });
});

describe('formatPaise', () => {
  it.each([
    [12345, '₹123.45'],
    [100, '₹1.00'],
    [5, '₹0.05'],
    [0, '₹0.00'],
  ])('formatPaise(%i) === %s', (paise, expected) => {
    expect(formatPaise(paise)).toBe(expected);
  });
});
