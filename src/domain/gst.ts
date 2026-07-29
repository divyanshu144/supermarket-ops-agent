import { divRoundHalfUp } from './money.js';
import { baseUnitsPerSellingUnit, type Unit } from './units.js';

export interface LineAmounts {
  lineTotalPaise: number;
  taxablePaise: number;
  gstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
}

/**
 * What the customer actually pays for this line.
 *
 * `mrpPaise` is the price per SELLING unit (per kg for loose goods, per packet for packaged);
 * `qtyBase` is in base units (grams). The division rounds half-up, once, at line level.
 */
export function lineTotalPaise(mrpPaise: number, qtyBase: number, unit: Unit): number {
  return divRoundHalfUp(mrpPaise * qtyBase, baseUnitsPerSellingUnit(unit));
}

/**
 * Back-calculates GST out of a tax-inclusive amount.
 *
 * MRP in India includes all taxes, so adding GST on top would charge above the printed price,
 * which is illegal. Given ₹62 at 12%: taxable ₹55.36, GST ₹6.64, customer pays ₹62.
 *
 * Odd paise in the CGST/SGST split go to SGST, so the two halves always sum to the whole.
 */
export function taxBreakdown(
  inclusivePaise: number,
  gstRateBps: number,
): Omit<LineAmounts, 'lineTotalPaise'> {
  if (gstRateBps === 0) {
    return { taxablePaise: inclusivePaise, gstPaise: 0, cgstPaise: 0, sgstPaise: 0 };
  }

  const taxablePaise = divRoundHalfUp(inclusivePaise * 10_000, 10_000 + gstRateBps);
  const gstPaise = inclusivePaise - taxablePaise;
  const cgstPaise = Math.floor(gstPaise / 2);

  return { taxablePaise, gstPaise, cgstPaise, sgstPaise: gstPaise - cgstPaise };
}

/**
 * Tax is derived from the line total, NEVER from per-unit tax multiplied by quantity.
 * The customer pays `MRP x qty` exactly, so the taxable value must come out of that figure.
 */
export function computeLine(input: {
  mrpPaise: number;
  qtyBase: number;
  unit: Unit;
  gstRateBps: number;
}): LineAmounts {
  const total = lineTotalPaise(input.mrpPaise, input.qtyBase, input.unit);
  return { lineTotalPaise: total, ...taxBreakdown(total, input.gstRateBps) };
}
