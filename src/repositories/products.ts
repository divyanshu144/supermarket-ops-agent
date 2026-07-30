import { and, eq, gte, ilike, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { products, stockMovements } from '../db/schema.js';
import { formatQuantity, toBaseUnits, type Unit } from '../domain/units.js';

/** Which physical dimension a unit measures. Grams cannot be received as packets. */
const DIMENSION: Record<Unit, 'mass' | 'volume' | 'count'> = {
  kg: 'mass',
  g: 'mass',
  litre: 'volume',
  ml: 'volume',
  packet: 'count',
  dozen: 'count',
  piece: 'count',
};

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

export type ReceiveResult =
  | { status: 'received'; name: string; newQuantity: string; unit: Unit }
  | { status: 'ambiguous'; candidates: ProductSummary[] }
  | { status: 'not_found'; query: string }
  | { status: 'invalid_quantity'; reason: string };

/**
 * Books stock in. Prices are updated only when the owner states them — a receive that omits
 * them must not silently reset the shelf price.
 */
export async function receiveStock(
  storeId: bigint,
  input: {
    productQuery: string;
    qty: number;
    unit: Unit;
    costPricePaise?: number;
    mrpPaise?: number;
  },
): Promise<ReceiveResult> {
  const found = await findStock(storeId, input.productQuery);
  if (found.status !== 'found') return found;

  const product = found.product;
  if (DIMENSION[input.unit] !== DIMENSION[product.unit as Unit]) {
    return {
      status: 'invalid_quantity',
      reason: `${product.name} is stocked by ${product.unit}, so it cannot be received in ${input.unit}.`,
    };
  }

  let qtyBase: number;
  try {
    qtyBase = toBaseUnits(input.qty, input.unit);
  } catch (error) {
    return { status: 'invalid_quantity', reason: (error as Error).message };
  }
  if (qtyBase <= 0) {
    return { status: 'invalid_quantity', reason: 'Received quantity must be greater than zero.' };
  }

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(products)
      .set({
        quantityBase: sql`${products.quantityBase} + ${qtyBase}`,
        ...(input.costPricePaise !== undefined ? { costPricePaise: input.costPricePaise } : {}),
        ...(input.mrpPaise !== undefined ? { mrpPaise: input.mrpPaise } : {}),
      })
      .where(and(eq(products.id, product.id), eq(products.storeId, storeId)))
      .returning();

    await tx.insert(stockMovements).values({
      storeId,
      productId: product.id,
      kind: 'receive',
      qtyBaseDelta: qtyBase,
      unitCostPaise: input.costPricePaise ?? null,
    });

    return {
      status: 'received' as const,
      name: updated!.name,
      newQuantity: formatQuantity(updated!.quantityBase, updated!.unit as Unit),
      unit: updated!.unit as Unit,
    };
  });
}

export type AddProductResult =
  { status: 'created'; name: string; id: string } | { status: 'already_exists'; name: string };

export async function addProduct(
  storeId: bigint,
  input: {
    name: string;
    brand?: string;
    packSize?: string;
    unit: Unit;
    isLoose?: boolean;
    hsnCode: string;
    gstRateBps: number;
    costPricePaise: number;
    mrpPaise: number;
    openingQtyBase?: number;
    reorderLevelBase?: number;
  },
): Promise<AddProductResult> {
  const inserted = await db
    .insert(products)
    .values({
      storeId,
      name: input.name,
      brand: input.brand ?? null,
      packSize: input.packSize ?? null,
      unit: input.unit,
      isLoose: input.isLoose ?? false,
      hsnCode: input.hsnCode,
      gstRateBps: input.gstRateBps,
      costPricePaise: input.costPricePaise,
      mrpPaise: input.mrpPaise,
      quantityBase: input.openingQtyBase ?? 0,
      reorderLevelBase: input.reorderLevelBase ?? 0,
    })
    .onConflictDoNothing()
    .returning({ id: products.id, name: products.name });

  if (inserted.length === 0) return { status: 'already_exists', name: input.name };
  return { status: 'created', name: inserted[0]!.name, id: inserted[0]!.id };
}

export type AdjustResult =
  | { status: 'adjusted'; name: string; newQuantity: string }
  | { status: 'would_go_negative'; name: string; available: string }
  | { status: 'ambiguous'; candidates: ProductSummary[] }
  | { status: 'not_found'; query: string };

/**
 * Corrects stock up or down with a reason. There is deliberately no delete anywhere in this
 * repository — a correction is a signed movement, so the trail survives it.
 */
export async function adjustStock(
  storeId: bigint,
  input: { productQuery: string; deltaBase: number; reason: string },
): Promise<AdjustResult> {
  const found = await findStock(storeId, input.productQuery);
  if (found.status !== 'found') return found;
  const product = found.product;

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(products)
      .set({ quantityBase: sql`${products.quantityBase} + ${input.deltaBase}` })
      .where(
        and(
          eq(products.id, product.id),
          eq(products.storeId, storeId),
          gte(products.quantityBase, -input.deltaBase),
        ),
      )
      .returning();

    if (!updated) {
      return {
        status: 'would_go_negative' as const,
        name: product.name,
        available: formatQuantity(product.quantityBase, product.unit as Unit),
      };
    }

    await tx.insert(stockMovements).values({
      storeId,
      productId: product.id,
      kind: 'adjust',
      qtyBaseDelta: input.deltaBase,
    });

    return {
      status: 'adjusted' as const,
      name: updated.name,
      newQuantity: formatQuantity(updated.quantityBase, updated.unit as Unit),
    };
  });
}

export interface LowStockItem {
  name: string;
  inStock: string;
  reorderLevel: string;
}

export async function lowStockReport(storeId: bigint): Promise<LowStockItem[]> {
  const rows = await db
    .select()
    .from(products)
    .where(
      and(eq(products.storeId, storeId), lte(products.quantityBase, products.reorderLevelBase)),
    )
    .orderBy(products.name);

  return rows.map((r) => ({
    name: r.name,
    inStock: formatQuantity(r.quantityBase, r.unit as Unit),
    reorderLevel: formatQuantity(r.reorderLevelBase, r.unit as Unit),
  }));
}
