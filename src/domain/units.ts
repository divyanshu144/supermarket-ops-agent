export type Unit = 'kg' | 'g' | 'litre' | 'ml' | 'packet' | 'dozen' | 'piece';

const BASE_PER_SELLING: Record<Unit, number> = {
  kg: 1000,
  g: 1,
  litre: 1000,
  ml: 1,
  packet: 1,
  dozen: 12,
  piece: 1,
};

const DISCRETE: ReadonlySet<Unit> = new Set<Unit>(['packet', 'dozen', 'piece']);

export function baseUnitsPerSellingUnit(unit: Unit): number {
  return BASE_PER_SELLING[unit];
}

/** Converts a human quantity into integer base units. 2.5 kg → 2500. */
export function toBaseUnits(qty: number, unit: Unit): number {
  if (qty < 0) throw new Error(`Quantity cannot be negative: ${qty}`);
  if (DISCRETE.has(unit) && !Number.isInteger(qty)) {
    throw new Error(`${unit} must be a whole number, got ${qty}`);
  }

  const exact = qty * BASE_PER_SELLING[unit];
  const rounded = Math.round(exact);
  if (Math.abs(exact - rounded) > 1e-6) {
    throw new Error(`Quantity ${qty} ${unit} is below the precision of one base unit`);
  }
  return rounded;
}

export function formatQuantity(qtyBase: number, unit: Unit): string {
  const per = BASE_PER_SELLING[unit];
  const value = qtyBase / per;
  const text = Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
  return `${text} ${unit}`;
}
