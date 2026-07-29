import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { products, stores } from '../db/schema.js';
import { IdempotencyIssuer, toolContext } from './context.js';
import { getStockTool, handleGetStock } from './inventory.js';
import { ALLOWED_TOOLS, STORE_SERVER_NAME } from './index.js';

const STORE = 999000005n;
const OTHER = 999000010n;

beforeEach(async () => {
  for (const id of [STORE, OTHER]) {
    await db.delete(stores).where(eq(stores.id, id));
    await db.insert(stores).values({ id, name: 'S', gstin: '27AAAAA0000A1Z5' });
  }
  await db.insert(products).values([
    {
      storeId: STORE,
      name: 'Maggi 70g',
      unit: 'packet',
      hsnCode: '19023010',
      gstRateBps: 1200,
      costPricePaise: 1200,
      mrpPaise: 1400,
      quantityBase: 50,
    },
    {
      storeId: OTHER,
      name: 'Secret Stock',
      unit: 'packet',
      hsnCode: '00000000',
      gstRateBps: 0,
      costPricePaise: 1,
      mrpPaise: 1,
      quantityBase: 7,
    },
  ]);
});

afterAll(async () => {
  for (const id of [STORE, OTHER]) await db.delete(stores).where(eq(stores.id, id));
  await pool.end();
});

function withStore<T>(storeId: bigint, fn: () => Promise<T>): Promise<T> {
  return toolContext.run({ storeId, updateId: 1n, idempotency: new IdempotencyIssuer(1n) }, fn);
}

describe('handleGetStock', () => {
  it('reads stock for the ambient store', async () => {
    const result = await withStore(STORE, () => handleGetStock('maggi'));
    expect(result.status).toBe('found');
    if (result.status === 'found') expect(result.product.quantityBase).toBe(50);
  });

  it('refuses to run without a context', async () => {
    await expect(handleGetStock('maggi')).rejects.toThrow(/outside a request context/);
  });

  it('cannot reach another store even though the product exists', async () => {
    const result = await withStore(STORE, () => handleGetStock('Secret Stock'));
    expect(result.status).toBe('not_found');
  });
});

describe('tool registration', () => {
  it('exposes no store_id parameter to the model', () => {
    // The security property this whole design rests on: if store_id were in the schema, a
    // prompt injection could set it.
    const schemaKeys = Object.keys(getStockTool.inputSchema);
    expect(schemaKeys).toEqual(['query']);
  });

  it('allowlists exactly the tools we defined, under the SDK naming convention', () => {
    expect(ALLOWED_TOOLS).toEqual([`mcp__${STORE_SERVER_NAME}__get_stock`]);
  });

  it('allowlists no built-in filesystem or shell tool', () => {
    const forbidden = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
    for (const name of forbidden) {
      expect(ALLOWED_TOOLS).not.toContain(name);
    }
  });
});
