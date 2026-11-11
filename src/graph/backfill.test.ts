import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backfillGraphHistory, mapBackfillRow } from './backfill.js';
import { reconciliationHasMismatch, type GraphReconcileReport } from './reconcile.js';

describe('graph backfill mapping', () => {
  it('maps historical product data without cost, stock or customer fields', () => {
    const event = mapBackfillRow('product', {
      cursor: 'product-1',
      store_id: '7',
      id: 'product-1',
      name: 'Rice',
      brand: null,
      pack_size: '1kg',
      unit: 'packet',
      is_loose: false,
      hsn_code: '1006',
      gst_rate_bps: 500,
      mrp_paise: '12000',
      cost_price_paise: '8000',
      quantity_base: '19',
    });
    expect(event).toMatchObject({ type: 'product', storeId: '7', mrpPaise: 12000 });
    expect(event).not.toHaveProperty('costPricePaise');
    expect(event).not.toHaveProperty('quantityBase');
  });

  it('maps audit provenance without copying arbitrary action arguments', () => {
    const event = mapBackfillRow('audit_event', {
      cursor: '12',
      store_id: '7',
      id: '12',
      action: 'adjust_stock',
      tool: 'adjust_stock',
      outcome: 'adjusted',
      update_id: '99',
      created_at: '2026-11-10T00:00:00Z',
      pending_action_id: 'action-1',
      arguments: { customer: 'private' },
    });
    expect(event).toMatchObject({ type: 'audit_event', pendingActionId: 'action-1' });
    expect(event).not.toHaveProperty('arguments');
  });

  it('persists its keyset cursor and retries an interrupted page without skipping an event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'graph-backfill-'));
    const checkpoint = join(directory, 'state.json');
    let calls = 0;
    const row = {
      cursor: '1',
      store_id: '7',
      id: '7',
      name: 'Shop',
      gstin: '27AAAAA0000A1Z5',
      state_code: '27',
      created_at: '2026-11-10T00:00:00Z',
    };
    try {
      await expect(
        backfillGraphHistory(
          async (query, values) => {
            if (query.includes('FROM stores')) {
              expect(values[0]).toBe('');
              return { rows: [row] };
            }
            return { rows: [] };
          },
          checkpoint,
          async () => {
            calls += 1;
            throw new Error('simulated interruption');
          },
        ),
      ).rejects.toThrow('simulated interruption');
      await expect(readFile(checkpoint, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      const projected = await backfillGraphHistory(
        async (query, values) => {
          if (query.includes('FROM stores')) {
            expect(values[0]).toBe('');
            return { rows: [row] };
          }
          return { rows: [] };
        },
        checkpoint,
        async () => {
          calls += 1;
        },
      );
      expect(projected).toBe(1);
      expect(calls).toBe(2);
      expect(JSON.parse(await readFile(checkpoint, 'utf8'))).toMatchObject({ store: '1' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('graph reconciliation result', () => {
  const matching: GraphReconcileReport = {
    storeId: '7',
    counts: {
      bills: { postgres: 2, neo4j: 2 },
      billItems: { postgres: 3, neo4j: 3 },
      stockMovements: { postgres: 4, neo4j: 4 },
    },
    stockMismatches: [],
  };

  it('passes only equal counts and stock sums', () => {
    expect(reconciliationHasMismatch(matching)).toBe(false);
  });

  it('flags a count mismatch and a per-product stock mismatch', () => {
    expect(
      reconciliationHasMismatch({
        ...matching,
        counts: { ...matching.counts, bills: { postgres: 2, neo4j: 1 } },
        stockMismatches: [{ productId: 'p1', postgresDelta: 5, neo4jDelta: 4 }],
      }),
    ).toBe(true);
  });

  it.each(['bills', 'billItems', 'stockMovements'] as const)(
    'flags a %s count mismatch',
    (kind) => {
      expect(
        reconciliationHasMismatch({
          ...matching,
          counts: { ...matching.counts, [kind]: { postgres: 2, neo4j: 1 } },
        }),
      ).toBe(true);
    },
  );
});
