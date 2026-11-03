import { findStock } from '../repositories/products.js';
export const MAX_DISCOUNT_PERCENT = 20;
/** Check against current catalogue again when the owner confirms. */
export async function validateMoneyArguments(
  storeId: bigint,
  name: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  if (name !== 'add_bill_item' || args.unit_price_override === undefined) return null;
  const stock = await findStock(storeId, String(args.product_query));
  if (stock.status !== 'found') return 'product_unresolved';
  const price = args.unit_price_override;
  if (typeof price !== 'number' || !Number.isSafeInteger(price) || price < 0)
    return 'invalid_price';
  if (price > stock.product.mrpPaise) return 'above_mrp';
  if (price * 100 < stock.product.mrpPaise * (100 - MAX_DISCOUNT_PERCENT)) return 'discount_cap';
  return null;
}
