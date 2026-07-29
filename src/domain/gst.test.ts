import { describe, expect, it } from 'vitest';
import { computeLine, lineTotalPaise, taxBreakdown } from './gst.js';

describe('lineTotalPaise', () => {
  it('multiplies a packaged item by whole packets', () => {
    expect(lineTotalPaise(1400, 4, 'packet')).toBe(5600);
  });

  it('divides correctly for loose goods priced per kg', () => {
    // 2.5 kg of sugar at ₹52/kg
    expect(lineTotalPaise(5200, 2500, 'kg')).toBe(13000);
  });

  it('rounds the loose-goods division half-up, once', () => {
    // 333 g at ₹47/kg = 1565.1 paise → 1565
    expect(lineTotalPaise(4700, 333, 'kg')).toBe(1565);
  });

  it('rounds a true half upward', () => {
    // 500 g at ₹47.01/kg = 2350.5 paise → 2351
    expect(lineTotalPaise(4701, 500, 'kg')).toBe(2351);
  });
});

describe('taxBreakdown', () => {
  it('back-calculates GST out of a tax-inclusive MRP', () => {
    // Amul Butter 100g, MRP ₹62, 12%. The customer pays ₹62, never ₹69.44.
    const r = taxBreakdown(6200, 1200);
    expect(r.taxablePaise).toBe(5536);
    expect(r.gstPaise).toBe(664);
    expect(r.taxablePaise + r.gstPaise).toBe(6200);
  });

  it('gives odd paise to SGST so the halves always sum to the whole', () => {
    const even = taxBreakdown(6200, 1200);
    expect(even.cgstPaise + even.sgstPaise).toBe(even.gstPaise);

    const odd = taxBreakdown(2100, 500);
    expect(odd.cgstPaise + odd.sgstPaise).toBe(odd.gstPaise);
    expect(odd.sgstPaise - odd.cgstPaise).toBeLessThanOrEqual(1);
    expect(odd.sgstPaise).toBeGreaterThanOrEqual(odd.cgstPaise);
  });

  it('treats a 0% item as fully taxable with no GST', () => {
    expect(taxBreakdown(13000, 0)).toEqual({
      taxablePaise: 13000,
      gstPaise: 0,
      cgstPaise: 0,
      sgstPaise: 0,
    });
  });

  it('never charges the customer more than the inclusive price', () => {
    for (const rate of [0, 500, 1200, 1800]) {
      for (const amount of [1, 99, 100, 1400, 6200, 26000, 155000]) {
        const r = taxBreakdown(amount, rate);
        expect(r.taxablePaise + r.gstPaise).toBe(amount);
      }
    }
  });
});

describe('computeLine — order of operations', () => {
  it('derives tax from the LINE TOTAL, not per-unit tax times quantity', () => {
    // 4 x Maggi 70g, MRP ₹14, 5%.
    // Per-unit-first: round(1400 * 10000/10500) = 1333, x4 = 5332 taxable.
    // Line-total-first: round(5600 * 10000/10500) = 5333 taxable.
    // Line-total-first is correct: the customer pays exactly 4 x ₹14 = ₹56.00.
    const line = computeLine({ mrpPaise: 1400, qtyBase: 4, unit: 'packet', gstRateBps: 500 });

    expect(line.lineTotalPaise).toBe(5600);
    expect(line.taxablePaise).toBe(5333);
    expect(line.taxablePaise).not.toBe(5332);
    expect(line.gstPaise).toBe(267);
    expect(line.taxablePaise + line.gstPaise).toBe(line.lineTotalPaise);
  });

  it('never lets the parts drift from the whole across many rates and quantities', () => {
    for (const gstRateBps of [0, 500, 1200, 1800]) {
      for (const qty of [1, 2, 3, 7, 13]) {
        for (const mrp of [499, 1400, 2800, 6200, 26000]) {
          const l = computeLine({ mrpPaise: mrp, qtyBase: qty, unit: 'packet', gstRateBps });
          expect(l.taxablePaise + l.gstPaise).toBe(l.lineTotalPaise);
          expect(l.cgstPaise + l.sgstPaise).toBe(l.gstPaise);
        }
      }
    }
  });

  it('handles loose goods end to end', () => {
    // 2.5 kg loose sugar at ₹52/kg, 0% GST.
    const l = computeLine({ mrpPaise: 5200, qtyBase: 2500, unit: 'kg', gstRateBps: 0 });
    expect(l.lineTotalPaise).toBe(13000);
    expect(l.taxablePaise).toBe(13000);
    expect(l.gstPaise).toBe(0);
  });
});
