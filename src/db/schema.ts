import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const unitEnum = pgEnum('unit', ['kg', 'g', 'litre', 'ml', 'packet', 'dozen', 'piece']);

export const stores = pgTable('stores', {
  id: bigint('id', { mode: 'bigint' }).primaryKey(),
  name: text('name').notNull(),
  gstin: text('gstin').notNull(),
  stateCode: text('state_code').notNull().default('27'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: bigint('store_id', { mode: 'bigint' })
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    brand: text('brand'),
    packSize: text('pack_size'),
    unit: unitEnum('unit').notNull(),
    isLoose: boolean('is_loose').notNull().default(false),
    hsnCode: text('hsn_code').notNull(),
    gstRateBps: integer('gst_rate_bps').notNull(),
    costPricePaise: bigint('cost_price_paise', { mode: 'number' }).notNull(),
    mrpPaise: bigint('mrp_paise', { mode: 'number' }).notNull(),
    quantityBase: bigint('quantity_base', { mode: 'number' }).notNull().default(0),
    reorderLevelBase: bigint('reorder_level_base', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    uniqueIndex('products_store_name_uq').on(t.storeId, t.name),
    index('products_store_idx').on(t.storeId),
    check('products_qty_non_negative', sql`${t.quantityBase} >= 0`),
  ],
);

export const updateStatusEnum = pgEnum('update_status', ['claimed', 'done']);
export const billStatusEnum = pgEnum('bill_status', ['draft', 'finalized', 'void']);
export const paymentModeEnum = pgEnum('payment_mode', ['cash', 'upi', 'card', 'khata']);
export const khataKindEnum = pgEnum('khata_kind', ['charge', 'payment', 'adjustment']);
export const movementKindEnum = pgEnum('movement_kind', ['receive', 'sale', 'adjust', 'reversal']);

/**
 * Telegram update dedupe — a CLAIM, not a completion marker.
 *
 * Under long-polling Telegram only redelivers when the offset did not advance, i.e. exactly
 * when the previous attempt crashed mid-turn. An insert-on-receipt dedupe would reject
 * precisely the redelivery that must be reprocessed, silently losing the owner's message.
 */
export const processedUpdates = pgTable('processed_updates', {
  updateId: bigint('update_id', { mode: 'bigint' }).primaryKey(),
  chatId: bigint('chat_id', { mode: 'bigint' }).notNull(),
  status: updateStatusEnum('status').notNull().default('claimed'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export const sessions = pgTable('sessions', {
  storeId: bigint('store_id', { mode: 'bigint' })
    .primaryKey()
    .references(() => stores.id, { onDelete: 'cascade' }),
  agentSessionId: text('agent_session_id').notNull(),
  // Cumulative model spend for this conversation, in micro-USD. The SDK reports a resumed
  // session's total_cost_usd including earlier turns, so the per-turn cost is the difference.
  costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Behavioural defaults that survive /new — the memory-outside-the-context-window story. */
export const preferences = pgTable(
  'preferences',
  {
    storeId: bigint('store_id', { mode: 'bigint' })
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.key] })],
);

/**
 * Multiple concurrent drafts per store are deliberately legal: the brief's "two bills in
 * flight" is an intra-chat scenario, since per-chat stores never contend cross-chat.
 */
export const bills = pgTable(
  'bills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: bigint('store_id', { mode: 'bigint' })
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    status: billStatusEnum('status').notNull().default('draft'),
    customerName: text('customer_name'),
    paymentMode: paymentModeEnum('payment_mode'),
    paymentRef: text('payment_ref'),
    subtotalPaise: bigint('subtotal_paise', { mode: 'number' }),
    cgstPaise: bigint('cgst_paise', { mode: 'number' }),
    sgstPaise: bigint('sgst_paise', { mode: 'number' }),
    roundOffPaise: bigint('round_off_paise', { mode: 'number' }),
    totalPaise: bigint('total_paise', { mode: 'number' }),
    invoiceNumber: text('invoice_number'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('bills_store_invoice_uq')
      .on(t.storeId, t.invoiceNumber)
      .where(sql`${t.invoiceNumber} IS NOT NULL`),
    index('bills_store_created_idx').on(t.storeId, t.createdAt),
    // A finalized bill without an invoice number is not a valid tax document. The repository
    // assumes this when it replays an already-finalized bill; the constraint is what makes that
    // an guarantee rather than a hope.
    check(
      'bills_finalized_has_invoice',
      sql`${t.status} <> 'finalized' OR ${t.invoiceNumber} IS NOT NULL`,
    ),
  ],
);

export const billItems = pgTable(
  'bill_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    billId: uuid('bill_id')
      .notNull()
      .references(() => bills.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      // Cascade so a store can be torn down cleanly. Products are never deleted in normal
      // operation — corrections go through stock_movements, never a delete.
      .references(() => products.id, { onDelete: 'cascade' }),
    /**
     * Position of the line on the bill, 1-based per bill.
     *
     * The primary key is a random uuid, so it carries no order at all: without this column
     * "which line came first" is unanswerable, and two lines of the same product at different
     * snapshotted prices would collapse unpredictably on edit and reorder themselves between
     * renders of the same invoice.
     */
    lineNo: integer('line_no').notNull(),
    qtyBase: bigint('qty_base', { mode: 'number' }).notNull(),
    // Snapshotted at add time so a bill built across turns does not shift if the product changes.
    unitPricePaise: bigint('unit_price_paise', { mode: 'number' }).notNull(),
    gstRateBps: integer('gst_rate_bps').notNull(),
    hsnCode: text('hsn_code').notNull(),
  },
  (t) => [uniqueIndex('bill_items_bill_line_uq').on(t.billId, t.lineNo)],
);

export const khataAccounts = pgTable(
  'khata_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: bigint('store_id', { mode: 'bigint' })
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    customerName: text('customer_name').notNull(),
    phone: text('phone'),
    balancePaise: bigint('balance_paise', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('khata_store_name_uq').on(t.storeId, sql`lower(${t.customerName})`)],
);

/** Append-only ledger. Balance is maintained on the account inside the same transaction. */
export const khataEntries = pgTable('khata_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => khataAccounts.id, { onDelete: 'cascade' }),
  kind: khataKindEnum('kind').notNull(),
  amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
  // SET NULL, not CASCADE: the ledger entry is the record of money owed and must outlive the
  // bill it came from. Losing a charge because a bill was removed would corrupt the balance.
  billId: uuid('bill_id').references(() => bills.id, { onDelete: 'set null' }),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Audit trail, and the source for sales velocity in the analysis deck. */
export const stockMovements = pgTable('stock_movements', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: bigint('store_id', { mode: 'bigint' })
    .notNull()
    .references(() => stores.id, { onDelete: 'cascade' }),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id, { onDelete: 'cascade' }),
  kind: movementKindEnum('kind').notNull(),
  qtyBaseDelta: bigint('qty_base_delta', { mode: 'number' }).notNull(),
  billId: uuid('bill_id').references(() => bills.id, { onDelete: 'cascade' }),
  unitCostPaise: bigint('unit_cost_paise', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Insert-first; the unique constraint IS the idempotency enforcement. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    storeId: bigint('store_id', { mode: 'bigint' })
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    operation: text('operation').notNull(),
    result: jsonb('result').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.key] })],
);

/**
 * Single-use invite codes. Only a hash is stored; the plaintext is shown once at creation.
 * `used_at` and `revoked_at` are both set by conditional UPDATEs, so a code can be redeemed
 * at most once even under concurrent redemption.
 */
export const inviteCodes = pgTable('invite_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  codeHash: text('code_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  usedByChat: bigint('used_by_chat', { mode: 'bigint' }),
  usedAt: timestamp('used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

/**
 * Model spend per store per IST day. Micro-USD integers: this is an estimate of API cost, not
 * shop money, but it is still never accumulated as a float.
 */
export const usage = pgTable(
  'usage',
  {
    storeId: bigint('store_id', { mode: 'bigint' })
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }).notNull().default(0),
    turns: integer('turns').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.day] })],
);
