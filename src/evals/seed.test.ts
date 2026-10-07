import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { gradeDeterministically, type StepEvidence } from './assertions.js';
import { createSandbox } from './database.js';
import { parseScenario, type Scenario } from './scenario.js';
import { clearScenarioConversation, seedScenario, snapshotScenario } from './seed.js';

describe('snapshotScenario store-scoped row mapping (fake pg client)', () => {
  it('keeps product unit, persisted bill inputs, account, ledger and preferences in the snapshot', async () => {
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        const scoped =
          sql.includes('WHERE store_id = $1') ||
          sql.includes('WHERE a.store_id = $1') ||
          sql.includes('WHERE b.store_id = $1');
        if (sql.startsWith('SELECT id, name, quantity_base')) {
          const product: Record<string, unknown> = {
            id: 'p1',
            name: 'Atta',
            quantity_base: '7',
            store_id: '101',
            unit: 'kg',
          };
          if (!sql.slice(0, sql.indexOf(' FROM')).includes('unit')) delete product.unit;
          const rows = [product];
          return {
            rows: scoped
              ? rows
              : [
                  ...rows,
                  {
                    id: 'foreign',
                    name: 'Other',
                    quantity_base: '99',
                    store_id: '202',
                    unit: 'packet',
                  },
                ],
            rowCount: scoped ? 1 : 2,
          };
        }
        if (sql.startsWith('SELECT product_id, kind, qty_base_delta FROM stock_movements')) {
          const rows = [
            {
              product_id: values[0] === '101' ? 'p1' : 'p2',
              kind: 'receive',
              qty_base_delta: '4',
              store_id: '101',
            },
            {
              product_id: 'foreign-product',
              kind: 'receive',
              qty_base_delta: '90',
              store_id: '202',
            },
          ];
          const scopedRows = rows.filter((row) => row.store_id === values[0]);
          return {
            rows: scoped ? scopedRows : rows,
            rowCount: scoped ? scopedRows.length : rows.length,
          };
        }
        if (sql.startsWith('SELECT bi.bill_id')) {
          const row: Record<string, unknown> = {
            bill_id: 'b1',
            product_id: 'p1',
            line_no: 1,
            qty_base: '1000',
            unit_price_paise: '6200',
            gst_rate_bps: 1200,
            unit: 'kg',
          };
          const selected = sql.slice(0, sql.indexOf(' FROM'));
          const selectedFields = new Set(
            selected.split(',').map((column) => column.trim().split('.').at(-1)),
          );
          for (const field of ['qty_base', 'unit_price_paise', 'gst_rate_bps'])
            if (!selectedFields.has(field)) delete row[field];
          if (!selectedFields.has('unit')) delete row.unit;
          const rows = [row];
          return {
            rows: scoped ? rows : [...rows, { ...row, bill_id: 'foreign-bill' }],
            rowCount: scoped ? 1 : 2,
          };
        }
        if (sql.startsWith('SELECT id, status, customer_name')) {
          const row: Record<string, unknown> = {
            id: 'b1',
            status: 'finalized',
            payment_mode: 'cash',
            subtotal_paise: '5536',
            cgst_paise: '332',
            sgst_paise: '332',
            round_off_paise: '0',
            total_paise: '6200',
            invoice_number: 'INV-EVAL',
            created_at: '2026-10-06T10:00:00.000Z',
            finalized_at: '2026-10-06T10:00:00.000Z',
          };
          const selected = sql.slice(0, sql.indexOf(' FROM'));
          const selectedFields = new Set(
            selected.split(',').map((column) => column.trim().split('.').at(-1)),
          );
          for (const field of [
            'subtotal_paise',
            'cgst_paise',
            'sgst_paise',
            'round_off_paise',
            'total_paise',
          ])
            if (!selectedFields.has(field)) delete row[field];
          return { rows: [row], rowCount: 1 };
        }
        if (sql.startsWith('SELECT id, customer_name')) {
          const row: Record<string, unknown> = {
            id: 'c1',
            customer_name: 'Ravi',
            balance_paise: '500',
          };
          if (!sql.slice(0, sql.indexOf(' FROM')).includes('balance_paise'))
            delete row.balance_paise;
          return { rows: [row], rowCount: 1 };
        }
        if (sql.startsWith('SELECT e.account_id')) {
          const row: Record<string, unknown> = {
            account_id: 'c1',
            kind: 'charge',
            amount_paise: '500',
          };
          if (!sql.slice(0, sql.indexOf(' FROM')).includes('amount_paise')) delete row.amount_paise;
          return { rows: [row], rowCount: 1 };
        }
        if (sql.startsWith('SELECT key, value FROM preferences')) {
          const row: Record<string, unknown> = { key: 'default_payment_mode', value: 'cash' };
          if (!sql.slice(0, sql.indexOf(' FROM')).includes('value')) delete row.value;
          return { rows: [row], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as pg.Client;
    const snapshot = await snapshotScenario(client, '101', [], '202');
    expect(snapshot.products).toEqual([
      { id: 'p1', name: 'Atta', quantityBase: 7, storeId: '101', unit: 'kg' },
    ]);
    expect(snapshot.movements).toEqual([{ productId: 'p1', kind: 'receive', qtyBaseDelta: 4 }]);
    expect(snapshot.sentinel.movements).toEqual([
      { productId: 'foreign-product', kind: 'receive', qtyBaseDelta: 90 },
    ]);
    expect(snapshot.billItems).toHaveLength(1);
    expect(snapshot.billItems[0]).toMatchObject({
      bill_id: 'b1',
      qty_base: '1000',
      unit_price_paise: '6200',
      gst_rate_bps: 1200,
      unit: 'kg',
    });
    expect(snapshot.bills[0]).toMatchObject({
      subtotal_paise: '5536',
      cgst_paise: '332',
      sgst_paise: '332',
      round_off_paise: '0',
      total_paise: '6200',
    });
    expect(snapshot.accounts).toEqual([{ id: 'c1', customerName: 'Ravi', balancePaise: 500 }]);
    expect(snapshot.ledger).toEqual([{ accountId: 'c1', kind: 'charge', amountPaise: 500 }]);
    expect(snapshot.preferences).toEqual([{ key: 'default_payment_mode', value: 'cash' }]);
  });
});

const adminUrl = process.env.EVAL_TEST_DATABASE_ADMIN_URL;
const normalUrl = 'postgres://kirana:kirana@localhost:5435/kirana';
const manifestDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    manifestDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function syntheticScenario(): Scenario {
  return parseScenario({
    version: 1,
    id: 'synthetic-stock-receive',
    description: 'Synthetic DB fixture and explicit stock state mutation.',
    tags: ['inventory'],
    difficulty: 'normal',
    seed: {
      anchor: '2026-10-06T10:00:00.000Z',
      store: { ref: 'shop', chatId: '910001', name: 'Eval synthetic' },
      products: [
        {
          ref: 'rice',
          name: 'Rice',
          unit: 'kg',
          isLoose: true,
          hsnCode: '10061000',
          gstRateBps: 0,
          costPricePaise: 4000,
          mrpPaise: 5000,
          quantityBase: 10,
          reorderLevelBase: 2,
        },
      ],
      customers: [{ ref: 'ravi', name: 'Ravi', openingBalancePaise: 500 }],
      ledger: [
        {
          ref: 'ravi-opening',
          customerRef: 'ravi',
          kind: 'charge',
          amountPaise: 500,
          note: 'Opening balance',
          at: '2026-10-06T09:00:00.000Z',
        },
      ],
      preferences: [{ key: 'default_payment_mode', value: 'cash' }],
      sentinel: { ref: 'sentinel', chatId: '910002', name: 'Sentinel synthetic' },
    },
    steps: [
      {
        id: 'receive',
        kind: 'owner_message',
        text: 'Synthetic stock delivery fixture.',
        language: 'en',
      },
    ],
    expectations: {
      byStep: [
        {
          stepId: 'receive',
          assert: {
            state: {
              stock: [{ productRef: 'rice', quantityBase: 14 }],
              movements: [{ productRef: 'rice', kind: 'receive', qtyBaseDelta: 4 }],
              accounts: [
                {
                  customerRef: 'ravi',
                  balancePaise: 500,
                  ledger: [{ kind: 'charge', amountPaise: 500 }],
                },
              ],
              preferences: [{ key: 'default_payment_mode', value: 'cash' }],
            },
          },
        },
      ],
      final: { state: {} },
    },
  });
}

async function sandbox() {
  if (!adminUrl)
    throw new Error('Set EVAL_TEST_DATABASE_ADMIN_URL to a dedicated eval admin database.');
  const manifestDirectory = await mkdtemp(join(tmpdir(), 'eval-seed-test-'));
  manifestDirectories.push(manifestDirectory);
  return createSandbox({ adminUrl, normalUrl, manifestDirectory });
}

describe.skipIf(!adminUrl)('scenario fixture seeding and snapshots (dedicated Postgres)', () => {
  it('seeds the committed schema, applies a synthetic DB change, and independently grades state', async () => {
    const fixture = syntheticScenario();
    const isolated = await sandbox();
    const client = new pg.Client({ connectionString: isolated.workerUrl });
    try {
      await client.connect();
      const bindings = await seedScenario(client, fixture);
      const before = await snapshotScenario(
        client,
        bindings.storeIds.shop!,
        [],
        bindings.storeIds.sentinel!,
      );
      // Synthetic vertical slice: an explicit SQL state change stands in for owner/model/tool behavior.
      // No call trace or agent-quality result is manufactured from this setup.
      await client.query(
        'UPDATE products SET quantity_base = quantity_base + 4 WHERE id = $1 AND store_id = $2',
        [bindings.productIds.rice, bindings.storeIds.shop],
      );
      await client.query(
        "INSERT INTO stock_movements (store_id, product_id, kind, qty_base_delta, unit_cost_paise, created_at) VALUES ($1, $2, 'receive', 4, 4000, $3)",
        [bindings.storeIds.shop, bindings.productIds.rice, fixture.seed.anchor],
      );
      const after = await snapshotScenario(
        client,
        bindings.storeIds.shop!,
        [],
        bindings.storeIds.sentinel!,
      );
      const evidence: StepEvidence = {
        before,
        after,
        tools: [],
        reply: '',
        askedClarifyingQuestion: false,
      };
      const result = await gradeDeterministically(
        fixture.expectations.byStep[0]!.assert,
        evidence,
        bindings,
      );
      expect(result).toEqual({ pass: true, failures: [] });
      expect(after.sentinel).toEqual(before.sentinel);
      expect(after.accounts[0]?.balancePaise).toBe(500);
    } finally {
      await client.end();
      await isolated.cleanup();
    }
  });

  it('clears persisted conversation rows while preserving product, khata and preferences', async () => {
    const fixture = syntheticScenario();
    const isolated = await sandbox();
    const client = new pg.Client({ connectionString: isolated.workerUrl });
    try {
      await client.connect();
      const bindings = await seedScenario(client, fixture);
      const storeId = bindings.storeIds.shop!;
      await client.query(
        "INSERT INTO sessions (store_id, agent_session_id, cost_micro_usd) VALUES ($1, 'session-synthetic', 700)",
        [storeId],
      );
      await client.query(
        "INSERT INTO session_entries (project_key, session_id, entry) VALUES ('eval', 'session-synthetic', '{\"type\":\"message\"}'::jsonb)",
      );
      await clearScenarioConversation(client, storeId);
      const state = await snapshotScenario(client, storeId);
      expect(state.products[0]?.quantityBase).toBe(10);
      expect(state.accounts[0]?.balancePaise).toBe(500);
      expect(state.preferences).toEqual([{ key: 'default_payment_mode', value: 'cash' }]);
      expect(
        (await client.query('SELECT 1 FROM sessions WHERE store_id = $1', [storeId])).rowCount,
      ).toBe(0);
      expect(
        (await client.query("SELECT 1 FROM session_entries WHERE session_id = 'session-synthetic'"))
          .rowCount,
      ).toBe(0);
    } finally {
      await client.end();
      await isolated.cleanup();
    }
  });
});
