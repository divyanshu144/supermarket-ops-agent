import { and, eq, ilike, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { products } from '../db/schema.js';

export type ProductRow = typeof products.$inferSelect;
export type ProductSummary = Pick<ProductRow, 'id' | 'name' | 'brand' | 'packSize'>;

/**
 * Ambiguity is returned as data, not resolved here.
 *
 * "atta" legitimately matches both Aashirvaad Atta 5kg and loose atta. The repository hands
 * back the candidates; the *model* decides to ask which one the owner meant. That is the
 * difference between a clarifying question and a hardcoded branch.
 */
export type StockResult =
  | { status: 'found'; product: ProductRow }
  | { status: 'ambiguous'; candidates: ProductSummary[] }
  | { status: 'not_found'; query: string };

export async function findStock(storeId: bigint, query: string): Promise<StockResult> {
  const term = `%${query.trim()}%`;

  const rows = await db
    .select()
    .from(products)
    .where(
      and(
        eq(products.storeId, storeId),
        or(ilike(products.name, term), ilike(products.brand, term)),
      ),
    )
    .limit(10);

  if (rows.length === 0) return { status: 'not_found', query };
  if (rows.length === 1) return { status: 'found', product: rows[0]! };

  return {
    status: 'ambiguous',
    candidates: rows.map((r) => ({
      id: r.id,
      name: r.name,
      brand: r.brand,
      packSize: r.packSize,
    })),
  };
}
