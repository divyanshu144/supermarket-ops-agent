import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { billItems, bills, products, stockMovements } from '../db/schema.js';
import { formatPaise } from '../domain/money.js';
import { formatQuantity, type Unit } from '../domain/units.js';
import { lineTotalPaise } from '../domain/gst.js';

export interface DaySummary {
  date: string;
  billCount: number;
  totalPaise: number;
  total: string;
  taxCollectedPaise: number;
  taxCollected: string;
  byPaymentMode: Array<{ mode: string; count: number; total: string; totalPaise: number }>;
  topItems: Array<{ name: string; quantity: string; revenue: string; revenuePaise: number }>;
}

interface ItemAggregate {
  name: string;
  unit: Unit;
  qtyBase: number;
  revenuePaise: number;
}

/**
 * Aggregates sold items across a set of bills.
 *
 * Done in JS rather than SQL: the volumes are one shop's bills for a week, and the per-unit
 * revenue maths (loose goods are priced per kg but stored in grams) is the same rule the
 * domain layer already owns. Expressing it twice, once in SQL, is how the two drift apart.
 */
async function aggregateItems(billIds: string[], limit: number): Promise<ItemAggregate[]> {
  if (billIds.length === 0) return [];

  const rows = await db
    .select({
      name: products.name,
      unit: products.unit,
      isLoose: products.isLoose,
      qtyBase: billItems.qtyBase,
      unitPricePaise: billItems.unitPricePaise,
    })
    .from(billItems)
    .innerJoin(products, eq(billItems.productId, products.id))
    .where(inArray(billItems.billId, billIds));

  const byName = new Map<string, ItemAggregate>();
  for (const row of rows) {
    const entry = byName.get(row.name) ?? {
      name: row.name,
      unit: row.unit as Unit,
      qtyBase: 0,
      revenuePaise: 0,
    };
    entry.qtyBase += row.qtyBase;
    entry.revenuePaise += lineTotalPaise(row.unitPricePaise, row.qtyBase, row.unit as Unit);
    byName.set(row.name, entry);
  }

  return [...byName.values()].sort((a, b) => b.revenuePaise - a.revenuePaise).slice(0, limit);
}

function dayBounds(date: Date): { from: Date; to: Date } {
  const from = new Date(date);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from, to };
}

/** Backs "today's sales?" and "close the day". Only finalized bills count. */
export async function dailySummary(storeId: bigint, date = new Date()): Promise<DaySummary> {
  const { from, to } = dayBounds(date);

  const dayBills = await db
    .select()
    .from(bills)
    .where(
      and(
        eq(bills.storeId, storeId),
        eq(bills.status, 'finalized'),
        gte(bills.finalizedAt, from),
        lt(bills.finalizedAt, to),
      ),
    );

  const totalPaise = dayBills.reduce((sum, b) => sum + (b.totalPaise ?? 0), 0);
  const taxCollectedPaise = dayBills.reduce(
    (sum, b) => sum + (b.cgstPaise ?? 0) + (b.sgstPaise ?? 0),
    0,
  );

  const modes = new Map<string, { count: number; totalPaise: number }>();
  for (const bill of dayBills) {
    const mode = bill.paymentMode ?? 'unknown';
    const entry = modes.get(mode) ?? { count: 0, totalPaise: 0 };
    entry.count += 1;
    entry.totalPaise += bill.totalPaise ?? 0;
    modes.set(mode, entry);
  }

  const topItems = await aggregateItems(
    dayBills.map((b) => b.id),
    5,
  );

  return {
    date: from.toISOString().slice(0, 10),
    billCount: dayBills.length,
    totalPaise,
    total: formatPaise(totalPaise),
    taxCollectedPaise,
    taxCollected: formatPaise(taxCollectedPaise),
    byPaymentMode: [...modes.entries()].map(([mode, v]) => ({
      mode,
      count: v.count,
      totalPaise: v.totalPaise,
      total: formatPaise(v.totalPaise),
    })),
    topItems: topItems.map((i) => ({
      name: i.name,
      quantity: formatQuantity(i.qtyBase, i.unit),
      revenuePaise: i.revenuePaise,
      revenue: formatPaise(i.revenuePaise),
    })),
  };
}

export interface SalesReport {
  from: string;
  to: string;
  billCount: number;
  totalPaise: number;
  total: string;
  taxCollectedPaise: number;
  taxCollected: string;
  daily: Array<{ date: string; totalPaise: number; billCount: number }>;
  topItems: Array<{ name: string; quantity: string; revenuePaise: number }>;
}

export async function salesReport(storeId: bigint, from: Date, to: Date): Promise<SalesReport> {
  const rows = await db
    .select()
    .from(bills)
    .where(
      and(
        eq(bills.storeId, storeId),
        eq(bills.status, 'finalized'),
        gte(bills.finalizedAt, from),
        lt(bills.finalizedAt, to),
      ),
    );

  const byDay = new Map<string, { totalPaise: number; billCount: number }>();
  for (const bill of rows) {
    const key = (bill.finalizedAt ?? bill.createdAt).toISOString().slice(0, 10);
    const entry = byDay.get(key) ?? { totalPaise: 0, billCount: 0 };
    entry.totalPaise += bill.totalPaise ?? 0;
    entry.billCount += 1;
    byDay.set(key, entry);
  }

  const topItems = await aggregateItems(
    rows.map((b) => b.id),
    8,
  );

  const totalPaise = rows.reduce((sum, b) => sum + (b.totalPaise ?? 0), 0);
  const taxCollectedPaise = rows.reduce(
    (sum, b) => sum + (b.cgstPaise ?? 0) + (b.sgstPaise ?? 0),
    0,
  );

  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    billCount: rows.length,
    totalPaise,
    total: formatPaise(totalPaise),
    taxCollectedPaise,
    taxCollected: formatPaise(taxCollectedPaise),
    daily: [...byDay.entries()]
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    topItems: topItems.map((i) => ({
      name: i.name,
      quantity: formatQuantity(i.qtyBase, i.unit),
      revenuePaise: i.revenuePaise,
    })),
  };
}

export interface StockHealth {
  skuCount: number;
  stockValuePaise: number;
  stockValue: string;
  lowStock: Array<{ name: string; inStock: string; reorderLevel: string }>;
  deadStock: Array<{ name: string; inStock: string }>;
}

/** Dead stock = on the shelf but no sale movement in the window. */
export async function stockHealth(storeId: bigint, sinceDays = 14): Promise<StockHealth> {
  const all = await db.select().from(products).where(eq(products.storeId, storeId));
  const since = new Date(Date.now() - sinceDays * 86_400_000);

  const sold = await db
    .selectDistinct({ productId: stockMovements.productId })
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.storeId, storeId),
        eq(stockMovements.kind, 'sale'),
        gte(stockMovements.createdAt, since),
      ),
    );
  const soldIds = new Set(sold.map((s) => s.productId));

  const stockValuePaise = all.reduce(
    (sum, p) => sum + Math.floor((p.quantityBase * p.costPricePaise) / (p.isLoose ? 1000 : 1)),
    0,
  );

  return {
    skuCount: all.length,
    stockValuePaise,
    stockValue: formatPaise(stockValuePaise),
    lowStock: all
      .filter((p) => p.quantityBase <= p.reorderLevelBase)
      .map((p) => ({
        name: p.name,
        inStock: formatQuantity(p.quantityBase, p.unit as Unit),
        reorderLevel: formatQuantity(p.reorderLevelBase, p.unit as Unit),
      })),
    deadStock: all
      .filter((p) => !soldIds.has(p.id) && p.quantityBase > 0)
      .map((p) => ({ name: p.name, inStock: formatQuantity(p.quantityBase, p.unit as Unit) })),
  };
}

export interface ReorderSuggestion {
  productId: string;
  name: string;
  unit: string;
  quantityBase: number;
  reorderLevelBase: number;
  unitsPerDay: number;
  /** Null when nothing sold in the window — cover is undefined, not infinite. */
  daysOfCover: number | null;
}

/**
 * What to order next, ranked by how soon it runs out.
 *
 * A flat below-reorder-level list treats a slow-moving SKU sitting at its threshold the same as
 * a fast mover about to go empty. Velocity is what the owner actually needs to decide.
 */
export async function reorderSuggestions(
  storeId: bigint,
  daysBack = 30,
): Promise<ReorderSuggestion[]> {
  const since = new Date(Date.now() - daysBack * 86_400_000);

  const rows = await db
    .select({
      productId: products.id,
      name: products.name,
      unit: products.unit,
      quantityBase: products.quantityBase,
      reorderLevelBase: products.reorderLevelBase,
      // Sale deltas are negative; negate to get units sold. Movements outside the window and
      // non-sale kinds contribute 0 rather than dropping the product from the report.
      soldBase: sql<number>`
        coalesce(sum(
          case when ${stockMovements.kind} = 'sale'
                and ${stockMovements.createdAt} >= ${since}
               then -${stockMovements.qtyBaseDelta}
               else 0 end
        ), 0)::int
      `,
    })
    .from(products)
    .leftJoin(stockMovements, eq(stockMovements.productId, products.id))
    .where(eq(products.storeId, storeId))
    .groupBy(
      products.id,
      products.name,
      products.unit,
      products.quantityBase,
      products.reorderLevelBase,
    );

  return rows
    .map((r) => {
      const unitsPerDay = r.soldBase / daysBack;
      return {
        productId: r.productId,
        name: r.name,
        unit: r.unit,
        quantityBase: Number(r.quantityBase),
        reorderLevelBase: Number(r.reorderLevelBase),
        unitsPerDay,
        daysOfCover: unitsPerDay > 0 ? Number(r.quantityBase) / unitsPerDay : null,
      };
    })
    .sort((a, b) => {
      // Never-selling stock sorts last: it is not urgent, however little is left.
      if (a.daysOfCover === null) return b.daysOfCover === null ? 0 : 1;
      if (b.daysOfCover === null) return -1;
      return a.daysOfCover - b.daysOfCover;
    });
}
