import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { stores } from '../db/schema.js';
import { seedStore } from '../seed/index.js';
import { salesReport } from '../repositories/analytics.js';
import { generateAnalysisDeck } from './deck.js';
import { gradeDeterministically } from '../evals/assertions.js';

const STORE = 999000031n;
const generated: string[] = [];

beforeEach(async () => {
  await db.delete(stores).where(eq(stores.id, STORE));
  await db.insert(stores).values({ id: STORE, name: 'Deck Kirana', gstin: '27AAAAA0000A1Z5' });
  await seedStore(STORE); // gives ~2 weeks of history so the charts have data
});

afterAll(async () => {
  for (const path of generated) await rm(path, { force: true });
  await db.delete(stores).where(eq(stores.id, STORE));
  await pool.end();
});

describe('generateAnalysisDeck', () => {
  it('writes a real PPTX file', async () => {
    const result = await generateAnalysisDeck(STORE);
    generated.push(result.artifact.path);

    const bytes = await readFile(result.artifact.path);
    // A .pptx is a zip. Check the magic bytes rather than trusting the extension.
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(bytes.length).toBeGreaterThan(5000);
    expect(result.artifact.mime).toContain('presentationml');
  });

  it('embeds NATIVE chart objects, not pictures of charts', async () => {
    // The brief asks for real charts. A native chart lands as ppt/charts/chart*.xml inside the
    // zip and stays editable in PowerPoint; an image would show up under ppt/media instead.
    const result = await generateAnalysisDeck(STORE);
    generated.push(result.artifact.path);

    const raw = (await readFile(result.artifact.path)).toString('latin1');
    expect(raw).toContain('ppt/charts/chart');
    expect(raw).not.toContain('ppt/media/image');

    const emptyState = {
      products: [],
      movements: [],
      bills: [],
      billItems: [],
      accounts: [],
      ledger: [],
      preferences: [],
      artifacts: [],
      sentinel: {
        products: [],
        movements: [],
        bills: [],
        billItems: [],
        accounts: [],
        ledger: [],
        preferences: [],
      },
    };
    const graded = await gradeDeterministically(
      {
        tools: { ordered: [], forbidden: [] },
        refusalCodes: [],
        state: {
          stock: [],
          movements: [],
          bills: [],
          accounts: [],
          preferences: [],
          artifacts: [
            {
              ref: 'deck',
              mediaType:
                'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              contains: ['Sales by day', 'Top selling items'],
              nativeChartCount: 3,
            },
          ],
        },
        noBusinessStateChange: false,
      },
      {
        before: emptyState,
        after: {
          ...emptyState,
          artifacts: [
            {
              ref: 'deck',
              mediaType:
                'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              path: result.artifact.path,
            },
          ],
        },
        tools: [],
        reply: '',
        askedClarifyingQuestion: false,
      },
      { storeIds: {}, productIds: {}, customerIds: {}, billIds: {}, sentinelProductId: '' },
    );
    expect(graded).toEqual({ pass: true, failures: [] });
  });

  it('reports the same bill count the analytics query does', async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 86_400_000);

    const report = await salesReport(STORE, from, to);
    const result = await generateAnalysisDeck(STORE, { from, to });
    generated.push(result.artifact.path);

    expect(result.billCount).toBe(report.billCount);
    expect(result.billCount).toBeGreaterThan(0); // the seed must actually produce a week of sales
  });

  it('still produces a valid deck for a store with no sales at all', async () => {
    // A brand-new store must not crash the deck — it just has nothing to chart.
    const EMPTY = 999000032n;
    await db.delete(stores).where(eq(stores.id, EMPTY));
    await db.insert(stores).values({ id: EMPTY, name: 'Empty', gstin: '27AAAAA0000A1Z5' });

    const result = await generateAnalysisDeck(EMPTY);
    generated.push(result.artifact.path);

    const bytes = await readFile(result.artifact.path);
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(result.billCount).toBe(0);

    await db.delete(stores).where(eq(stores.id, EMPTY));
  });
});
