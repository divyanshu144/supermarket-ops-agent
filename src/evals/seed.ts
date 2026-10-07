import type { Client } from 'pg';
import type { Scenario } from './scenario.js';

export interface FixtureBindings {
  storeIds: Record<string, string>;
  productIds: Record<string, string>;
  customerIds: Record<string, string>;
  billIds: Record<string, string>;
  sentinelProductId: string;
}

export interface ScenarioSnapshot {
  products: Array<{
    id: string;
    name: string;
    quantityBase: number;
    storeId: string;
    unit: string;
  }>;
  movements: Array<{ productId: string; kind: string; qtyBaseDelta: number }>;
  bills: Array<Record<string, unknown>>;
  billItems: Array<Record<string, unknown>>;
  accounts: Array<{ id: string; customerName: string; balancePaise: number }>;
  ledger: Array<{ accountId: string; kind: string; amountPaise: number }>;
  preferences: Array<{ key: string; value: unknown }>;
  artifacts: Array<{
    ref: string;
    mediaType: string;
    path: string;
  }>;
  sentinel: {
    products: Array<{ id: string; name: string; quantityBase: number }>;
    movements: Array<{ productId: string; kind: string; qtyBaseDelta: number }>;
    bills: Array<Record<string, unknown>>;
    billItems: Array<Record<string, unknown>>;
    accounts: Array<Record<string, unknown>>;
    ledger: Array<Record<string, unknown>>;
    preferences: Array<Record<string, unknown>>;
  };
}

/** Seeds only tables from the committed Drizzle migrations, in a transaction. */
export async function seedScenario(client: Client, scenario: Scenario): Promise<FixtureBindings> {
  const bindings: FixtureBindings = {
    storeIds: {},
    productIds: {},
    customerIds: {},
    billIds: {},
    sentinelProductId: '',
  };
  await client.query('BEGIN');
  try {
    for (const store of [scenario.seed.store, scenario.seed.sentinel]) {
      await client.query(
        'INSERT INTO stores (id, name, gstin, state_code) VALUES ($1, $2, $3, $4)',
        [store.chatId, store.name, store.gstin, store.stateCode],
      );
      bindings.storeIds[store.ref] = store.chatId;
    }
    for (const product of scenario.seed.products) {
      const result = await client.query<{ id: string }>(
        `INSERT INTO products
         (store_id, name, brand, pack_size, unit, is_loose, hsn_code, gst_rate_bps,
          cost_price_paise, mrp_paise, quantity_base, reorder_level_base)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [
          scenario.seed.store.chatId,
          product.name,
          product.brand,
          product.packSize,
          product.unit,
          product.isLoose,
          product.hsnCode,
          product.gstRateBps,
          product.costPricePaise,
          product.mrpPaise,
          product.quantityBase,
          product.reorderLevelBase,
        ],
      );
      const productId = result.rows[0]!.id;
      bindings.productIds[product.ref] = productId;
      if (product.quantityBase > 0) {
        await client.query(
          `INSERT INTO stock_movements (store_id, product_id, kind, qty_base_delta, unit_cost_paise, created_at)
           VALUES ($1, $2, 'receive', $3, $4, $5)`,
          [
            scenario.seed.store.chatId,
            productId,
            product.quantityBase,
            product.costPricePaise,
            scenario.seed.anchor,
          ],
        );
      }
    }
    const sentinel = await client.query<{ id: string }>(
      `INSERT INTO products (store_id, name, unit, is_loose, hsn_code, gst_rate_bps, cost_price_paise, mrp_paise, quantity_base, reorder_level_base)
       VALUES ($1, $2, 'packet', false, '99999999', 0, 100, 150, 3, 1) RETURNING id`,
      [scenario.seed.sentinel.chatId, `Eval sentinel ${scenario.id}`],
    );
    bindings.sentinelProductId = sentinel.rows[0]!.id;
    await client.query(
      `INSERT INTO stock_movements (store_id, product_id, kind, qty_base_delta, unit_cost_paise, created_at)
       VALUES ($1, $2, 'receive', 3, 100, $3)`,
      [scenario.seed.sentinel.chatId, bindings.sentinelProductId, scenario.seed.anchor],
    );
    for (const customer of scenario.seed.customers) {
      const result = await client.query<{ id: string }>(
        'INSERT INTO khata_accounts (store_id, customer_name, phone, balance_paise) VALUES ($1, $2, $3, 0) RETURNING id',
        [scenario.seed.store.chatId, customer.name, customer.phone],
      );
      const accountId = result.rows[0]!.id;
      bindings.customerIds[customer.ref] = accountId;
      const entries = scenario.seed.ledger.filter((entry) => entry.customerRef === customer.ref);
      let balance = 0;
      for (const entry of entries) {
        balance +=
          entry.kind === 'charge'
            ? entry.amountPaise
            : entry.kind === 'payment'
              ? -entry.amountPaise
              : entry.amountPaise;
        await client.query(
          'INSERT INTO khata_entries (account_id, kind, amount_paise, note, created_at) VALUES ($1, $2, $3, $4, $5)',
          [accountId, entry.kind, entry.amountPaise, entry.note, entry.at],
        );
      }
      if (balance !== customer.openingBalancePaise) {
        throw new Error(
          `Ledger entries for ${customer.ref} sum to ${balance}, not opening balance ${customer.openingBalancePaise}`,
        );
      }
      await client.query('UPDATE khata_accounts SET balance_paise = $2 WHERE id = $1', [
        accountId,
        balance,
      ]);
    }
    for (const preference of scenario.seed.preferences) {
      await client.query(
        'INSERT INTO preferences (store_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, $4)',
        [
          scenario.seed.store.chatId,
          preference.key,
          JSON.stringify(preference.value),
          scenario.seed.anchor,
        ],
      );
    }
    await client.query('COMMIT');
    return bindings;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/** A persisted /new-equivalent for fixture orchestration. It clears only conversation state. */
export async function clearScenarioConversation(client: Client, storeId: string): Promise<void> {
  await client.query('BEGIN');
  try {
    const session = await client.query<{ agent_session_id: string }>(
      'SELECT agent_session_id FROM sessions WHERE store_id = $1',
      [storeId],
    );
    if (session.rows[0]) {
      await client.query('DELETE FROM session_entries WHERE session_id = $1', [
        session.rows[0].agent_session_id,
      ]);
    }
    await client.query('DELETE FROM sessions WHERE store_id = $1', [storeId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/** Read-only, store-scoped state capture; callers take this before and after every owner step. */
export async function snapshotScenario(
  client: Client,
  storeId: string,
  artifacts: ScenarioSnapshot['artifacts'] = [],
  sentinelStoreId?: string,
): Promise<ScenarioSnapshot> {
  // pg.Client serializes concurrent statements internally, but Promise.all still overlaps
  // calls on one client and is deprecated by pg. Keep one ordered round trip at a time.
  const products = await client.query(
    'SELECT id, name, quantity_base, store_id, unit FROM products WHERE store_id = $1 ORDER BY name, id',
    [storeId],
  );
  const movements = await client.query(
    'SELECT product_id, kind, qty_base_delta FROM stock_movements WHERE store_id = $1 ORDER BY created_at, id',
    [storeId],
  );
  const bills = await client.query(
    'SELECT id, status, customer_name, payment_mode, payment_ref, subtotal_paise, cgst_paise, sgst_paise, round_off_paise, total_paise, invoice_number, created_at, finalized_at FROM bills WHERE store_id = $1 ORDER BY created_at, id',
    [storeId],
  );
  const billItems = await client.query(
    'SELECT bi.bill_id, bi.product_id, bi.line_no, bi.qty_base, bi.unit_price_paise, bi.gst_rate_bps, p.unit FROM bill_items bi JOIN bills b ON b.id = bi.bill_id JOIN products p ON p.id = bi.product_id WHERE b.store_id = $1 ORDER BY bi.bill_id, bi.line_no',
    [storeId],
  );
  const accounts = await client.query(
    'SELECT id, customer_name, balance_paise FROM khata_accounts WHERE store_id = $1 ORDER BY customer_name, id',
    [storeId],
  );
  const ledger = await client.query(
    'SELECT e.account_id, e.kind, e.amount_paise FROM khata_entries e JOIN khata_accounts a ON a.id = e.account_id WHERE a.store_id = $1 ORDER BY e.created_at, e.id',
    [storeId],
  );
  const preferences = await client.query(
    'SELECT key, value FROM preferences WHERE store_id = $1 ORDER BY key',
    [storeId],
  );
  const sentinel = sentinelStoreId
    ? {
        products: await client.query(
          'SELECT id, name, quantity_base FROM products WHERE store_id = $1 ORDER BY id',
          [sentinelStoreId],
        ),
        movements: await client.query(
          'SELECT product_id, kind, qty_base_delta FROM stock_movements WHERE store_id = $1 ORDER BY created_at, id',
          [sentinelStoreId],
        ),
        bills: await client.query(
          'SELECT id, status, payment_mode, total_paise, invoice_number FROM bills WHERE store_id = $1 ORDER BY id',
          [sentinelStoreId],
        ),
        billItems: await client.query(
          'SELECT bi.bill_id, bi.product_id, bi.line_no, bi.qty_base, bi.unit_price_paise FROM bill_items bi JOIN bills b ON b.id = bi.bill_id WHERE b.store_id = $1 ORDER BY bi.bill_id, bi.line_no',
          [sentinelStoreId],
        ),
        accounts: await client.query(
          'SELECT id, customer_name, balance_paise FROM khata_accounts WHERE store_id = $1 ORDER BY id',
          [sentinelStoreId],
        ),
        ledger: await client.query(
          'SELECT e.account_id, e.kind, e.amount_paise FROM khata_entries e JOIN khata_accounts a ON a.id = e.account_id WHERE a.store_id = $1 ORDER BY e.id',
          [sentinelStoreId],
        ),
        preferences: await client.query(
          'SELECT key, value FROM preferences WHERE store_id = $1 ORDER BY key',
          [sentinelStoreId],
        ),
      }
    : {
        products: { rows: [] },
        movements: { rows: [] },
        bills: { rows: [] },
        billItems: { rows: [] },
        accounts: { rows: [] },
        ledger: { rows: [] },
        preferences: { rows: [] },
      };
  return {
    products: products.rows.map((r) => ({
      id: r.id,
      name: r.name,
      quantityBase: Number(r.quantity_base),
      storeId: String(r.store_id),
      unit: String(r.unit),
    })),
    movements: movements.rows.map((r) => ({
      productId: r.product_id,
      kind: r.kind,
      qtyBaseDelta: Number(r.qty_base_delta),
    })),
    bills: bills.rows,
    billItems: billItems.rows,
    accounts: accounts.rows.map((r) => ({
      id: r.id,
      customerName: r.customer_name,
      balancePaise: Number(r.balance_paise),
    })),
    ledger: ledger.rows.map((r) => ({
      accountId: r.account_id,
      kind: r.kind,
      amountPaise: Number(r.amount_paise),
    })),
    preferences: preferences.rows.map((r) => ({ key: r.key, value: r.value })),
    artifacts,
    sentinel: {
      products: sentinel.products.rows.map((r: Record<string, unknown>) => ({
        id: String(r.id),
        name: String(r.name),
        quantityBase: Number(r.quantity_base),
      })),
      movements: sentinel.movements.rows.map((r: Record<string, unknown>) => ({
        productId: String(r.product_id),
        kind: String(r.kind),
        qtyBaseDelta: Number(r.qty_base_delta),
      })),
      bills: sentinel.bills.rows,
      billItems: sentinel.billItems.rows,
      accounts: sentinel.accounts.rows,
      ledger: sentinel.ledger.rows,
      preferences: sentinel.preferences.rows,
    },
  };
}

export async function observeScenarioStep<T>(
  client: Client,
  storeId: string,
  sentinelStoreId: string,
  action: () => Promise<T>,
  artifacts: (value: T) => ScenarioSnapshot['artifacts'] = () => [],
): Promise<{ before: ScenarioSnapshot; value: T; after: ScenarioSnapshot }> {
  const before = await snapshotScenario(client, storeId, [], sentinelStoreId);
  const value = await action();
  const after = await snapshotScenario(client, storeId, artifacts(value), sentinelStoreId);
  return { before, value, after };
}
