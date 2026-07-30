/**
 * Integer division rounding half away from zero, for non-negative integers.
 *
 * Uses `floor((2n + d) / 2d)` rather than `Math.round(n / d)` so the arithmetic stays exact:
 * every intermediate is an integer well inside 2^53 for realistic paise values.
 */
export function divRoundHalfUp(numerator: number, denominator: number): number {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
    throw new Error(`divRoundHalfUp requires integer arguments, got ${numerator}/${denominator}`);
  }
  if (denominator <= 0) {
    throw new Error(`divRoundHalfUp requires a positive denominator, got ${denominator}`);
  }
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

/** Indian GST invoices show an explicit round-off line to the nearest rupee. */
export function roundToNearestRupee(paise: number): {
  totalPaise: number;
  roundOffPaise: number;
} {
  const totalPaise = divRoundHalfUp(paise, 100) * 100;
  return { totalPaise, roundOffPaise: totalPaise - paise };
}

/**
 * Formats paise as rupees.
 *
 * The sign is taken off before splitting, because both `Math.floor` and `%` misbehave on
 * negatives: a naive implementation renders -40050 as "₹-401.-50". Negative amounts are real
 * here — a customer who overpays their khata ends up in credit.
 */
export function formatPaise(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const absolute = Math.abs(paise);
  const rupees = Math.floor(absolute / 100);
  const remainder = String(absolute % 100).padStart(2, '0');
  return `${sign}₹${rupees}.${remainder}`;
}
