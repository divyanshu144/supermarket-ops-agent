import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { products, stores } from '../db/schema.js';
import { newToolContext, toolContext } from './context.js';
import {
  getStockTool,
  handleGetStock,
  handleListStock,
  listStockTool,
  presentStockResult,
} from './inventory.js';
import {
  ALLOWED_TOOLS,
  FORBIDDEN_TOOLS,
  SKILL_TOOL,
  STORE_SERVER_NAME,
  STORE_TOOLS,
  STORE_TOOL_NAMES,
} from './index.js';

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
  return toolContext.run(newToolContext(storeId, 1n), fn);
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

describe('list_stock', () => {
  it('takes no parameters, so the model cannot address another store', () => {
    expect(Object.keys(listStockTool.inputSchema)).toEqual([]);
  });

  it('lists every product in this store in one call, sorted, with only the fields the model needs', async () => {
    await db.insert(products).values({
      storeId: STORE,
      name: 'Atta (loose)',
      unit: 'kg',
      isLoose: true,
      hsnCode: '11010000',
      gstRateBps: 0,
      costPricePaise: 4000,
      mrpPaise: 4500,
      quantityBase: 2000,
      reorderLevelBase: 5000,
    });
    const result = await withStore(STORE, () => handleListStock());
    expect(result.count).toBe(2);
    expect(result.items.map((i) => i.name)).toEqual(['Atta (loose)', 'Maggi 70g']);
    expect(result.items[0]).toEqual({
      name: 'Atta (loose)',
      brand: null,
      pack_size: null,
      in_stock: '2 kg',
      reorder_level: '5 kg',
      below_reorder_level: true,
      price: expect.any(String),
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain('cost');
    expect(text).not.toContain('hsn');
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // no row ids
  });

  it("never returns another store's products", async () => {
    const result = await withStore(STORE, () => handleListStock());
    expect(JSON.stringify(result)).not.toContain('Secret Stock');
  });

  it('returns an empty list, not an error, for a store with no products', async () => {
    await db.delete(products).where(eq(products.storeId, STORE));
    const result = await withStore(STORE, () => handleListStock());
    expect(result).toEqual({ count: 0, items: [] });
  });
});

describe('tool registration', () => {
  it('exposes no store_id parameter to the model', () => {
    // The security property this whole design rests on: if store_id were in the schema, a
    // prompt injection could set it.
    const schemaKeys = Object.keys(getStockTool.inputSchema);
    expect(schemaKeys).toEqual(['query']);
  });

  it('allowlists every registered store tool, and nothing else but Skill', () => {
    // A tool registered on the server but missing from the allowlist fails SILENTLY — it is
    // simply never offered to the model, with no error anywhere. This keeps the two in step.
    const expected = [
      SKILL_TOOL,
      ...STORE_TOOL_NAMES.map((n) => `mcp__${STORE_SERVER_NAME}__${n}`),
    ];
    expect(ALLOWED_TOOLS).toEqual(expected);
    expect(new Set(ALLOWED_TOOLS).size).toBe(ALLOWED_TOOLS.length); // no duplicates
  });

  it('registers a handler for every allowlisted store tool', () => {
    const registered = new Set(STORE_TOOLS.map((t) => t.name));
    for (const name of STORE_TOOL_NAMES) {
      expect(registered.has(name)).toBe(true);
    }
    expect(registered.size).toBe(STORE_TOOL_NAMES.length);
  });

  it('allowlists no built-in filesystem or shell tool', () => {
    for (const name of FORBIDDEN_TOOLS) {
      expect(ALLOWED_TOOLS).not.toContain(name);
    }
  });

  it('grants Skill without granting Read — the filesystem stays shut', () => {
    expect(ALLOWED_TOOLS).toContain('Skill');
    expect(ALLOWED_TOOLS).not.toContain('Read');
  });
});

describe('presentStockResult', () => {
  it('is JSON-serialisable — the raw row is not, because storeId is a BigInt', async () => {
    const raw = await withStore(STORE, () => handleGetStock('maggi'));

    // Regression guard: this is the bug that made the agent report "stock tool is erroring
    // out". JSON.stringify throws outright on a BigInt.
    expect(() => JSON.stringify(raw)).toThrow(/BigInt/);
    expect(() => JSON.stringify(presentStockResult(raw))).not.toThrow();
  });

  it('does not leak cost price or internal ids to the model', async () => {
    const raw = await withStore(STORE, () => handleGetStock('maggi'));
    const text = JSON.stringify(presentStockResult(raw));

    expect(text).not.toContain('costPrice');
    expect(text).not.toContain('1200'); // the cost price value itself
    expect(text).not.toContain('storeId');
    expect(text).not.toContain(String(STORE));
  });

  it('presents quantities and prices in human units', async () => {
    const raw = await withStore(STORE, () => handleGetStock('maggi'));
    const presented = presentStockResult(raw) as { product: Record<string, unknown> };

    expect(presented.product.in_stock).toBe('50 packet');
    expect(presented.product.price).toBe('₹14.00');
    expect(presented.product.gst_rate).toBe('12%');
  });

  it('tells the model not to invent a product when nothing matches', async () => {
    const raw = await withStore(STORE, () => handleGetStock('caviar'));
    const text = JSON.stringify(presentStockResult(raw));

    expect(text).toContain('not_found');
    expect(text).toMatch(/do not invent/i);
  });
});
