import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
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
