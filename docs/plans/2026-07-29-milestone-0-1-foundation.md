# Supermarket Ops Agent — Milestones 0 & 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get a real Telegram message travelling through the Claude Agent SDK to Postgres and back on a deployed Railway instance, resolve the three assumptions that could invalidate the design, then build the exhaustively-tested pure domain layer behind that proven pipe.

**Architecture:** Telegram (grammY, long-poll) → adapter (dedupe, store resolution, context injection) → Claude Agent SDK `query()` loop with a strict tool allowlist → in-process MCP tools → Postgres via Drizzle. `store_id` and idempotency keys travel via `AsyncLocalStorage`, never as tool parameters, so the model has no argument with which to address another tenant.

**Tech Stack:** TypeScript, Node 24, pnpm, `@anthropic-ai/claude-agent-sdk`, grammY, Drizzle ORM, Postgres 16, Zod, Vitest, Docker, Railway.

**Spec:** `docs/specs/2026-07-29-supermarket-ops-agent-design.md`
**Scope:** Milestones 0 and 1 only. Milestones 2–5 get planned after Task 9's verifications land, because their outcomes can change the design.

---

## Global Constraints

- **Money is integer paise.** No floats touch money. Ever.
- **Quantities are integer base units** — grams for kg/g, millilitres for litre/ml, whole units for packet/dozen/piece. 2.5 kg is `2500`.
- **GST rates are basis points** (`0`, `500`, `1200`, `1800`), never float percentages.
- **`store_id` is never a tool parameter.** Injected server-side from the verified Telegram chat via `AsyncLocalStorage`.
- **Built-in SDK tools are disabled** via an explicit `allowedTools` allowlist. No Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch.
- **Model is `claude-opus-5`.** Adaptive thinking stays on; `effort` is the latency lever. Never `thinking: {type: "disabled"}`.
- **MRP is tax-inclusive.** GST is always back-calculated, never added on top.
- **Tax derives from the line total**, never per-unit tax multiplied by quantity.
- **Never commit on `main`.** Branch first (CLAUDE.md §6).
- Every task ends with a passing `pnpm test` and a commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `eslint.config.js`, `.prettierrc`, `vitest.config.ts` | Toolchain |
| `docker-compose.yml` | Local Postgres 16 |
| `Dockerfile` | Production image |
| `.env.example` | Documented required env vars |
| `src/config/env.ts` | Zod-validated env, fails fast at boot |
| `src/db/client.ts` | Drizzle client + pool |
| `src/db/schema.ts` | Table definitions |
| `src/db/tx.ts` | Transaction helper |
| `src/domain/money.ts` | Paise arithmetic, `divRoundHalfUp` |
| `src/domain/units.ts` | Unit ↔ base-unit conversion |
| `src/domain/gst.ts` | MRP back-calculation, line totals, CGST/SGST split |
| `src/tools/context.ts` | `AsyncLocalStorage` tool context + idempotency issuer |
| `src/tools/inventory.ts` | `get_stock` (M0), rest in M2 |
| `src/tools/index.ts` | MCP server assembly |
| `src/agent/runtime.ts` | Agent SDK `query()` wrapper, allowlist, system prompt |
| `src/repositories/stores.ts` | Store provisioning |
| `src/repositories/products.ts` | Product/stock queries |
| `src/repositories/updates.ts` | Telegram claim/done dedupe |
| `src/seed/catalogue.ts` | SKU catalogue data |
| `src/seed/index.ts` | Seed routine with relative dating |
| `src/telegram/bot.ts` | grammY wiring |
| `src/telegram/middleware.ts` | Dedupe + store resolution |
| `src/index.ts` | Entry point |

---

## Task 1: Toolchain and validated config

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc`, `.gitignore`, `.env.example`
- Create: `src/config/env.ts`
- Test: `src/config/env.test.ts`

**Interfaces:**
- Produces: `loadEnv(source?: NodeJS.ProcessEnv): Env` where `Env = { DATABASE_URL: string; TELEGRAM_BOT_TOKEN: string; ANTHROPIC_API_KEY: string; AGENT_EFFORT: 'low'|'medium'|'high'; NODE_ENV: 'development'|'production'|'test' }`. Throws on missing or invalid values.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/milestone-0-walking-skeleton
```

- [ ] **Step 2: Initialise the toolchain**

```bash
pnpm init
pnpm add @anthropic-ai/claude-agent-sdk grammy drizzle-orm pg zod dotenv
pnpm add -D typescript @types/node @types/pg vitest tsx drizzle-kit \
  eslint @eslint/js typescript-eslint prettier
```

- [ ] **Step 3: Write `package.json` scripts**

Replace the `scripts` block with:

```json
{
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "fmt": "prettier --write .",
    "fmt:check": "prettier --check .",
    "lint": "eslint .",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:up": "docker compose up -d postgres",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  }
}
```

- [ ] **Step 4: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 5: Write `.env.example` and `.gitignore`**

`.env.example`:
```
DATABASE_URL=postgres://kirana:kirana@localhost:5432/kirana
TELEGRAM_BOT_TOKEN=
ANTHROPIC_API_KEY=
AGENT_EFFORT=medium
NODE_ENV=development
```

`.gitignore`:
```
node_modules/
dist/
.env
artifacts/
```

- [ ] **Step 6: Write the failing test**

`src/config/env.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  TELEGRAM_BOT_TOKEN: 'token',
  ANTHROPIC_API_KEY: 'key',
  AGENT_EFFORT: 'medium',
  NODE_ENV: 'test',
};

describe('loadEnv', () => {
  it('returns a typed env when every value is present', () => {
    expect(loadEnv(valid).AGENT_EFFORT).toBe('medium');
  });

  it('throws naming the missing variable', () => {
    const { TELEGRAM_BOT_TOKEN, ...missing } = valid;
    expect(() => loadEnv(missing)).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('rejects an unknown effort level', () => {
    expect(() => loadEnv({ ...valid, AGENT_EFFORT: 'turbo' })).toThrow(/AGENT_EFFORT/);
  });

  it('defaults effort to medium when unset', () => {
    const { AGENT_EFFORT, ...rest } = valid;
    expect(loadEnv(rest).AGENT_EFFORT).toBe('medium');
  });
});
```

- [ ] **Step 7: Run it and confirm it fails**

Run: `pnpm test`
Expected: FAIL — cannot resolve `./env.js`.

- [ ] **Step 8: Implement `src/config/env.ts`**

```typescript
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  AGENT_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${detail}`);
  }
  return parsed.data;
}
```

- [ ] **Step 9: Run the tests**

Run: `pnpm test`
Expected: PASS, 4 tests.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: toolchain and fail-fast env validation"
```

---

## Task 2: Postgres, Drizzle, and the minimal schema

**Files:**
- Create: `docker-compose.yml`, `drizzle.config.ts`
- Create: `src/db/schema.ts`, `src/db/client.ts`
- Test: `src/db/schema.test.ts`

**Interfaces:**
- Produces: `stores` table (`id: bigint PK`, `name: text`, `gstin: text`, `stateCode: text`, `createdAt`), `products` table (`id: uuid PK`, `storeId: bigint`, `name: text`, `brand: text|null`, `packSize: text|null`, `unit: enum`, `isLoose: boolean`, `hsnCode: text`, `gstRateBps: integer`, `costPricePaise: bigint`, `mrpPaise: bigint`, `quantityBase: bigint`, `reorderLevelBase: bigint`).
- Produces: `db` — a Drizzle instance; `pool` — the `pg.Pool`.

- [ ] **Step 1: Write `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: kirana
      POSTGRES_PASSWORD: kirana
      POSTGRES_DB: kirana
    ports: ['5432:5432']
    volumes: ['kirana-pg:/var/lib/postgresql/data']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U kirana']
      interval: 3s
      retries: 10
volumes:
  kirana-pg:
```

- [ ] **Step 2: Write `drizzle.config.ts`**

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

- [ ] **Step 3: Write `src/db/schema.ts`**

```typescript
import {
  bigint, boolean, index, integer, pgEnum, pgTable,
  text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const unitEnum = pgEnum('unit', [
  'kg', 'g', 'litre', 'ml', 'packet', 'dozen', 'piece',
]);

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
  (t) => ({
    storeNameIdx: uniqueIndex('products_store_name_uq').on(t.storeId, t.name),
    storeIdx: index('products_store_idx').on(t.storeId),
    nonNegative: sql`CONSTRAINT products_qty_non_negative CHECK (quantity_base >= 0)`,
  }),
);
```

> The `CHECK (quantity_base >= 0)` constraint is the oversell backstop. If drizzle-kit does not
> emit it from the table config, add it by hand to the generated migration SQL. Verify it landed
> in Step 6 — this constraint is graded.

- [ ] **Step 4: Write `src/db/client.ts`**

```typescript
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { loadEnv } from '../config/env.js';
import * as schema from './schema.js';

const env = loadEnv();
export const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
export const db = drizzle(pool, { schema });
```

- [ ] **Step 5: Generate and apply the migration**

```bash
pnpm db:up
sleep 5
pnpm db:generate
pnpm db:migrate
```

- [ ] **Step 6: Verify the CHECK constraint exists**

```bash
docker compose exec postgres psql -U kirana -d kirana -c \
  "\d+ products" | grep -i "quantity_base >= 0"
```
Expected: a line showing the check constraint. If absent, hand-edit the generated migration in
`src/db/migrations/` to add `ALTER TABLE products ADD CONSTRAINT products_qty_non_negative CHECK (quantity_base >= 0);`, re-run `pnpm db:migrate`, and repeat this step.

- [ ] **Step 7: Write the test**

`src/db/schema.test.ts`:
```typescript
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from './client.js';
import { products, stores } from './schema.js';

const STORE_ID = 999000001n;

beforeEach(async () => {
  await db.delete(stores).where(eq(stores.id, STORE_ID));
});
afterAll(async () => {
  await db.delete(stores).where(eq(stores.id, STORE_ID));
  await pool.end();
});

describe('schema', () => {
  it('round-trips a store and a product', async () => {
    await db.insert(stores).values({ id: STORE_ID, name: 'Test Kirana', gstin: '27AAAAA0000A1Z5' });
    await db.insert(products).values({
      storeId: STORE_ID, name: 'Tata Salt 1kg', unit: 'packet', hsnCode: '25010020',
      gstRateBps: 500, costPricePaise: 2000, mrpPaise: 2800, quantityBase: 40,
    });
    const rows = await db.select().from(products).where(eq(products.storeId, STORE_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mrpPaise).toBe(2800);
  });

  it('refuses negative stock at the database level', async () => {
    await db.insert(stores).values({ id: STORE_ID, name: 'Test Kirana', gstin: '27AAAAA0000A1Z5' });
    await expect(
      db.insert(products).values({
        storeId: STORE_ID, name: 'Broken', unit: 'packet', hsnCode: '00000000',
        gstRateBps: 0, costPricePaise: 1, mrpPaise: 1, quantityBase: -1,
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 8: Run the tests**

Run: `pnpm test`
Expected: PASS. The second test proves the oversell backstop is live in the database.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: postgres, drizzle, minimal schema with non-negative stock constraint"
```

---

## Task 3: Store provisioning and product repository

**Files:**
- Create: `src/repositories/stores.ts`, `src/repositories/products.ts`
- Test: `src/repositories/stores.test.ts`, `src/repositories/products.test.ts`

**Interfaces:**
- Produces: `provisionStore(chatId: bigint): Promise<{ id: bigint; created: boolean }>` — idempotent.
- Produces: `findStock(storeId: bigint, query: string): Promise<StockResult>` where
  `type StockResult = { status: 'found'; product: ProductRow } | { status: 'ambiguous'; candidates: ProductSummary[] } | { status: 'not_found'; query: string }`
  and `type ProductSummary = { id: string; name: string; brand: string | null; packSize: string | null }`.

- [ ] **Step 1: Write the failing tests**

`src/repositories/stores.test.ts`:
```typescript
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { stores } from '../db/schema.js';
import { provisionStore } from './stores.js';

const CHAT = 999000002n;
beforeEach(async () => { await db.delete(stores).where(eq(stores.id, CHAT)); });
afterAll(async () => { await db.delete(stores).where(eq(stores.id, CHAT)); await pool.end(); });

describe('provisionStore', () => {
  it('creates a store on first contact', async () => {
    const r = await provisionStore(CHAT);
    expect(r).toEqual({ id: CHAT, created: true });
  });

  it('is idempotent on second contact', async () => {
    await provisionStore(CHAT);
    const r = await provisionStore(CHAT);
    expect(r.created).toBe(false);
  });
});
```

`src/repositories/products.test.ts`:
```typescript
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { products, stores } from '../db/schema.js';
import { findStock } from './products.js';

const STORE = 999000003n;
const OTHER = 999000004n;

beforeEach(async () => {
  await db.delete(stores).where(eq(stores.id, STORE));
  await db.delete(stores).where(eq(stores.id, OTHER));
  for (const id of [STORE, OTHER]) {
    await db.insert(stores).values({ id, name: 'S', gstin: '27AAAAA0000A1Z5' });
  }
  await db.insert(products).values([
    { storeId: STORE, name: 'Aashirvaad Atta 5kg', brand: 'Aashirvaad', packSize: '5kg',
      unit: 'packet', hsnCode: '11010000', gstRateBps: 500,
      costPricePaise: 22000, mrpPaise: 26000, quantityBase: 12 },
    { storeId: STORE, name: 'Loose Atta', unit: 'kg', isLoose: true, hsnCode: '11010000',
      gstRateBps: 0, costPricePaise: 3800, mrpPaise: 4500, quantityBase: 25000 },
    { storeId: OTHER, name: 'Tata Salt 1kg', unit: 'packet', hsnCode: '25010020',
      gstRateBps: 500, costPricePaise: 2000, mrpPaise: 2800, quantityBase: 99 },
  ]);
});
afterAll(async () => {
  for (const id of [STORE, OTHER]) await db.delete(stores).where(eq(stores.id, id));
  await pool.end();
});

describe('findStock', () => {
  it('returns a single match', async () => {
    const r = await findStock(STORE, 'aashirvaad');
    expect(r.status).toBe('found');
  });

  it('returns candidates when the query is ambiguous', async () => {
    const r = await findStock(STORE, 'atta');
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') expect(r.candidates).toHaveLength(2);
  });

  it('reports not_found rather than inventing a product', async () => {
    const r = await findStock(STORE, 'caviar');
    expect(r.status).toBe('not_found');
  });

  it('never sees another store’s products', async () => {
    const r = await findStock(STORE, 'tata salt');
    expect(r.status).toBe('not_found');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/repositories/stores.ts`**

```typescript
import { db } from '../db/client.js';
import { stores } from '../db/schema.js';

const DEFAULT_NAME = 'Sharma Kirana Store';
const DEFAULT_GSTIN = '27AAAAA0000A1Z5';

export async function provisionStore(chatId: bigint): Promise<{ id: bigint; created: boolean }> {
  const inserted = await db
    .insert(stores)
    .values({ id: chatId, name: DEFAULT_NAME, gstin: DEFAULT_GSTIN })
    .onConflictDoNothing()
    .returning({ id: stores.id });
  return { id: chatId, created: inserted.length > 0 };
}
```

- [ ] **Step 4: Implement `src/repositories/products.ts`**

```typescript
import { and, eq, ilike, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { products } from '../db/schema.js';

export type ProductRow = typeof products.$inferSelect;
export type ProductSummary = Pick<ProductRow, 'id' | 'name' | 'brand' | 'packSize'>;

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
    candidates: rows.map((r) => ({ id: r.id, name: r.name, brand: r.brand, packSize: r.packSize })),
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test`
Expected: PASS. Note the fourth `findStock` test is the tenancy proof — it must pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: store provisioning and store-scoped product lookup"
```

---

## Task 4: Tool context and the idempotency issuer

This is the security-critical task. `store_id` must be unreachable from tool schemas.

**Files:**
- Create: `src/tools/context.ts`
- Test: `src/tools/context.test.ts`

**Interfaces:**
- Produces: `toolContext: AsyncLocalStorage<ToolContext>` where `ToolContext = { storeId: bigint; updateId: bigint; idempotency: IdempotencyIssuer }`.
- Produces: `requireContext(): ToolContext` — throws if called outside a run.
- Produces: `class IdempotencyIssuer { constructor(updateId: bigint); next(toolName: string, args: unknown): string }`.

- [ ] **Step 1: Write the failing test**

`src/tools/context.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import { IdempotencyIssuer, requireContext, toolContext } from './context.js';

describe('requireContext', () => {
  it('throws outside a run', () => {
    expect(() => requireContext()).toThrow(/outside a request context/);
  });

  it('returns the ambient context inside a run', () => {
    const ctx = { storeId: 7n, updateId: 1n, idempotency: new IdempotencyIssuer(1n) };
    toolContext.run(ctx, () => {
      expect(requireContext().storeId).toBe(7n);
    });
  });
});

describe('IdempotencyIssuer', () => {
  it('gives identical calls distinct ordinals', () => {
    const issuer = new IdempotencyIssuer(42n);
    const a = issuer.next('add_bill_item', { sku: 'maggi', qty: 2 });
    const b = issuer.next('add_bill_item', { sku: 'maggi', qty: 2 });
    expect(a).not.toBe(b);
    expect(a.endsWith(':1')).toBe(true);
    expect(b.endsWith(':2')).toBe(true);
  });

  it('is stable across key order in args', () => {
    const one = new IdempotencyIssuer(42n).next('t', { a: 1, b: 2 });
    const two = new IdempotencyIssuer(42n).next('t', { b: 2, a: 1 });
    expect(one).toBe(two);
  });

  it('separates different tools and different args', () => {
    const issuer = new IdempotencyIssuer(42n);
    expect(issuer.next('a', {})).not.toBe(issuer.next('b', {}));
    expect(issuer.next('a', { q: 1 })).not.toBe(issuer.next('a', { q: 2 }));
  });

  it('replays an identical call sequence to identical keys', () => {
    // Two issuers for the same update_id, given the same calls in the same order, must
    // produce the same keys — that is what makes a reprocessed turn return stored results
    // rather than re-applying them.
    const first = new IdempotencyIssuer(42n);
    const second = new IdempotencyIssuer(42n);
    const runOne = [first.next('t', { q: 1 }), first.next('t', { q: 1 })];
    const runTwo = [second.next('t', { q: 1 }), second.next('t', { q: 1 })];
    expect(runOne).toEqual(runTwo);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/tools/context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/tools/context.ts`**

```typescript
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

/** Deterministic JSON: object keys sorted so arg order never changes the hash. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Issues idempotency keys of the form `<updateId>:<tool>:<argsHash>:<ordinal>`.
 *
 * The ordinal is what makes two legitimately identical calls in one turn — a bill with two
 * identical lines — map to two distinct keys. Without it the second call would collide with
 * the first, silently return its stored result, and become a no-op.
 */
export class IdempotencyIssuer {
  readonly #counts = new Map<string, number>();
  constructor(private readonly updateId: bigint) {}

  next(toolName: string, args: unknown): string {
    const hash = createHash('sha256').update(stableStringify(args)).digest('hex').slice(0, 16);
    const base = `${this.updateId}:${toolName}:${hash}`;
    const ordinal = (this.#counts.get(base) ?? 0) + 1;
    this.#counts.set(base, ordinal);
    return `${base}:${ordinal}`;
  }
}

export interface ToolContext {
  /** Injected from the verified Telegram chat. NEVER a tool parameter. */
  storeId: bigint;
  updateId: bigint;
  idempotency: IdempotencyIssuer;
}

export const toolContext = new AsyncLocalStorage<ToolContext>();

export function requireContext(): ToolContext {
  const ctx = toolContext.getStore();
  if (!ctx) throw new Error('Tool invoked outside a request context — refusing to execute.');
  return ctx;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test src/tools/context.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: tool context with injected store_id and ordinal idempotency keys"
```

---

## Task 5: The `get_stock` tool

**Files:**
- Create: `src/tools/inventory.ts`, `src/tools/index.ts`
- Test: `src/tools/inventory.test.ts`

**Interfaces:**
- Consumes: `requireContext()` (Task 4), `findStock()` (Task 3).
- Produces: `getStockTool` — an SDK tool object; `storeToolServer` — the in-process MCP server; `ALLOWED_TOOLS: string[]` — the allowlist passed to the agent.
- Produces: `handleGetStock(query: string): Promise<StockResult>` — the handler, exported separately so it is testable without the SDK.

- [ ] **Step 1: Confirm the SDK bindings before writing code**

Open `code.claude.com/docs/en/agent-sdk` and confirm the exact export names and signatures for
`createSdkMcpServer` and `tool`, and the shape a tool handler must return. **Do not write these
from memory.** If the real names differ from the code below, adjust the code and note the
correction in `tasks/lessons.md`.

- [ ] **Step 2: Write the failing test for the handler**

`src/tools/inventory.test.ts`:
```typescript
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { products, stores } from '../db/schema.js';
import { IdempotencyIssuer, toolContext } from './context.js';
import { handleGetStock } from './inventory.js';

const STORE = 999000005n;

beforeEach(async () => {
  await db.delete(stores).where(eq(stores.id, STORE));
  await db.insert(stores).values({ id: STORE, name: 'S', gstin: '27AAAAA0000A1Z5' });
  await db.insert(products).values({
    storeId: STORE, name: 'Maggi 70g', unit: 'packet', hsnCode: '19023010',
    gstRateBps: 1200, costPricePaise: 1200, mrpPaise: 1400, quantityBase: 50,
  });
});
afterAll(async () => { await db.delete(stores).where(eq(stores.id, STORE)); await pool.end(); });

function withStore<T>(fn: () => Promise<T>): Promise<T> {
  return toolContext.run(
    { storeId: STORE, updateId: 1n, idempotency: new IdempotencyIssuer(1n) },
    fn,
  );
}

describe('handleGetStock', () => {
  it('reads stock for the ambient store', async () => {
    const r = await withStore(() => handleGetStock('maggi'));
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.product.quantityBase).toBe(50);
  });

  it('refuses to run without a context', async () => {
    await expect(handleGetStock('maggi')).rejects.toThrow(/outside a request context/);
  });
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `pnpm test src/tools/inventory.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/tools/inventory.ts`**

```typescript
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { findStock, type StockResult } from '../repositories/products.js';
import { requireContext } from './context.js';

/** Exported separately from the tool wrapper so it is testable without the SDK. */
export async function handleGetStock(query: string): Promise<StockResult> {
  const { storeId } = requireContext();
  return findStock(storeId, query);
}

export const getStockTool = tool(
  'get_stock',
  'Look up how much of a product is currently in stock. Accepts a partial product name such ' +
    'as "sugar", "maggi" or "aashirvaad". If the name matches more than one product, the result ' +
    'lists the candidates so you can ask the owner which one they mean.',
  // NOTE: no store_id. Tenancy is injected server-side and is not addressable by the model.
  { query: z.string().min(1).describe('Partial or full product name to look up.') },
  async ({ query }) => {
    const result = await handleGetStock(query);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
);
```

- [ ] **Step 5: Implement `src/tools/index.ts`**

```typescript
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { getStockTool } from './inventory.js';

export const STORE_SERVER_NAME = 'store';

export const storeToolServer = createSdkMcpServer({
  name: STORE_SERVER_NAME,
  version: '0.1.0',
  tools: [getStockTool],
});

/**
 * The complete allowlist. Every built-in SDK tool — Bash, Read, Write, Edit, Glob, Grep,
 * WebSearch, WebFetch — is absent by design. A Telegram bot is an open input channel and
 * those tools behind it are a live shell.
 */
export const ALLOWED_TOOLS = [`mcp__${STORE_SERVER_NAME}__get_stock`];
```

> Confirm the `mcp__<server>__<tool>` naming convention against the SDK docs in Step 1. If it
> differs, fix `ALLOWED_TOOLS` — an allowlist with a wrong name silently blocks every tool.

- [ ] **Step 6: Run the tests**

Run: `pnpm test src/tools/inventory.test.ts`
Expected: PASS, 2 tests. The second proves a tool cannot execute without an injected store.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: get_stock tool with server-side tenancy injection and strict allowlist"
```

---

## Task 6: Agent runtime

**Files:**
- Create: `src/agent/runtime.ts`
- Test: `src/agent/runtime.smoke.ts` (a script, not a unit test — it calls the real API)

**Interfaces:**
- Consumes: `storeToolServer`, `ALLOWED_TOOLS` (Task 5).
- Produces: `runAgent(input: { text: string; sessionId?: string }): Promise<{ reply: string; sessionId: string; toolsUsed: string[] }>`.

- [ ] **Step 1: Confirm `query()` options against the docs**

Confirm from `code.claude.com/docs/en/agent-sdk`: the `query()` signature, how `mcpServers` and
`allowedTools` are passed, how to set `model` and `effort`, how session resume works, and how to
read assistant text and tool-use events off the returned stream. Write the implementation to
match what you find, not the sketch below.

- [ ] **Step 2: Implement `src/agent/runtime.ts`**

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadEnv } from '../config/env.js';
import { ALLOWED_TOOLS, STORE_SERVER_NAME, storeToolServer } from '../tools/index.js';

const env = loadEnv();

const SYSTEM_PROMPT = `
You run a small Indian kirana store for its owner, over Telegram.

The owner types tersely, the way a shopkeeper actually talks. Match that register: short,
direct, no preamble. Amounts are in rupees (₹).

Every price, GST rate and stock figure comes from your tools. Never state a price or a
quantity you have not read from a tool. If a tool reports that a product name matches more
than one product, ask the owner which one they mean rather than guessing. If it reports the
product is unknown, say so plainly.
`.trim();

export interface AgentResult {
  reply: string;
  sessionId: string;
  toolsUsed: string[];
}

export async function runAgent(input: { text: string; sessionId?: string }): Promise<AgentResult> {
  const stream = query({
    prompt: input.text,
    options: {
      model: 'claude-opus-5',
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { [STORE_SERVER_NAME]: storeToolServer },
      allowedTools: ALLOWED_TOOLS,
      resume: input.sessionId,
      // Adaptive thinking stays on. `effort` is the latency lever — never disable thinking,
      // which on Opus 5 can emit tool calls as plain text that silently never run.
      effort: env.AGENT_EFFORT,
    },
  });

  const chunks: string[] = [];
  const toolsUsed: string[] = [];
  let sessionId = input.sessionId ?? '';

  for await (const message of stream) {
    if (message.type === 'system' && 'session_id' in message) {
      sessionId = String(message.session_id);
    }
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') chunks.push(block.text);
        if (block.type === 'tool_use') toolsUsed.push(block.name);
      }
    }
  }

  return { reply: chunks.join('').trim(), sessionId, toolsUsed };
}
```

- [ ] **Step 3: Write the smoke script**

`src/agent/runtime.smoke.ts`:
```typescript
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { products, stores } from '../db/schema.js';
import { IdempotencyIssuer, toolContext } from '../tools/context.js';
import { runAgent } from './runtime.js';

const STORE = 999000006n;

async function main() {
  await db.delete(stores).where(eq(stores.id, STORE));
  await db.insert(stores).values({ id: STORE, name: 'Smoke Kirana', gstin: '27AAAAA0000A1Z5' });
  await db.insert(products).values({
    storeId: STORE, name: 'Sugar (loose)', unit: 'kg', isLoose: true, hsnCode: '17019990',
    gstRateBps: 0, costPricePaise: 4200, mrpPaise: 5200, quantityBase: 18_000,
  });

  const started = Date.now();
  const result = await toolContext.run(
    { storeId: STORE, updateId: 1n, idempotency: new IdempotencyIssuer(1n) },
    () => runAgent({ text: 'how much sugar is left?' }),
  );
  const elapsed = Date.now() - started;

  console.log('reply     :', result.reply);
  console.log('toolsUsed :', result.toolsUsed);
  console.log('latency   :', `${elapsed}ms`);

  if (result.toolsUsed.length === 0) throw new Error('FAIL: agent answered without calling a tool');
  if (!/18|eighteen/i.test(result.reply)) throw new Error('FAIL: reply does not reflect real stock');
  console.log('PASS');

  await db.delete(stores).where(eq(stores.id, STORE));
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: Run the smoke script**

Run: `pnpm tsx src/agent/runtime.smoke.ts`
Expected: prints a reply mentioning 18 kg, a non-empty `toolsUsed`, and a latency figure. **Record the latency in `tasks/agent_memory.md`** — it feeds the Task 9 effort decision.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: agent runtime with allowlisted tools and grounded system prompt"
```

---

## Task 7: Telegram adapter with claim/done dedupe

**Files:**
- Create: `src/repositories/updates.ts`, `src/telegram/bot.ts`, `src/index.ts`
- Modify: `src/db/schema.ts` (add `processed_updates`, `sessions`)
- Test: `src/repositories/updates.test.ts`

**Interfaces:**
- Consumes: `provisionStore` (Task 3), `runAgent` (Task 6), `toolContext` (Task 4).
- Produces: `claimUpdate(updateId: bigint, chatId: bigint): Promise<'claimed' | 'duplicate' | 'reclaimed'>`, `completeUpdate(updateId: bigint): Promise<void>`.
- Produces: `getSessionId(storeId)`, `setSessionId(storeId, sessionId)`, `clearSession(storeId)`.

- [ ] **Step 1: Add the tables to `src/db/schema.ts`**

```typescript
export const updateStatusEnum = pgEnum('update_status', ['claimed', 'done']);

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
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Then: `pnpm db:generate && pnpm db:migrate`

- [ ] **Step 2: Write the failing test**

`src/repositories/updates.test.ts`:
```typescript
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { processedUpdates } from '../db/schema.js';
import { claimUpdate, completeUpdate } from './updates.js';

const UPD = 88800001n;
const CHAT = 999000007n;

beforeEach(async () => { await db.delete(processedUpdates).where(eq(processedUpdates.updateId, UPD)); });
afterAll(async () => {
  await db.delete(processedUpdates).where(eq(processedUpdates.updateId, UPD));
  await pool.end();
});

describe('claimUpdate', () => {
  it('claims an unseen update', async () => {
    expect(await claimUpdate(UPD, CHAT)).toBe('claimed');
  });

  it('rejects a redelivery of a completed update', async () => {
    await claimUpdate(UPD, CHAT);
    await completeUpdate(UPD);
    expect(await claimUpdate(UPD, CHAT)).toBe('duplicate');
  });

  it('RECLAIMS a stale claim so a crashed turn is reprocessed', async () => {
    // This is the finding-4 regression test. A naive insert-on-receipt dedupe returns
    // 'duplicate' here and the owner's message is silently lost.
    await claimUpdate(UPD, CHAT);
    await db
      .update(processedUpdates)
      .set({ claimedAt: sql`now() - interval '10 minutes'` })
      .where(eq(processedUpdates.updateId, UPD));
    expect(await claimUpdate(UPD, CHAT)).toBe('reclaimed');
  });

  it('does not reclaim a fresh in-flight claim', async () => {
    await claimUpdate(UPD, CHAT);
    expect(await claimUpdate(UPD, CHAT)).toBe('duplicate');
  });
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `pnpm test src/repositories/updates.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/repositories/updates.ts`**

```typescript
import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { processedUpdates, sessions } from '../db/schema.js';

/** A turn still 'claimed' after this long is assumed to have died mid-handling. */
const STALE_AFTER = "interval '5 minutes'";

export type ClaimResult = 'claimed' | 'duplicate' | 'reclaimed';

/**
 * Claim an update for processing.
 *
 * This is deliberately a CLAIM, not a completion marker. Under long-polling Telegram only
 * redelivers when the offset did not advance — i.e. exactly when the previous attempt crashed
 * mid-turn. An insert-on-receipt dedupe would reject precisely the redelivery that must be
 * reprocessed, and the owner's message would vanish with no error anywhere.
 */
export async function claimUpdate(updateId: bigint, chatId: bigint): Promise<ClaimResult> {
  const inserted = await db
    .insert(processedUpdates)
    .values({ updateId, chatId, status: 'claimed' })
    .onConflictDoNothing()
    .returning({ updateId: processedUpdates.updateId });
  if (inserted.length > 0) return 'claimed';

  const reclaimed = await db
    .update(processedUpdates)
    .set({ claimedAt: sql`now()` })
    .where(
      and(
        eq(processedUpdates.updateId, updateId),
        eq(processedUpdates.status, 'claimed'),
        lt(processedUpdates.claimedAt, sql`now() - ${sql.raw(STALE_AFTER)}`),
      ),
    )
    .returning({ updateId: processedUpdates.updateId });

  return reclaimed.length > 0 ? 'reclaimed' : 'duplicate';
}

export async function completeUpdate(updateId: bigint): Promise<void> {
  await db
    .update(processedUpdates)
    .set({ status: 'done', completedAt: sql`now()` })
    .where(eq(processedUpdates.updateId, updateId));
}

export async function getSessionId(storeId: bigint): Promise<string | undefined> {
  const rows = await db.select().from(sessions).where(eq(sessions.storeId, storeId)).limit(1);
  return rows[0]?.agentSessionId;
}

export async function setSessionId(storeId: bigint, agentSessionId: string): Promise<void> {
  await db
    .insert(sessions)
    .values({ storeId, agentSessionId })
    .onConflictDoUpdate({
      target: sessions.storeId,
      set: { agentSessionId, updatedAt: sql`now()` },
    });
}

export async function clearSession(storeId: bigint): Promise<void> {
  await db.delete(sessions).where(eq(sessions.storeId, storeId));
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test src/repositories/updates.test.ts`
Expected: PASS, 4 tests. The third is the regression test for the lost-message bug.

- [ ] **Step 6: Implement `src/telegram/bot.ts`**

```typescript
import { Bot } from 'grammy';
import { loadEnv } from '../config/env.js';
import { runAgent } from '../agent/runtime.js';
import { provisionStore } from '../repositories/stores.js';
import {
  claimUpdate, clearSession, completeUpdate, getSessionId, setSessionId,
} from '../repositories/updates.js';
import { IdempotencyIssuer, toolContext } from '../tools/context.js';

const env = loadEnv();
export const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

bot.command('new', async (ctx) => {
  const storeId = BigInt(ctx.chat.id);
  await provisionStore(storeId);
  await clearSession(storeId);
  await ctx.reply('Started a fresh chat. Your stock, khata and preferences are unchanged.');
});

bot.on('message:text', async (ctx) => {
  const updateId = BigInt(ctx.update.update_id);
  const storeId = BigInt(ctx.chat.id);

  const claim = await claimUpdate(updateId, storeId);
  if (claim === 'duplicate') return;

  await provisionStore(storeId);
  await ctx.replyWithChatAction('typing');

  try {
    const sessionId = await getSessionId(storeId);
    const result = await toolContext.run(
      { storeId, updateId, idempotency: new IdempotencyIssuer(updateId) },
      () => runAgent({ text: ctx.message.text, sessionId }),
    );
    if (result.sessionId) await setSessionId(storeId, result.sessionId);
    await ctx.reply(result.reply || 'Sorry, I could not work that out.');
    await completeUpdate(updateId);
  } catch (error) {
    console.error({ updateId: String(updateId), storeId: String(storeId), error });
    await ctx.reply('Something went wrong on my side. Try that again?');
    // Deliberately NOT completed: leaving the claim stale allows a later retry.
  }
});
```

- [ ] **Step 7: Implement `src/index.ts`**

```typescript
import { bot } from './telegram/bot.js';
import { loadEnv } from './config/env.js';

loadEnv(); // fail fast before opening any connection
console.log('Starting kirana agent (long-polling)…');
await bot.start();
```

- [ ] **Step 8: Run it locally and message the bot**

Run: `pnpm db:up && pnpm dev`
Then message your bot on Telegram: `how much sugar is left?`
Expected: a grounded reply. Send the same message twice quickly and confirm you get one reply per message, not duplicates.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: telegram adapter with claim/done dedupe and per-store sessions"
```

---

## Task 8: Deploy to Railway

**Files:**
- Create: `Dockerfile`, `railway.json`, `.dockerignore`

- [ ] **Step 1: Write `Dockerfile`**

```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/db/migrations ./src/db/migrations
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Write `.dockerignore`**

```
node_modules
dist
.env
.git
docs
tasks
```

- [ ] **Step 3: Write `railway.json` — replicas pinned to 1**

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "deploy": {
    "numReplicas": 1,
    "restartPolicyType": "ON_FAILURE",
    "overlapSeconds": 0
  }
}
```

> `numReplicas: 1` and `overlapSeconds: 0` are both required. Two containers long-polling one
> bot token produce 409 conflicts and dropped updates, and a rolling deploy with overlap runs
> two containers briefly. This looks fine in testing and breaks on the first redeploy.

- [ ] **Step 4: Deploy**

```bash
railway login
railway init
railway add --database postgres
railway variables set TELEGRAM_BOT_TOKEN=... ANTHROPIC_API_KEY=... AGENT_EFFORT=medium NODE_ENV=production
railway up
```

- [ ] **Step 5: Run migrations against the Railway database**

```bash
DATABASE_URL="$(railway variables get DATABASE_URL)" pnpm db:migrate
```

- [ ] **Step 6: Verify replicas and the live bot**

Confirm in the Railway dashboard that the service shows exactly 1 replica. Then message the
deployed bot and confirm you get a grounded reply. Check logs for 409 conflicts:

```bash
railway logs | grep -i conflict
```
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: dockerfile and railway deploy pinned to a single replica"
```

---

## Task 9: The three day-one verifications

Spec §14. These decide design questions that later milestones depend on.

**Files:**
- Create: `.claude/skills/probe/SKILL.md`
- Modify: `tasks/agent_memory.md`, `tasks/lessons.md`

- [ ] **Step 1: Write a trivial probe skill**

`.claude/skills/probe/SKILL.md`:
```markdown
---
name: probe
description: Use when the owner asks about the shop's mascot.
---

The shop mascot is a purple elephant named Chotu. If the owner asks about the mascot,
say exactly: "Our mascot is Chotu the purple elephant."
```

- [ ] **Step 2: Wire skill loading into the runtime**

Per the SDK docs confirmed in Task 5 Step 1, add whatever option enables skills
(`settingSources`, a skills path, or equivalent) to the `query()` options in
`src/agent/runtime.ts`. **Keep `allowedTools` exactly as it is.** The whole point is to test
skills *against* the allowlist.

- [ ] **Step 3: Probe it**

Add to `src/agent/runtime.smoke.ts` a second call, then run the script:

```typescript
const probe = await toolContext.run(
  { storeId: STORE, updateId: 2n, idempotency: new IdempotencyIssuer(2n) },
  () => runAgent({ text: 'what is our shop mascot?' }),
);
console.log('probe reply:', probe.reply);
console.log('SKILLS LOAD BEHIND ALLOWLIST:', /chotu/i.test(probe.reply) ? 'YES' : 'NO');
```

Run: `pnpm tsx src/agent/runtime.smoke.ts`

- [ ] **Step 4: Act on the result**

- **If YES** — skills work behind the allowlist. §9 stands unchanged. Record it and move on.
- **If NO** — skills need a tool the allowlist blocks. Take the fallbacks in order:
  1. Add `Read` to `ALLOWED_TOOLS` scoped to the skills directory only, if the SDK supports path scoping. Re-probe.
  2. If it does not, abandon the skills mechanism and inline the five skill bodies into the system prompt in `src/agent/runtime.ts`. This loses progressive disclosure but keeps the capability surface, and must be written up honestly in the README.

  **Do not add unscoped `Read` to the allowlist.** That reopens the filesystem to a public bot.

- [ ] **Step 5: Measure effort latency**

Run the smoke script three times at each level and record median wall-clock for the simple
stock query:

```bash
for level in low medium high; do
  echo "=== $level ==="
  for i in 1 2 3; do AGENT_EFFORT=$level pnpm tsx src/agent/runtime.smoke.ts | grep latency; done
done
```

Pick the **lowest level that still calls the tool reliably in all three runs**. A level that
answers fast without calling `get_stock` has failed, not passed — grounding beats latency.

- [ ] **Step 6: Record the outcomes**

Append to `tasks/agent_memory.md` under Architecture Decisions:
- `AD-26`: skill loading behind the allowlist — YES or NO, and which fallback was taken.
- `AD-27`: chosen `AGENT_EFFORT`, with the measured medians for all three levels.

If either verification produced a surprise, append an entry to `tasks/lessons.md`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "test: verify skill loading behind the allowlist and select effort level"
```

**Milestone 0 is complete.** A real Telegram message reaches Postgres through the agent on a
deployed instance, and the three design-critical unknowns are resolved.

---

## Task 10: `domain/money.ts`

**Files:**
- Create: `src/domain/money.ts`
- Test: `src/domain/money.test.ts`

**Interfaces:**
- Produces: `divRoundHalfUp(numerator: number, denominator: number): number`, `formatPaise(paise: number): string`, `roundToNearestRupee(paise: number): { totalPaise: number; roundOffPaise: number }`.

- [ ] **Step 1: Write the failing test**

`src/domain/money.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import { divRoundHalfUp, formatPaise, roundToNearestRupee } from './money.js';

describe('divRoundHalfUp', () => {
  it.each([
    [10, 4, 3],   // 2.5 → 3, half rounds up
    [11, 4, 3],   // 2.75 → 3
    [9, 4, 2],    // 2.25 → 2
    [7, 2, 4],    // 3.5 → 4
    [5, 1, 5],
    [0, 7, 0],
  ])('divRoundHalfUp(%i, %i) === %i', (n, d, expected) => {
    expect(divRoundHalfUp(n, d)).toBe(expected);
  });

  it('rejects non-integer input rather than silently producing float error', () => {
    expect(() => divRoundHalfUp(1.5, 2)).toThrow(/integer/);
  });

  it('rejects a zero denominator', () => {
    expect(() => divRoundHalfUp(1, 0)).toThrow(/denominator/);
  });
});

describe('roundToNearestRupee', () => {
  it.each([
    [12345, 12300, -45],
    [12355, 12400, 45],
    [12350, 12400, 50],
    [12300, 12300, 0],
  ])('roundToNearestRupee(%i) → total %i, roundOff %i', (input, total, roundOff) => {
    expect(roundToNearestRupee(input)).toEqual({ totalPaise: total, roundOffPaise: roundOff });
  });
});

describe('formatPaise', () => {
  it.each([
    [12345, '₹123.45'],
    [100, '₹1.00'],
    [5, '₹0.05'],
    [0, '₹0.00'],
  ])('formatPaise(%i) === %s', (paise, expected) => {
    expect(formatPaise(paise)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/domain/money.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/domain/money.ts`**

```typescript
/**
 * Integer division rounding half away from zero, for non-negative integers.
 *
 * Uses `floor((2n + d) / 2d)` rather than `Math.round(n / d)` so the arithmetic stays exact:
 * every intermediate is an integer well inside 2^53 for realistic paise values.
 */
export function divRoundHalfUp(numerator: number, denominator: number): number {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
    throw new Error(`divRoundHalfUp requires integer arguments, got ${numerator}/${denominator}`);
  }
  if (denominator <= 0) {
    throw new Error(`divRoundHalfUp requires a positive denominator, got ${denominator}`);
  }
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

/** Indian GST invoices show an explicit round-off line to the nearest rupee. */
export function roundToNearestRupee(paise: number): { totalPaise: number; roundOffPaise: number } {
  const totalPaise = divRoundHalfUp(paise, 100) * 100;
  return { totalPaise, roundOffPaise: totalPaise - paise };
}

export function formatPaise(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const remainder = String(paise % 100).padStart(2, '0');
  return `₹${rupees}.${remainder}`;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test src/domain/money.test.ts`
Expected: PASS, 14 assertions.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: integer paise arithmetic with half-up rounding"
```

---

## Task 11: `domain/units.ts`

**Files:**
- Create: `src/domain/units.ts`
- Test: `src/domain/units.test.ts`

**Interfaces:**
- Produces: `type Unit = 'kg'|'g'|'litre'|'ml'|'packet'|'dozen'|'piece'`.
- Produces: `toBaseUnits(qty: number, unit: Unit): number`, `baseUnitsPerSellingUnit(unit: Unit): number`, `formatQuantity(qtyBase: number, unit: Unit): string`.

- [ ] **Step 1: Write the failing test**

`src/domain/units.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import { baseUnitsPerSellingUnit, formatQuantity, toBaseUnits } from './units.js';

describe('toBaseUnits', () => {
  it.each([
    [2.5, 'kg', 2500],
    [500, 'g', 500],
    [1, 'litre', 1000],
    [750, 'ml', 750],
    [4, 'packet', 4],
    [2, 'dozen', 24],
    [3, 'piece', 3],
  ] as const)('toBaseUnits(%s, %s) === %i', (qty, unit, expected) => {
    expect(toBaseUnits(qty, unit)).toBe(expected);
  });

  it('rejects a fractional quantity for a discrete unit', () => {
    expect(() => toBaseUnits(1.5, 'packet')).toThrow(/whole/);
  });

  it('rejects a quantity finer than one base unit', () => {
    expect(() => toBaseUnits(0.0001, 'kg')).toThrow(/precision/);
  });

  it('rejects a negative quantity', () => {
    expect(() => toBaseUnits(-1, 'kg')).toThrow(/negative/);
  });
});

describe('baseUnitsPerSellingUnit', () => {
  it.each([
    ['kg', 1000], ['g', 1], ['litre', 1000], ['ml', 1],
    ['packet', 1], ['dozen', 12], ['piece', 1],
  ] as const)('%s → %i', (unit, expected) => {
    expect(baseUnitsPerSellingUnit(unit)).toBe(expected);
  });
});

describe('formatQuantity', () => {
  it.each([
    [2500, 'kg', '2.5 kg'],
    [18000, 'kg', '18 kg'],
    [500, 'g', '500 g'],
    [4, 'packet', '4 packet'],
  ] as const)('formatQuantity(%i, %s) === %s', (qty, unit, expected) => {
    expect(formatQuantity(qty, unit)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/domain/units.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/domain/units.ts`**

```typescript
export type Unit = 'kg' | 'g' | 'litre' | 'ml' | 'packet' | 'dozen' | 'piece';

const BASE_PER_SELLING: Record<Unit, number> = {
  kg: 1000, g: 1, litre: 1000, ml: 1, packet: 1, dozen: 12, piece: 1,
};

const DISCRETE: ReadonlySet<Unit> = new Set<Unit>(['packet', 'dozen', 'piece']);

export function baseUnitsPerSellingUnit(unit: Unit): number {
  return BASE_PER_SELLING[unit];
}

/** Converts a human quantity into integer base units. 2.5 kg → 2500. */
export function toBaseUnits(qty: number, unit: Unit): number {
  if (qty < 0) throw new Error(`Quantity cannot be negative: ${qty}`);
  if (DISCRETE.has(unit) && !Number.isInteger(qty)) {
    throw new Error(`${unit} must be a whole number, got ${qty}`);
  }
  const exact = qty * BASE_PER_SELLING[unit];
  const rounded = Math.round(exact);
  if (Math.abs(exact - rounded) > 1e-6) {
    throw new Error(`Quantity ${qty} ${unit} is below the precision of one base unit`);
  }
  return rounded;
}

export function formatQuantity(qtyBase: number, unit: Unit): string {
  const per = BASE_PER_SELLING[unit];
  const value = qtyBase / per;
  const text = Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
  return `${text} ${unit}`;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test src/domain/units.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: unit conversion to integer base units"
```

---

## Task 12: `domain/gst.ts` — the graded arithmetic

**Files:**
- Create: `src/domain/gst.ts`
- Test: `src/domain/gst.test.ts`

**Interfaces:**
- Consumes: `divRoundHalfUp` (Task 10), `baseUnitsPerSellingUnit`, `Unit` (Task 11).
- Produces: `lineTotalPaise(mrpPaise: number, qtyBase: number, unit: Unit): number`.
- Produces: `taxBreakdown(lineTotalPaise: number, gstRateBps: number): { taxablePaise: number; gstPaise: number; cgstPaise: number; sgstPaise: number }`.
- Produces: `computeLine(input: { mrpPaise: number; qtyBase: number; unit: Unit; gstRateBps: number }): LineAmounts` where `LineAmounts = { lineTotalPaise: number; taxablePaise: number; gstPaise: number; cgstPaise: number; sgstPaise: number }`.

- [ ] **Step 1: Write the failing test**

`src/domain/gst.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import { computeLine, lineTotalPaise, taxBreakdown } from './gst.js';

describe('lineTotalPaise', () => {
  it('multiplies a packaged item by whole packets', () => {
    expect(lineTotalPaise(1400, 4, 'packet')).toBe(5600);
  });

  it('divides correctly for loose goods priced per kg', () => {
    // 2.5 kg of sugar at ₹52/kg
    expect(lineTotalPaise(5200, 2500, 'kg')).toBe(13000);
  });

  it('rounds the loose-goods division half-up, once', () => {
    // 333 g at ₹47/kg = 1565.1 paise → 1565
    expect(lineTotalPaise(4700, 333, 'kg')).toBe(1565);
  });
});

describe('taxBreakdown', () => {
  it('back-calculates GST out of a tax-inclusive MRP', () => {
    // Amul Butter 100g, MRP ₹62, 12%. Customer pays ₹62, never ₹69.44.
    const r = taxBreakdown(6200, 1200);
    expect(r.taxablePaise).toBe(5536);
    expect(r.gstPaise).toBe(664);
    expect(r.taxablePaise + r.gstPaise).toBe(6200);
  });

  it('gives odd paise to SGST so the halves always sum to the whole', () => {
    const r = taxBreakdown(6200, 1200); // gst 664 → 332/332
    expect(r.cgstPaise + r.sgstPaise).toBe(r.gstPaise);
    const odd = taxBreakdown(2100, 500);
    expect(odd.cgstPaise + odd.sgstPaise).toBe(odd.gstPaise);
    expect(odd.sgstPaise - odd.cgstPaise).toBeLessThanOrEqual(1);
  });

  it('treats a 0% item as fully taxable with no GST', () => {
    const r = taxBreakdown(13000, 0);
    expect(r).toEqual({ taxablePaise: 13000, gstPaise: 0, cgstPaise: 0, sgstPaise: 0 });
  });
});

describe('computeLine — order of operations', () => {
  it('derives tax from the LINE TOTAL, not per-unit tax times quantity', () => {
    // 4 x Maggi 70g, MRP ₹14, 5%.
    // Per-unit-first would give taxable 5332. Line-total-first gives 5333.
    // Line-total-first is correct: the customer pays exactly 4 x ₹14 = ₹56.00.
    const line = computeLine({ mrpPaise: 1400, qtyBase: 4, unit: 'packet', gstRateBps: 500 });
    expect(line.lineTotalPaise).toBe(5600);
    expect(line.taxablePaise).toBe(5333);
    expect(line.gstPaise).toBe(267);
    expect(line.taxablePaise + line.gstPaise).toBe(line.lineTotalPaise);
  });

  it('never lets the parts drift from the whole across many rates and quantities', () => {
    for (const gstRateBps of [0, 500, 1200, 1800]) {
      for (const qty of [1, 2, 3, 7, 13]) {
        for (const mrp of [499, 1400, 2800, 6200, 26000]) {
          const l = computeLine({ mrpPaise: mrp, qtyBase: qty, unit: 'packet', gstRateBps });
          expect(l.taxablePaise + l.gstPaise).toBe(l.lineTotalPaise);
          expect(l.cgstPaise + l.sgstPaise).toBe(l.gstPaise);
        }
      }
    }
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/domain/gst.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/domain/gst.ts`**

```typescript
import { divRoundHalfUp } from './money.js';
import { baseUnitsPerSellingUnit, type Unit } from './units.js';

export interface LineAmounts {
  lineTotalPaise: number;
  taxablePaise: number;
  gstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
}

/**
 * What the customer actually pays for this line.
 *
 * `mrpPaise` is the price per SELLING unit (per kg for loose goods, per packet for packaged);
 * `qtyBase` is in base units (grams). The division rounds half-up, once, at line level.
 */
export function lineTotalPaise(mrpPaise: number, qtyBase: number, unit: Unit): number {
  return divRoundHalfUp(mrpPaise * qtyBase, baseUnitsPerSellingUnit(unit));
}

/**
 * Back-calculates GST out of a tax-inclusive amount.
 *
 * MRP in India includes all taxes, so adding GST on top would charge above the printed price,
 * which is illegal. Given ₹62 at 12%: taxable ₹55.36, GST ₹6.64, customer pays ₹62.
 *
 * Odd paise in the CGST/SGST split go to SGST, so the two halves always sum to the whole.
 */
export function taxBreakdown(
  inclusivePaise: number,
  gstRateBps: number,
): Omit<LineAmounts, 'lineTotalPaise'> {
  if (gstRateBps === 0) {
    return { taxablePaise: inclusivePaise, gstPaise: 0, cgstPaise: 0, sgstPaise: 0 };
  }
  const taxablePaise = divRoundHalfUp(inclusivePaise * 10_000, 10_000 + gstRateBps);
  const gstPaise = inclusivePaise - taxablePaise;
  const cgstPaise = Math.floor(gstPaise / 2);
  return { taxablePaise, gstPaise, cgstPaise, sgstPaise: gstPaise - cgstPaise };
}

/**
 * Tax is derived from the line total, NEVER from per-unit tax multiplied by quantity.
 * The customer pays `MRP x qty` exactly, so the taxable value must come out of that figure.
 */
export function computeLine(input: {
  mrpPaise: number;
  qtyBase: number;
  unit: Unit;
  gstRateBps: number;
}): LineAmounts {
  const total = lineTotalPaise(input.mrpPaise, input.qtyBase, input.unit);
  return { lineTotalPaise: total, ...taxBreakdown(total, input.gstRateBps) };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test src/domain/gst.test.ts`
Expected: PASS. The `computeLine` order-of-operations test is the one that would fail on a
per-unit-first implementation.

- [ ] **Step 5: Run the full gate**

Run: `pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test`
Expected: all green. Fix anything that is not before committing.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: GST back-calculation from tax-inclusive MRP with line-total-first ordering"
```

---

## Task 13: Full schema

**Files:**
- Modify: `src/db/schema.ts`
- Test: `src/db/schema.full.test.ts`

**Interfaces:**
- Produces: `preferences`, `bills`, `billItems`, `khataAccounts`, `khataEntries`, `stockMovements`, `idempotencyKeys` tables, matching spec §5.

- [ ] **Step 1: Add the remaining tables to `src/db/schema.ts`**

```typescript
export const billStatusEnum = pgEnum('bill_status', ['draft', 'finalized', 'void']);
export const paymentModeEnum = pgEnum('payment_mode', ['cash', 'upi', 'card', 'khata']);
export const khataKindEnum = pgEnum('khata_kind', ['charge', 'payment', 'adjustment']);
export const movementKindEnum = pgEnum('movement_kind', ['receive', 'sale', 'adjust', 'reversal']);

export const preferences = pgTable(
  'preferences',
  {
    storeId: bigint('store_id', { mode: 'bigint' })
      .notNull().references(() => stores.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.storeId, t.key] }) }),
);

export const bills = pgTable('bills', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: bigint('store_id', { mode: 'bigint' })
    .notNull().references(() => stores.id, { onDelete: 'cascade' }),
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
});

export const billItems = pgTable('bill_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  billId: uuid('bill_id').notNull().references(() => bills.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => products.id),
  qtyBase: bigint('qty_base', { mode: 'number' }).notNull(),
  // Snapshotted at add time so a bill built across turns does not shift if the product changes.
  unitPricePaise: bigint('unit_price_paise', { mode: 'number' }).notNull(),
  gstRateBps: integer('gst_rate_bps').notNull(),
  hsnCode: text('hsn_code').notNull(),
});

export const khataAccounts = pgTable(
  'khata_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: bigint('store_id', { mode: 'bigint' })
      .notNull().references(() => stores.id, { onDelete: 'cascade' }),
    customerName: text('customer_name').notNull(),
    phone: text('phone'),
    balancePaise: bigint('balance_paise', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameUq: uniqueIndex('khata_store_name_uq').on(t.storeId, sql`lower(${t.customerName})`),
  }),
);

export const khataEntries = pgTable('khata_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => khataAccounts.id, { onDelete: 'cascade' }),
  kind: khataKindEnum('kind').notNull(),
  amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
  billId: uuid('bill_id').references(() => bills.id),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const stockMovements = pgTable('stock_movements', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: bigint('store_id', { mode: 'bigint' })
    .notNull().references(() => stores.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => products.id),
  kind: movementKindEnum('kind').notNull(),
  qtyBaseDelta: bigint('qty_base_delta', { mode: 'number' }).notNull(),
  billId: uuid('bill_id').references(() => bills.id),
  unitCostPaise: bigint('unit_cost_paise', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    storeId: bigint('store_id', { mode: 'bigint' })
      .notNull().references(() => stores.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    operation: text('operation').notNull(),
    result: jsonb('result').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.storeId, t.key] }) }),
);
```

Add `jsonb` and `primaryKey` to the imports from `drizzle-orm/pg-core`.

- [ ] **Step 2: Add the invoice-number uniqueness index**

Bills need `invoice_number` unique per store, but only when assigned. Add to the `bills` table config:

```typescript
(t) => ({
  invoiceUq: uniqueIndex('bills_store_invoice_uq')
    .on(t.storeId, t.invoiceNumber)
    .where(sql`${t.invoiceNumber} IS NOT NULL`),
})
```

- [ ] **Step 3: Generate and apply**

```bash
pnpm db:generate && pnpm db:migrate
```

- [ ] **Step 4: Write the test**

`src/db/schema.full.test.ts`:
```typescript
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from './client.js';
import { bills, khataAccounts, stores } from './schema.js';

const STORE = 999000008n;
beforeEach(async () => {
  await db.delete(stores).where(eq(stores.id, STORE));
  await db.insert(stores).values({ id: STORE, name: 'S', gstin: '27AAAAA0000A1Z5' });
});
afterAll(async () => { await db.delete(stores).where(eq(stores.id, STORE)); await pool.end(); });

describe('full schema', () => {
  it('allows several concurrent draft bills per store', async () => {
    // The brief's "two bills in flight" is intra-chat, so multiple drafts must stay legal.
    await db.insert(bills).values([{ storeId: STORE }, { storeId: STORE }]);
    const rows = await db.select().from(bills).where(eq(bills.storeId, STORE));
    expect(rows).toHaveLength(2);
  });

  it('rejects a duplicate invoice number within a store', async () => {
    await db.insert(bills).values({ storeId: STORE, status: 'finalized', invoiceNumber: 'INV-1' });
    await expect(
      db.insert(bills).values({ storeId: STORE, status: 'finalized', invoiceNumber: 'INV-1' }),
    ).rejects.toThrow();
  });

  it('treats khata customer names case-insensitively', async () => {
    await db.insert(khataAccounts).values({ storeId: STORE, customerName: 'Ramesh' });
    await expect(
      db.insert(khataAccounts).values({ storeId: STORE, customerName: 'ramesh' }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test src/db/schema.full.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: full schema — bills, khata, movements, idempotency"
```

---

## Task 14: Seed with relative dating

**Files:**
- Create: `src/seed/catalogue.ts`, `src/seed/index.ts`
- Modify: `src/repositories/stores.ts` (call the seed on creation)
- Test: `src/seed/index.test.ts`

**Interfaces:**
- Consumes: `computeLine` (Task 12), schema (Task 13).
- Produces: `CATALOGUE: SeedProduct[]`, `seedStore(storeId: bigint, now?: Date): Promise<void>`.

- [ ] **Step 1: Write `src/seed/catalogue.ts`**

```typescript
import type { Unit } from '../domain/units.js';

export interface SeedProduct {
  name: string;
  brand?: string;
  packSize?: string;
  unit: Unit;
  isLoose?: boolean;
  hsnCode: string;
  gstRateBps: number;
  costPricePaise: number;
  mrpPaise: number;
  openingBase: number;
  reorderLevelBase: number;
}

/** GST slabs per spec §2: loose staples 0%, packaged staples 5%, FMCG 12–18%. */
export const CATALOGUE: SeedProduct[] = [
  { name: 'Aashirvaad Atta 5kg', brand: 'Aashirvaad', packSize: '5kg', unit: 'packet',
    hsnCode: '11010000', gstRateBps: 500, costPricePaise: 22000, mrpPaise: 26000,
    openingBase: 14, reorderLevelBase: 5 },
  { name: 'Tata Salt 1kg', brand: 'Tata', packSize: '1kg', unit: 'packet',
    hsnCode: '25010020', gstRateBps: 500, costPricePaise: 2200, mrpPaise: 2800,
    openingBase: 30, reorderLevelBase: 10 },
  { name: 'Amul Butter 100g', brand: 'Amul', packSize: '100g', unit: 'packet',
    hsnCode: '04059020', gstRateBps: 1200, costPricePaise: 5200, mrpPaise: 6200,
    openingBase: 18, reorderLevelBase: 6 },
  { name: 'Fortune Sunflower Oil 1L', brand: 'Fortune', packSize: '1L', unit: 'packet',
    hsnCode: '15121110', gstRateBps: 500, costPricePaise: 13500, mrpPaise: 15500,
    openingBase: 12, reorderLevelBase: 4 },
  { name: 'Maggi 70g', brand: 'Nestle', packSize: '70g', unit: 'packet',
    hsnCode: '19023010', gstRateBps: 1200, costPricePaise: 1200, mrpPaise: 1400,
    // Deliberately low so the oversell guard is easy to trigger on camera.
    openingBase: 6, reorderLevelBase: 12 },
  { name: 'Parle-G 100g', brand: 'Parle', packSize: '100g', unit: 'packet',
    hsnCode: '19053100', gstRateBps: 1800, costPricePaise: 800, mrpPaise: 1000,
    openingBase: 40, reorderLevelBase: 15 },
  { name: 'Surf Excel 1kg', brand: 'Surf Excel', packSize: '1kg', unit: 'packet',
    hsnCode: '34022090', gstRateBps: 1800, costPricePaise: 11000, mrpPaise: 13500,
    // At reorder level so "what's running out?" returns something real.
    openingBase: 3, reorderLevelBase: 5 },
  { name: 'Sugar (loose)', unit: 'kg', isLoose: true, hsnCode: '17019990', gstRateBps: 0,
    costPricePaise: 4200, mrpPaise: 5200, openingBase: 18_000, reorderLevelBase: 5_000 },
  { name: 'Rice (loose)', unit: 'kg', isLoose: true, hsnCode: '10063020', gstRateBps: 0,
    costPricePaise: 5500, mrpPaise: 6800, openingBase: 40_000, reorderLevelBase: 10_000 },
  { name: 'Toor Dal (loose)', unit: 'kg', isLoose: true, hsnCode: '07136000', gstRateBps: 0,
    costPricePaise: 11000, mrpPaise: 13500, openingBase: 22_000, reorderLevelBase: 8_000 },
];

export const SEED_KHATA = [
  { customerName: 'Ramesh', phone: '9820011223', openingBalancePaise: 48_500 },
  { customerName: 'Sunita', phone: '9820044556', openingBalancePaise: 12_000 },
  { customerName: 'Imran', phone: '9820077889', openingBalancePaise: 0 },
];
```

- [ ] **Step 2: Write the failing test**

`src/seed/index.test.ts`:
```typescript
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, gte } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { bills, khataAccounts, products, stores, stockMovements } from '../db/schema.js';
import { seedStore } from './index.js';

const STORE = 999000009n;

beforeEach(async () => {
  await db.delete(stores).where(eq(stores.id, STORE));
  await db.insert(stores).values({ id: STORE, name: 'S', gstin: '27AAAAA0000A1Z5' });
});
afterAll(async () => { await db.delete(stores).where(eq(stores.id, STORE)); await pool.end(); });

describe('seedStore', () => {
  it('creates the catalogue with a low-stock item and a reorder-level item', async () => {
    await seedStore(STORE);
    const rows = await db.select().from(products).where(eq(products.storeId, STORE));
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(rows.some((r) => r.quantityBase <= r.reorderLevelBase)).toBe(true);
  });

  it('creates khata accounts including one carrying a balance', async () => {
    await seedStore(STORE);
    const rows = await db.select().from(khataAccounts).where(eq(khataAccounts.storeId, STORE));
    expect(rows.some((r) => r.balancePaise > 0)).toBe(true);
  });

  it('DATES SALES HISTORY RELATIVE TO NOW, not to hardcoded calendar dates', async () => {
    // Regression test for the "this week's deck is empty next month" bug.
    await seedStore(STORE);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recent = await db
      .select()
      .from(bills)
      .where(and(eq(bills.storeId, STORE), gte(bills.createdAt, sevenDaysAgo)));
    expect(recent.length).toBeGreaterThan(0);
  });

  it('honours an injected clock so the relative dating is provable', async () => {
    const fixed = new Date('2030-06-15T12:00:00Z');
    await seedStore(STORE, fixed);
    const rows = await db.select().from(bills).where(eq(bills.storeId, STORE));
    const newest = rows.map((r) => r.createdAt.getTime()).sort((a, b) => b - a)[0]!;
    expect(newest).toBeLessThanOrEqual(fixed.getTime());
    expect(newest).toBeGreaterThan(fixed.getTime() - 3 * 24 * 60 * 60 * 1000);
  });

  it('records a stock movement for every seeded sale', async () => {
    await seedStore(STORE);
    const moves = await db.select().from(stockMovements).where(eq(stockMovements.storeId, STORE));
    expect(moves.some((m) => m.kind === 'sale')).toBe(true);
  });
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `pnpm test src/seed/index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/seed/index.ts`**

```typescript
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  billItems, bills, khataAccounts, products, stockMovements,
} from '../db/schema.js';
import { computeLine } from '../domain/gst.js';
import { roundToNearestRupee } from '../domain/money.js';
import type { Unit } from '../domain/units.js';
import { CATALOGUE, SEED_KHATA } from './catalogue.js';

const HISTORY_DAYS = 14;
const BILLS_PER_DAY = 4;

/** Deterministic pseudo-random so seeded stores are reproducible for debugging. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * Seeds a store's catalogue, khata accounts and ~2 weeks of sales history.
 *
 * History is dated relative to `now`, never to hardcoded calendar dates. With fixed dates,
 * "make this week's analysis deck" returns empty charts for anyone who messages the bot after
 * the seed window has passed — and the deck is one of the two headline artifacts.
 */
export async function seedStore(storeId: bigint, now: Date = new Date()): Promise<void> {
  const inserted = await db
    .insert(products)
    .values(
      CATALOGUE.map((p) => ({
        storeId, name: p.name, brand: p.brand ?? null, packSize: p.packSize ?? null,
        unit: p.unit, isLoose: p.isLoose ?? false, hsnCode: p.hsnCode,
        gstRateBps: p.gstRateBps, costPricePaise: p.costPricePaise, mrpPaise: p.mrpPaise,
        quantityBase: p.openingBase, reorderLevelBase: p.reorderLevelBase,
      })),
    )
    .returning();

  await db.insert(khataAccounts).values(
    SEED_KHATA.map((k) => ({
      storeId, customerName: k.customerName, phone: k.phone,
      balancePaise: k.openingBalancePaise,
    })),
  );

  const rng = makeRng(Number(storeId % 100000n) || 1);
  const modes = ['cash', 'upi', 'card'] as const;

  for (let dayOffset = HISTORY_DAYS; dayOffset >= 1; dayOffset--) {
    for (let n = 0; n < BILLS_PER_DAY; n++) {
      const at = new Date(now.getTime() - dayOffset * 86_400_000 + n * 3_600_000);
      const picks = inserted
        .filter(() => rng() < 0.35)
        .slice(0, 4);
      if (picks.length === 0) continue;

      let subtotal = 0, cgst = 0, sgst = 0;
      const lines = picks.map((p) => {
        const qtyBase = p.isLoose ? 500 * (1 + Math.floor(rng() * 4)) : 1 + Math.floor(rng() * 3);
        const amounts = computeLine({
          mrpPaise: p.mrpPaise, qtyBase, unit: p.unit as Unit, gstRateBps: p.gstRateBps,
        });
        subtotal += amounts.taxablePaise;
        cgst += amounts.cgstPaise;
        sgst += amounts.sgstPaise;
        return { product: p, qtyBase, amounts };
      });

      const gross = subtotal + cgst + sgst;
      const { totalPaise, roundOffPaise } = roundToNearestRupee(gross);

      const [bill] = await db.insert(bills).values({
        storeId, status: 'finalized',
        paymentMode: modes[Math.floor(rng() * modes.length)]!,
        subtotalPaise: subtotal, cgstPaise: cgst, sgstPaise: sgst,
        roundOffPaise, totalPaise,
        invoiceNumber: `INV-${dayOffset}-${n}`,
        createdAt: at, finalizedAt: at,
      }).returning();

      await db.insert(billItems).values(
        lines.map((l) => ({
          billId: bill!.id, productId: l.product.id, qtyBase: l.qtyBase,
          unitPricePaise: l.product.mrpPaise, gstRateBps: l.product.gstRateBps,
          hsnCode: l.product.hsnCode,
        })),
      );

      await db.insert(stockMovements).values(
        lines.map((l) => ({
          storeId, productId: l.product.id, kind: 'sale' as const,
          qtyBaseDelta: -l.qtyBase, billId: bill!.id, createdAt: at,
        })),
      );
    }
  }
}

export async function reseedStore(storeId: bigint, now?: Date): Promise<void> {
  await db.delete(products).where(eq(products.storeId, storeId));
  await db.delete(khataAccounts).where(eq(khataAccounts.storeId, storeId));
  await db.delete(bills).where(eq(bills.storeId, storeId));
  await seedStore(storeId, now);
}
```

> Seeded sales deliberately do not decrement `products.quantityBase`. The opening stock figures
> in `CATALOGUE` are the intended *current* stock, and Maggi at 6 units must stay at 6 for the
> oversell demo. The movements exist so analytics has velocity data.

- [ ] **Step 5: Wire the seed into provisioning**

In `src/repositories/stores.ts`, change `provisionStore` to seed on creation:

```typescript
import { seedStore } from '../seed/index.js';

export async function provisionStore(chatId: bigint): Promise<{ id: bigint; created: boolean }> {
  const inserted = await db
    .insert(stores)
    .values({ id: chatId, name: DEFAULT_NAME, gstin: DEFAULT_GSTIN })
    .onConflictDoNothing()
    .returning({ id: stores.id });
  if (inserted.length === 0) return { id: chatId, created: false };
  await seedStore(chatId);
  return { id: chatId, created: true };
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm test`
Expected: all PASS. The relative-dating test is the regression guard.

- [ ] **Step 7: Run the full gate**

Run: `pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

- [ ] **Step 8: Update tracking and commit**

Tick the completed Milestone 0 and 1 boxes in `tasks/todo.md`, refresh `HANDOFF.md` with the
verification outcomes from Task 9, then:

```bash
git add -A
git commit -m "feat: seeded catalogue, khata accounts and relatively-dated sales history"
```

**Milestone 1 complete.** Re-plan Milestones 2–5 with the Task 9 outcomes in hand.

---

## Self-Review

**Spec coverage.** §2 locked decisions → Tasks 1, 2, 6, 8. §3 architecture and layering → the
File Structure table. §4 security → Tasks 4, 5. §5 data model → Tasks 2, 7, 13. §6 GST → Task 12.
§7 oversell backstop → Task 2 Step 6; idempotency ordinal → Task 4; claim/done → Task 7. §10
seeding → Task 14. §13 build order → task sequence. §14 verifications → Task 9.

**Deferred to the Milestone 2–5 plan, deliberately:** the remaining §7 enforcement (finalize
transaction, khata-in-finalize, below-cost guard), §8 tool families beyond `get_stock`, §9
skills beyond the probe, §11 edge-case documentation, and §12's concurrency and artifact tests.
All depend on Task 9's outcomes.

**Type consistency check.** `StockResult` is defined in Task 3 and consumed unchanged in Task 5.
`ToolContext` is defined in Task 4 and consumed in Tasks 5 and 7. `Unit` is defined in Task 11
and consumed in Tasks 12 and 14. `divRoundHalfUp` is defined in Task 10 and consumed in Task 12.
`computeLine` is defined in Task 12 and consumed in Task 14. `LineAmounts.lineTotalPaise` is
`Omit`ted in `taxBreakdown`'s return and spread back in `computeLine` — consistent.

**Known soft spot.** Tasks 5, 6 and 9 depend on Agent SDK binding names that Task 5 Step 1 and
Task 6 Step 1 require verifying against `code.claude.com/docs/en/agent-sdk` before writing. The
code in those tasks is the expected shape, not a verified signature, and is flagged as such at
each site. Writing it from memory would be worse than an explicit verify-then-adjust step.
