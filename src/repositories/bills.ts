import { and, asc, desc, eq, gte, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  billItems,
  bills,
  idempotencyKeys,
  khataAccounts,
  khataEntries,
  products,
  stockMovements,
  stores,
} from '../db/schema.js';
import { computeLine } from '../domain/gst.js';
import { formatPaise, roundToNearestRupee } from '../domain/money.js';
import { formatQuantity, toBaseUnits, type Unit } from '../domain/units.js';
import { findStock, type ProductSummary } from './products.js';

/** The transaction handle Drizzle hands to `db.transaction`. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type BillStatus = 'draft' | 'finalized' | 'void';
export type PaymentMode = 'cash' | 'upi' | 'card' | 'khata';

export interface BillTotals {
  /** Sum of the taxable values, i.e. the pre-GST value of the bill. */
  subtotalPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  /** Signed adjustment that takes the gross to a whole rupee, as GST invoices must show. */
  roundOffPaise: number;
  totalPaise: number;
}

export interface BillLineView {
  itemId: string;
  /** 1-based position on the bill; the only stable ordering there is. */
  lineNo: number;
  productId: string;
  name: string;
  brand: string | null;
  packSize: string | null;
  unit: Unit;
  hsnCode: string;
  gstRateBps: number;
  qtyBase: number;
  quantity: string;
  unitPricePaise: number;
  lineTotalPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
}

export interface BillView {
  id: string;
  status: BillStatus;
  customerName: string | null;
  paymentMode: PaymentMode | null;
  paymentRef: string | null;
  invoiceNumber: string | null;
  createdAt: Date;
  finalizedAt: Date | null;
  items: BillLineView[];
  totals: BillTotals;
}

export interface BillSummary {
  id: string;
  status: BillStatus;
  invoiceNumber: string | null;
  customerName: string | null;
  paymentMode: PaymentMode | null;
  totalPaise: number | null;
  itemCount: number;
  createdAt: Date;
  finalizedAt: Date | null;
}

/**
 * Line edits are refusals-as-data too: a mistyped product or a quantity in the wrong dimension
 * is something the model must relay and ask about, not an exception that kills the turn.
 */
export type AddItemResult =
  | { status: 'added'; bill: BillView }
  | { status: 'product_not_found'; query: string }
  | { status: 'ambiguous'; candidates: ProductSummary[] }
  | { status: 'bill_not_found'; billId: string }
  | { status: 'bill_not_draft'; billId: string; billStatus: BillStatus }
  | { status: 'invalid_quantity'; reason: string };

export type UpdateItemResult =
  | { status: 'updated'; bill: BillView }
  | { status: 'item_not_on_bill'; query: string }
  | Exclude<AddItemResult, { status: 'added' }>;

export type RemoveItemResult =
  | { status: 'removed'; bill: BillView }
  | { status: 'item_not_on_bill'; query: string }
  | Exclude<AddItemResult, { status: 'added' | 'invalid_quantity' }>;

/**
 * Finalize either succeeds or refuses with a reason the shopkeeper can act on. None of these
 * are exceptions: "you only have 6 Maggi" is an answer, not a crash.
 */
export type FinalizeResult =
  | { status: 'finalized'; billId: string; invoiceNumber: string; totals: BillTotals }
  | { status: 'already_finalized'; billId: string; invoiceNumber: string; totals: BillTotals }
  | {
      status: 'insufficient_stock';
      shortfalls: Array<{ name: string; wanted: string; available: string }>;
    }
  | { status: 'below_cost'; lines: Array<{ name: string; price: string; cost: string }> }
  // No override counterpart to below_cost's `allowBelowCost`: selling under cost is the owner's
  // money to lose, selling over MRP is the customer's and is not the owner's to give away.
  | { status: 'above_mrp'; lines: Array<{ name: string; price: string; mrp: string }> }
  | { status: 'unknown_customer'; customerName: string }
  | { status: 'bill_not_found'; billId: string }
  | { status: 'empty_bill'; billId: string }
  | { status: 'bill_void'; billId: string };

export type VoidResult =
  | {
      status: 'voided';
      billId: string;
      invoiceNumber: string | null;
      restored: Array<{ name: string; quantity: string }>;
      khataReversedPaise: number;
    }
  | { status: 'already_void'; billId: string; invoiceNumber: string | null }
  | { status: 'bill_not_found'; billId: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A bill id reaching here came from the model, so it can be anything at all. Postgres raises a
 * hard error on a malformed uuid, which would surface as a crash rather than "no such bill".
 */
function isBillId(value: string): boolean {
  return UUID_RE.test(value);
}

/** Which physical dimension a unit measures. Grams cannot be billed as packets. */
const DIMENSION: Record<Unit, 'mass' | 'volume' | 'count'> = {
  kg: 'mass',
  g: 'mass',
  litre: 'volume',
  ml: 'volume',
  packet: 'count',
  dozen: 'count',
  piece: 'count',
};

type QtyResolution = { ok: true; qtyBase: number } | { ok: false; reason: string };

/**
 * Converts a spoken quantity into the product's base units.
 *
 * The caller's unit only sizes the number; the *price* is always per the product's own selling
 * unit. Mixing dimensions is refused rather than silently converted, because "2 kg of Maggi
 * packets" would otherwise bill 2000 packets.
 */
function resolveQtyBase(
  qty: number,
  unit: Unit,
  productName: string,
  productUnit: Unit,
): QtyResolution {
  if (DIMENSION[unit] !== DIMENSION[productUnit]) {
    return {
      ok: false,
      reason: `${productName} is sold by ${productUnit}, so it cannot be billed in ${unit}.`,
    };
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, reason: `Quantity must be greater than zero, got ${qty}.` };
  }

  let qtyBase: number;
  try {
    qtyBase = toBaseUnits(qty, unit);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  if (qtyBase <= 0) {
    return { ok: false, reason: `${qty} ${unit} rounds to nothing for ${productName}.` };
  }
  return { ok: true, qtyBase };
}

interface LineRow {
  itemId: string;
  lineNo: number;
  productId: string;
  qtyBase: number;
  unitPricePaise: number;
  gstRateBps: number;
  hsnCode: string;
  name: string;
  brand: string | null;
  packSize: string | null;
  unit: Unit;
}

const LINE_COLUMNS = {
  itemId: billItems.id,
  lineNo: billItems.lineNo,
  productId: billItems.productId,
  qtyBase: billItems.qtyBase,
  unitPricePaise: billItems.unitPricePaise,
  gstRateBps: billItems.gstRateBps,
  hsnCode: billItems.hsnCode,
  name: products.name,
  brand: products.brand,
  packSize: products.packSize,
  unit: products.unit,
};

/** Prices the line off its own snapshot, never off the product's current MRP. */
function viewLine(line: LineRow): BillLineView {
  const amounts = computeLine({
    mrpPaise: line.unitPricePaise,
    qtyBase: line.qtyBase,
    unit: line.unit,
    gstRateBps: line.gstRateBps,
  });
  return {
    itemId: line.itemId,
    lineNo: line.lineNo,
    productId: line.productId,
    name: line.name,
    brand: line.brand,
    packSize: line.packSize,
    unit: line.unit,
    hsnCode: line.hsnCode,
    gstRateBps: line.gstRateBps,
    qtyBase: line.qtyBase,
    quantity: formatQuantity(line.qtyBase, line.unit),
    unitPricePaise: line.unitPricePaise,
    lineTotalPaise: amounts.lineTotalPaise,
    taxablePaise: amounts.taxablePaise,
    cgstPaise: amounts.cgstPaise,
    sgstPaise: amounts.sgstPaise,
  };
}

/**
 * Sums the lines and rounds ONCE, at the bill level.
 *
 * Rounding each line to the rupee and then summing would drift by paise across a long bill,
 * and the round-off line on the invoice exists precisely to absorb a single adjustment.
 */
function totalsFromLines(lines: BillLineView[]): BillTotals {
  let subtotalPaise = 0;
  let cgstPaise = 0;
  let sgstPaise = 0;

  for (const line of lines) {
    subtotalPaise += line.taxablePaise;
    cgstPaise += line.cgstPaise;
    sgstPaise += line.sgstPaise;
  }

  const { totalPaise, roundOffPaise } = roundToNearestRupee(subtotalPaise + cgstPaise + sgstPaise);
  return { subtotalPaise, cgstPaise, sgstPaise, roundOffPaise, totalPaise };
}

/**
 * Lines in the order they were rung up.
 *
 * Ordered by `line_no` and nothing else: the shopkeeper reads the bill back in the order they
 * built it, and an invoice PDF regenerated tomorrow must lay out identically to today's.
 */
async function selectLines(exec: Tx, billId: string): Promise<LineRow[]> {
  const rows = await exec
    .select(LINE_COLUMNS)
    .from(billItems)
    .innerJoin(products, eq(billItems.productId, products.id))
    .where(eq(billItems.billId, billId))
    .orderBy(asc(billItems.lineNo));

  return rows.map((r) => ({ ...r, unit: r.unit as Unit }));
}

/** Opens an empty draft. Several drafts may be open per store at once, by design. */
export async function openBill(
  storeId: bigint,
  input: { customerName?: string; idempotencyKey?: string } = {},
): Promise<{ billId: string }> {
  const customerName = input.customerName?.trim();

  if (!input.idempotencyKey) {
    const [row] = await db
      .insert(bills)
      .values({ storeId, customerName: customerName ? customerName : null })
      .returning({ id: bills.id });
    return { billId: row!.id };
  }

  return db.transaction(async (tx) => {
    // Insert-first: the unique constraint IS the enforcement. Checking then writing leaves a
    // window in which a redelivered update opens a second draft.
    const claimed = await tx
      .insert(idempotencyKeys)
      .values({
        storeId,
        key: input.idempotencyKey!,
        operation: 'open_bill',
        result: {},
      })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });

    if (claimed.length === 0) {
      const [existing] = await tx
        .select({ result: idempotencyKeys.result })
        .from(idempotencyKeys)
        .where(
          and(eq(idempotencyKeys.storeId, storeId), eq(idempotencyKeys.key, input.idempotencyKey!)),
        );
      return { billId: (existing!.result as { billId: string }).billId };
    }

    const [row] = await tx
      .insert(bills)
      .values({ storeId, customerName: customerName ? customerName : null })
      .returning({ id: bills.id });

    await tx
      .update(idempotencyKeys)
      .set({ result: { billId: row!.id } })
      .where(
        and(eq(idempotencyKeys.storeId, storeId), eq(idempotencyKeys.key, input.idempotencyKey!)),
      );

    return { billId: row!.id };
  });
}

export async function getBill(storeId: bigint, billId: string): Promise<BillView | null> {
  if (!isBillId(billId)) return null;

  return db.transaction(async (tx) => {
    const [bill] = await tx
      .select()
      .from(bills)
      .where(and(eq(bills.storeId, storeId), eq(bills.id, billId)));
    if (!bill) return null;

    const items = (await selectLines(tx, billId)).map(viewLine);

    // A finalized bill shows what was actually charged, not a recomputation: the stored figures
    // are the invoice of record, and recomputing would quietly rewrite history if a rule changed.
    const totals: BillTotals =
      bill.status === 'draft' || bill.totalPaise === null
        ? totalsFromLines(items)
        : {
            subtotalPaise: bill.subtotalPaise ?? 0,
            cgstPaise: bill.cgstPaise ?? 0,
            sgstPaise: bill.sgstPaise ?? 0,
            roundOffPaise: bill.roundOffPaise ?? 0,
            totalPaise: bill.totalPaise,
          };

    return {
      id: bill.id,
      status: bill.status as BillStatus,
      customerName: bill.customerName,
      paymentMode: bill.paymentMode as PaymentMode | null,
      paymentRef: bill.paymentRef,
      invoiceNumber: bill.invoiceNumber,
      createdAt: bill.createdAt,
      finalizedAt: bill.finalizedAt,
      items,
      totals,
    };
  });
}

/**
 * Looks bills up by customer or recency.
 *
 * Exists because "send me Ramesh's bill from yesterday as a PDF" has no path to a bill id
 * otherwise, and the PDF tool takes an id.
 */
export async function findBills(
  storeId: bigint,
  input: {
    customer?: string;
    since?: Date;
    limit?: number;
    includeStaleDrafts?: boolean;
  } = {},
): Promise<BillSummary[]> {
  const conditions = [eq(bills.storeId, storeId)];
  if (input.customer?.trim())
    conditions.push(ilike(bills.customerName, `%${input.customer.trim()}%`));
  if (input.since) conditions.push(gte(bills.createdAt, input.since));

  // An abandoned draft holds no stock, but it clutters every "which bill?" lookup. A draft the
  // owner has not touched in a day is not the bill they mean.
  if (!input.includeStaleDrafts) {
    const cutoff = new Date(Date.now() - 86_400_000);
    conditions.push(or(ne(bills.status, 'draft'), gte(bills.createdAt, cutoff))!);
  }

  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);

  const rows = await db
    .select({
      id: bills.id,
      status: bills.status,
      invoiceNumber: bills.invoiceNumber,
      customerName: bills.customerName,
      paymentMode: bills.paymentMode,
      totalPaise: bills.totalPaise,
      createdAt: bills.createdAt,
      finalizedAt: bills.finalizedAt,
    })
    .from(bills)
    .where(and(...conditions))
    .orderBy(desc(bills.createdAt))
    .limit(limit);

  if (rows.length === 0) return [];

  // Counted in a second grouped query rather than a correlated subquery: Drizzle renders bare
  // column names inside a `sql` template, so `bill_id = id` would silently resolve both sides
  // against bill_items and count nothing.
  const counts = await db
    .select({ billId: billItems.billId, n: sql<number>`count(*)::int` })
    .from(billItems)
    .where(
      inArray(
        billItems.billId,
        rows.map((r) => r.id),
      ),
    )
    .groupBy(billItems.billId);

  const countByBill = new Map(counts.map((c) => [c.billId, Number(c.n)]));

  return rows.map((r) => ({
    ...r,
    status: r.status as BillStatus,
    paymentMode: r.paymentMode as PaymentMode | null,
    itemCount: countByBill.get(r.id) ?? 0,
  }));
}

type DraftLock =
  | { ok: true }
  | { ok: false; refusal: { status: 'bill_not_found'; billId: string } }
  | { ok: false; refusal: { status: 'bill_not_draft'; billId: string; billStatus: BillStatus } };

/**
 * Locks the bill and proves it is still a draft.
 *
 * Every line edit takes this lock, and so does finalize, so a line can never be inserted into a
 * bill that is being finalized on another connection — which would ship goods that were never
 * counted, priced or decremented.
 */
async function lockDraft(tx: Tx, storeId: bigint, billId: string): Promise<DraftLock> {
  const [bill] = await tx
    .select({ id: bills.id, status: bills.status })
    .from(bills)
    .where(and(eq(bills.storeId, storeId), eq(bills.id, billId)))
    .for('update');

  if (!bill) return { ok: false, refusal: { status: 'bill_not_found', billId } };
  if (bill.status !== 'draft') {
    return {
      ok: false,
      refusal: { status: 'bill_not_draft', billId, billStatus: bill.status as BillStatus },
    };
  }
  return { ok: true };
}

/**
 * Adds a line, snapshotting price, GST rate and HSN.
 *
 * Two identical lines are legal — a shopkeeper ringing the same item twice is a normal bill, and
 * the idempotency ordinal exists so a replayed turn does not collapse them into one.
 */
/** What a keyed `addBillItem` call stashes in `idempotency_keys.result` to reconstruct the
 * original outcome on replay. Only the statuses reachable *inside* the transaction below need a
 * slot here — `product_not_found`, `ambiguous` and `invalid_quantity` are decided before the key
 * is ever claimed, so a replay simply redoes that (read-only) work rather than needing storage. */
type StoredAddItemOutcome =
  | { outcome: 'added' }
  | { outcome: 'bill_not_found'; billId: string }
  | { outcome: 'bill_not_draft'; billId: string; billStatus: BillStatus };

export async function addBillItem(
  storeId: bigint,
  input: {
    billId: string;
    productQuery: string;
    qty: number;
    unit: Unit;
    unitPriceOverridePaise?: number;
    idempotencyKey?: string;
  },
): Promise<AddItemResult> {
  const { billId } = input;
  if (!isBillId(billId)) return { status: 'bill_not_found', billId };

  const stock = await findStock(storeId, input.productQuery);
  if (stock.status === 'not_found')
    return { status: 'product_not_found', query: input.productQuery };
  if (stock.status === 'ambiguous') return { status: 'ambiguous', candidates: stock.candidates };

  const product = stock.product;
  const qty = resolveQtyBase(input.qty, input.unit, product.name, product.unit as Unit);
  if (!qty.ok) return { status: 'invalid_quantity', reason: qty.reason };

  if (input.unitPriceOverridePaise !== undefined) {
    if (!Number.isInteger(input.unitPriceOverridePaise) || input.unitPriceOverridePaise < 0) {
      return {
        status: 'invalid_quantity',
        reason: `Price override must be a whole number of paise, got ${input.unitPriceOverridePaise}.`,
      };
    }
  }

  const outcome = await db.transaction(async (tx): Promise<AddItemResult | null> => {
    if (input.idempotencyKey) {
      // Insert-first, same as openBill: the unique constraint IS the enforcement. Checking
      // then writing leaves a window in which a redelivered update appends a second line.
      const claimed = await tx
        .insert(idempotencyKeys)
        .values({
          storeId,
          key: input.idempotencyKey,
          operation: 'add_bill_item',
          result: {},
        })
        .onConflictDoNothing()
        .returning({ key: idempotencyKeys.key });

      if (claimed.length === 0) {
        const [existing] = await tx
          .select({ result: idempotencyKeys.result })
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.storeId, storeId),
              eq(idempotencyKeys.key, input.idempotencyKey),
            ),
          );
        const stored = existing!.result as StoredAddItemOutcome;
        if (stored.outcome === 'added') return null; // fall through to a fresh getBill below
        if (stored.outcome === 'bill_not_found')
          return { status: 'bill_not_found', billId: stored.billId };
        return { status: 'bill_not_draft', billId: stored.billId, billStatus: stored.billStatus };
      }
    }

    const lock = await lockDraft(tx, storeId, billId);
    if (!lock.ok) {
      if (input.idempotencyKey) {
        const stored: StoredAddItemOutcome =
          lock.refusal.status === 'bill_not_found'
            ? { outcome: 'bill_not_found', billId: lock.refusal.billId }
            : {
                outcome: 'bill_not_draft',
                billId: lock.refusal.billId,
                billStatus: lock.refusal.billStatus,
              };
        await tx
          .update(idempotencyKeys)
          .set({ result: stored })
          .where(
            and(
              eq(idempotencyKeys.storeId, storeId),
              eq(idempotencyKeys.key, input.idempotencyKey),
            ),
          );
      }
      return lock.refusal;
    }

    // Safe as a read-modify-write because `lockDraft` holds the bill row, which is also what the
    // (bill_id, line_no) unique index would otherwise have to catch.
    const [last] = await tx
      .select({ max: sql<number>`coalesce(max(${billItems.lineNo}), 0)` })
      .from(billItems)
      .where(eq(billItems.billId, billId));

    await tx.insert(billItems).values({
      billId,
      lineNo: Number(last?.max ?? 0) + 1,
      productId: product.id,
      qtyBase: qty.qtyBase,
      unitPricePaise: input.unitPriceOverridePaise ?? product.mrpPaise,
      gstRateBps: product.gstRateBps,
      hsnCode: product.hsnCode,
    });

    if (input.idempotencyKey) {
      const stored: StoredAddItemOutcome = { outcome: 'added' };
      await tx
        .update(idempotencyKeys)
        .set({ result: stored })
        .where(
          and(eq(idempotencyKeys.storeId, storeId), eq(idempotencyKeys.key, input.idempotencyKey)),
        );
    }
    return null;
  });

  if (outcome) return outcome;
  return { status: 'added', bill: (await getBill(storeId, billId))! };
}

/**
 * Sets the quantity of a product on the bill.
 *
 * "make the sugar 3 kg" is a statement about the bill, not about one particular line, so if the
 * product was rung up twice the lines collapse into the single requested quantity.
 *
 * The FIRST line survives, by `line_no`. The two lines can legitimately differ — a price override
 * on one, or an MRP edit between the two adds — so which one survives decides the bill total, and
 * that must not depend on the order Postgres happened to return random uuids in.
 */
export async function updateBillItem(
  storeId: bigint,
  input: { billId: string; productQuery: string; qty: number; unit: Unit },
): Promise<UpdateItemResult> {
  const { billId } = input;
  if (!isBillId(billId)) return { status: 'bill_not_found', billId };

  const stock = await findStock(storeId, input.productQuery);
  if (stock.status === 'not_found')
    return { status: 'product_not_found', query: input.productQuery };
  if (stock.status === 'ambiguous') return { status: 'ambiguous', candidates: stock.candidates };

  const product = stock.product;
  const qty = resolveQtyBase(input.qty, input.unit, product.name, product.unit as Unit);
  if (!qty.ok) return { status: 'invalid_quantity', reason: qty.reason };

  const outcome = await db.transaction(async (tx): Promise<UpdateItemResult | null> => {
    const lock = await lockDraft(tx, storeId, billId);
    if (!lock.ok) return lock.refusal;

    const existing = await tx
      .select({ id: billItems.id })
      .from(billItems)
      .where(and(eq(billItems.billId, billId), eq(billItems.productId, product.id)))
      .orderBy(asc(billItems.lineNo));

    const [keep, ...duplicates] = existing;
    if (!keep) return { status: 'item_not_on_bill', query: input.productQuery };

    for (const duplicate of duplicates) {
      await tx.delete(billItems).where(eq(billItems.id, duplicate.id));
    }
    await tx.update(billItems).set({ qtyBase: qty.qtyBase }).where(eq(billItems.id, keep.id));
    return null;
  });

  if (outcome) return outcome;
  return { status: 'updated', bill: (await getBill(storeId, billId))! };
}

/** Removes the product from the bill entirely, however many lines it occupies. */
export async function removeBillItem(
  storeId: bigint,
  input: { billId: string; productQuery: string },
): Promise<RemoveItemResult> {
  const { billId } = input;
  if (!isBillId(billId)) return { status: 'bill_not_found', billId };

  const stock = await findStock(storeId, input.productQuery);
  if (stock.status === 'not_found')
    return { status: 'product_not_found', query: input.productQuery };
  if (stock.status === 'ambiguous') return { status: 'ambiguous', candidates: stock.candidates };

  const product = stock.product;

  const outcome = await db.transaction(async (tx): Promise<RemoveItemResult | null> => {
    const lock = await lockDraft(tx, storeId, billId);
    if (!lock.ok) return lock.refusal;

    const deleted = await tx
      .delete(billItems)
      .where(and(eq(billItems.billId, billId), eq(billItems.productId, product.id)))
      .returning({ id: billItems.id });

    if (deleted.length === 0) return { status: 'item_not_on_bill', query: input.productQuery };
    return null;
  });

  if (outcome) return outcome;
  return { status: 'removed', bill: (await getBill(storeId, billId))! };
}

/**
 * Serializes bill settlement for one store.
 *
 * `no key update` rather than `update`: the weaker mode still excludes a second finalize, but
 * does not conflict with the `key share` lock that every INSERT referencing this store takes,
 * so adding a product or opening a bill elsewhere is not blocked while a bill is being cut.
 *
 * This is also what makes invoice numbering safe. The number is derived by reading the existing
 * numbers, and two concurrent finalizes reading the same maximum would both claim it — one of
 * them dying on the partial unique index. Under this lock only one finalize per store is ever
 * between the read and the write.
 */
async function lockStore(tx: Tx, storeId: bigint): Promise<void> {
  await tx
    .select({ id: stores.id })
    .from(stores)
    .where(eq(stores.id, storeId))
    .for('no key update');
}

/**
 * Next invoice number for the store.
 *
 * Derived from the existing numbers rather than a Postgres sequence, because a sequence is
 * global and these must be per-store and gapless-looking to the shopkeeper. Seeded history uses
 * a different shape (`INV-3-2`), which the anchored pattern deliberately ignores, so a demo
 * store still starts at INV-0001 and can never collide with its own seed.
 */
async function nextInvoiceNumber(tx: Tx, storeId: bigint): Promise<string> {
  const [row] = await tx
    .select({
      max: sql<number>`coalesce(max((substring(${bills.invoiceNumber} from '^INV-([0-9]+)$'))::int), 0)`,
    })
    .from(bills)
    .where(and(eq(bills.storeId, storeId), sql`${bills.invoiceNumber} ~ '^INV-[0-9]+$'`));

  return `INV-${String(Number(row?.max ?? 0) + 1).padStart(4, '0')}`;
}

/** Sums the quantity a bill wants of each product, so duplicate lines cannot each pass the check. */
function wantedPerProduct(lines: LineRow[]): Map<string, number> {
  const wanted = new Map<string, number>();
  for (const line of lines) {
    wanted.set(line.productId, (wanted.get(line.productId) ?? 0) + line.qtyBase);
  }
  return wanted;
}

interface LockedProduct {
  id: string;
  name: string;
  unit: Unit;
  quantityBase: number;
  costPricePaise: number;
  mrpPaise: number;
}

/**
 * Locks every product the bill touches, **in ascending id order**.
 *
 * The order is the whole point. Two bills over sugar and atta, added in opposite orders and
 * finalized at the same moment, would each hold the row the other needs and Postgres would
 * shoot one of them for deadlock. Sorting the ids gives every transaction the same acquisition
 * order, which makes the cycle impossible rather than merely unlikely.
 */
/**
 * The canonical order in which product rows must be locked.
 *
 * Two transactions that lock the same pair in opposite orders deadlock; Postgres detects the
 * cycle and kills one of them. Normalising the order removes the possibility. Extracted as a
 * pure function so it is directly testable: inducing a real deadlock through `finalizeBill`
 * is impossible (the store gate serializes finalizes) and inducing one through `lockProducts`
 * needs interleaving mid-loop that a timing-based test cannot reliably produce.
 */
export function orderForLocking(productIds: string[]): string[] {
  return [...productIds].sort();
}

/**
 * Locks the given products FOR NO KEY UPDATE, always in sorted id order.
 *
 * Exported solely as a test seam. `finalizeBill` serializes on the store row before it gets
 * here, so the sort can never be exercised through the public API — the only way to prove it
 * is to drive this directly from two concurrent transactions. See bills.invariants.test.ts.
 */
export async function lockProducts(
  tx: Tx,
  storeId: bigint,
  productIds: string[],
): Promise<Map<string, LockedProduct>> {
  const locked = new Map<string, LockedProduct>();

  for (const id of orderForLocking(productIds)) {
    const [row] = await tx
      .select({
        id: products.id,
        name: products.name,
        unit: products.unit,
        quantityBase: products.quantityBase,
        costPricePaise: products.costPricePaise,
        mrpPaise: products.mrpPaise,
      })
      .from(products)
      .where(and(eq(products.id, id), eq(products.storeId, storeId)))
      .for('no key update');

    // The bill_items → products foreign key makes a missing row impossible; if it ever happens
    // the data is corrupt and throwing is correct, unlike a business refusal.
    if (!row) throw new Error(`Bill references product ${id} which is not in store ${storeId}.`);
    locked.set(id, { ...row, unit: row.unit as Unit });
  }

  return locked;
}

/**
 * Settles a bill: stock, tax, invoice number and any credit charge, in ONE transaction.
 *
 * Finalising and then charging the khata as two transactions would leave a window in which the
 * goods have left the shelf and nobody owes for them. That is the books-consistency failure the
 * brief is testing, so the two writes share a transaction or neither happens.
 */
export async function finalizeBill(
  storeId: bigint,
  input: {
    billId: string;
    paymentMode: PaymentMode;
    paymentRef?: string;
    customerName?: string;
    allowBelowCost?: boolean;
  },
): Promise<FinalizeResult> {
  const { billId } = input;
  if (!isBillId(billId)) return { status: 'bill_not_found', billId };

  return db.transaction(async (tx): Promise<FinalizeResult> => {
    // 1. One finalize per store at a time; see lockStore.
    await lockStore(tx, storeId);

    // 2. The bill itself, locked so no line can be added underneath us.
    const [bill] = await tx
      .select()
      .from(bills)
      .where(and(eq(bills.storeId, storeId), eq(bills.id, billId)))
      .for('update');

    if (!bill) return { status: 'bill_not_found', billId };

    // 3. Replay of a finalize that already committed. A SUCCESS returning the same invoice —
    //    never a second decrement, which is the whole point of making this idempotent.
    if (bill.status === 'finalized') {
      return {
        status: 'already_finalized',
        billId,
        invoiceNumber: bill.invoiceNumber!,
        totals: {
          subtotalPaise: bill.subtotalPaise ?? 0,
          cgstPaise: bill.cgstPaise ?? 0,
          sgstPaise: bill.sgstPaise ?? 0,
          roundOffPaise: bill.roundOffPaise ?? 0,
          totalPaise: bill.totalPaise ?? 0,
        },
      };
    }
    if (bill.status === 'void') return { status: 'bill_void', billId };

    // 4. Lines, priced off their snapshots.
    const lines = await selectLines(tx, billId);
    if (lines.length === 0) return { status: 'empty_bill', billId };

    // 5. Credit needs a name. Charging a NEW name is fine — that is how a kirana works — but
    //    charging nobody is not, so an unnamed khata bill refuses before anything moves.
    const customerName = (input.customerName ?? bill.customerName ?? '').trim();
    if (input.paymentMode === 'khata' && customerName === '') {
      return { status: 'unknown_customer', customerName };
    }

    // 6. Lock the products, ordered by id.
    const wanted = wantedPerProduct(lines);
    const locked = await lockProducts(tx, storeId, [...wanted.keys()]);

    // 7. Above MRP, across ALL lines. Refused outright, with no override argument: MRP in India
    //    is the maximum price at which the goods may legally be sold, which is the same fact that
    //    makes GST back-calculated rather than added on top. Selling under cost is the owner's
    //    money to lose; selling over MRP is the customer's, and is not theirs to give away.
    const aboveMrp = lines
      .filter((line) => line.unitPricePaise > locked.get(line.productId)!.mrpPaise)
      .map((line) => ({
        name: line.name,
        price: formatPaise(line.unitPricePaise),
        mrp: formatPaise(locked.get(line.productId)!.mrpPaise),
      }));

    if (aboveMrp.length > 0) return { status: 'above_mrp', lines: aboveMrp };

    // 8. Below cost, across ALL lines, before anything is written.
    const belowCost = lines
      .filter((line) => line.unitPricePaise < locked.get(line.productId)!.costPricePaise)
      .map((line) => ({
        name: line.name,
        price: formatPaise(line.unitPricePaise),
        cost: formatPaise(locked.get(line.productId)!.costPricePaise),
      }));

    if (belowCost.length > 0 && !input.allowBelowCost) {
      return { status: 'below_cost', lines: belowCost };
    }

    // 8. Shortfalls, across ALL lines. We hold the row locks, so these readings cannot move
    //    under us, and collecting every one lets the refusal name each problem item instead of
    //    stopping at the first — the difference between "no Maggi" and "no Maggi, no sugar".
    const shortfalls = [...wanted.entries()]
      .map(([productId, qtyBase]) => ({ product: locked.get(productId)!, qtyBase }))
      .filter(({ product, qtyBase }) => product.quantityBase < qtyBase)
      .map(({ product, qtyBase }) => ({
        name: product.name,
        wanted: formatQuantity(qtyBase, product.unit),
        available: formatQuantity(product.quantityBase, product.unit),
      }));

    if (shortfalls.length > 0) return { status: 'insufficient_stock', shortfalls };

    // 9. Decrement as a compare-and-set. Redundant under the lock taken in step 6, and kept
    //    anyway: it is the guard that survives someone later removing the lock, and it is what
    //    makes the oversell impossible at the statement level rather than by argument.
    for (const [productId, qtyBase] of wanted) {
      const updated = await tx
        .update(products)
        .set({ quantityBase: sql`${products.quantityBase} - ${qtyBase}` })
        .where(
          and(
            eq(products.id, productId),
            eq(products.storeId, storeId),
            gte(products.quantityBase, qtyBase),
          ),
        )
        .returning({ quantityBase: products.quantityBase });

      if (updated.length === 0) {
        throw new Error(
          `Stock for product ${productId} changed while locked — the row lock is not doing its job.`,
        );
      }
    }

    // 10. Totals: per line via computeLine, summed, rounded once.
    const totals = totalsFromLines(lines.map(viewLine));

    // 11. Invoice number, under the store lock.
    const invoiceNumber = await nextInvoiceNumber(tx, storeId);

    await tx
      .update(bills)
      .set({
        status: 'finalized',
        paymentMode: input.paymentMode,
        paymentRef: input.paymentRef?.trim() ? input.paymentRef.trim() : null,
        customerName: customerName === '' ? bill.customerName : customerName,
        subtotalPaise: totals.subtotalPaise,
        cgstPaise: totals.cgstPaise,
        sgstPaise: totals.sgstPaise,
        roundOffPaise: totals.roundOffPaise,
        totalPaise: totals.totalPaise,
        invoiceNumber,
        finalizedAt: new Date(),
      })
      .where(eq(bills.id, billId));

    // 12. Audit trail, one movement per line so the bill can be reconstructed from it.
    await tx.insert(stockMovements).values(
      lines.map((line) => ({
        storeId,
        productId: line.productId,
        kind: 'sale' as const,
        qtyBaseDelta: -line.qtyBase,
        billId,
        unitCostPaise: locked.get(line.productId)!.costPricePaise,
      })),
    );

    // 13. Credit, in this same transaction.
    if (input.paymentMode === 'khata') {
      await chargeKhata(tx, storeId, customerName, billId, totals.totalPaise, invoiceNumber);
    }

    return { status: 'finalized', billId, invoiceNumber, totals };
  });
}

/**
 * Charges a customer's khata, creating the account if this is their first credit purchase.
 *
 * Auto-creation is deliberate and asymmetric with settlement: charging a new name is how credit
 * actually starts in a kirana, whereas *settling* an unknown khata is always a mistake and
 * refuses.
 */
async function chargeKhata(
  tx: Tx,
  storeId: bigint,
  customerName: string,
  billId: string,
  amountPaise: number,
  invoiceNumber: string,
): Promise<void> {
  // The unique index is on lower(customer_name), so the insert is the lookup: whoever loses the
  // race does nothing and then reads the winner's row.
  await tx.insert(khataAccounts).values({ storeId, customerName }).onConflictDoNothing();

  const [account] = await tx
    .select({ id: khataAccounts.id })
    .from(khataAccounts)
    .where(
      and(
        eq(khataAccounts.storeId, storeId),
        sql`lower(${khataAccounts.customerName}) = lower(${customerName})`,
      ),
    )
    .for('update');

  if (!account) throw new Error(`Khata account for ${customerName} vanished mid-transaction.`);

  await tx
    .update(khataAccounts)
    .set({ balancePaise: sql`${khataAccounts.balancePaise} + ${amountPaise}` })
    .where(eq(khataAccounts.id, account.id));

  await tx.insert(khataEntries).values({
    accountId: account.id,
    kind: 'charge',
    amountPaise,
    billId,
    note: `Bill ${invoiceNumber}`,
  });
}

/**
 * Reverses a finalized bill.
 *
 * Nothing is deleted, ever. The bill keeps its invoice number and its totals, stock comes back
 * through `reversal` movements, and the khata charge is undone by a signed adjustment entry —
 * so the ledger still explains how the balance got where it is.
 */
export async function voidBill(storeId: bigint, billId: string): Promise<VoidResult> {
  if (!isBillId(billId)) return { status: 'bill_not_found', billId };

  return db.transaction(async (tx): Promise<VoidResult> => {
    await lockStore(tx, storeId);

    const [bill] = await tx
      .select()
      .from(bills)
      .where(and(eq(bills.storeId, storeId), eq(bills.id, billId)))
      .for('update');

    if (!bill) return { status: 'bill_not_found', billId };
    if (bill.status === 'void') {
      return { status: 'already_void', billId, invoiceNumber: bill.invoiceNumber };
    }

    // A draft never moved any stock, so voiding one is just closing it.
    if (bill.status === 'draft') {
      await tx.update(bills).set({ status: 'void' }).where(eq(bills.id, billId));
      return {
        status: 'voided',
        billId,
        invoiceNumber: bill.invoiceNumber,
        restored: [],
        khataReversedPaise: 0,
      };
    }

    const lines = await selectLines(tx, billId);
    const wanted = wantedPerProduct(lines);
    const locked = await lockProducts(tx, storeId, [...wanted.keys()]);

    for (const [productId, qtyBase] of wanted) {
      await tx
        .update(products)
        .set({ quantityBase: sql`${products.quantityBase} + ${qtyBase}` })
        .where(and(eq(products.id, productId), eq(products.storeId, storeId)));
    }

    if (lines.length > 0) {
      await tx.insert(stockMovements).values(
        lines.map((line) => ({
          storeId,
          productId: line.productId,
          kind: 'reversal' as const,
          qtyBaseDelta: line.qtyBase,
          billId,
          unitCostPaise: locked.get(line.productId)!.costPricePaise,
        })),
      );
    }

    let khataReversedPaise = 0;
    if (bill.paymentMode === 'khata' && bill.customerName && bill.totalPaise) {
      khataReversedPaise = await reverseKhata(
        tx,
        storeId,
        bill.customerName,
        billId,
        bill.totalPaise,
        bill.invoiceNumber,
      );
    }

    await tx.update(bills).set({ status: 'void' }).where(eq(bills.id, billId));

    return {
      status: 'voided',
      billId,
      invoiceNumber: bill.invoiceNumber,
      restored: [...wanted.entries()].map(([productId, qtyBase]) => ({
        name: locked.get(productId)!.name,
        quantity: formatQuantity(qtyBase, locked.get(productId)!.unit),
      })),
      khataReversedPaise,
    };
  });
}

/**
 * Undoes a khata charge with a signed `adjustment` entry.
 *
 * Sign convention for the ledger: `charge` adds, `payment` subtracts, and `adjustment` carries a
 * SIGNED amount applied as-is. A reversal is therefore a negative adjustment, which keeps the
 * append-only history readable — the charge is still there, and so is the reason it went away.
 */
async function reverseKhata(
  tx: Tx,
  storeId: bigint,
  customerName: string,
  billId: string,
  amountPaise: number,
  invoiceNumber: string | null,
): Promise<number> {
  const [account] = await tx
    .select({ id: khataAccounts.id })
    .from(khataAccounts)
    .where(
      and(
        eq(khataAccounts.storeId, storeId),
        sql`lower(${khataAccounts.customerName}) = lower(${customerName})`,
      ),
    )
    .for('update');

  if (!account) return 0;

  await tx
    .update(khataAccounts)
    .set({ balancePaise: sql`${khataAccounts.balancePaise} - ${amountPaise}` })
    .where(eq(khataAccounts.id, account.id));

  await tx.insert(khataEntries).values({
    accountId: account.id,
    kind: 'adjustment',
    amountPaise: -amountPaise,
    billId,
    note: `Reversal of ${invoiceNumber ?? 'bill'}`,
  });

  return amountPaise;
}
