import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Neo4jContainer, type StartedNeo4jContainer } from '@testcontainers/neo4j';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Env } from '../config/env.js';
import { db, pool } from '../db/client.js';
import { bills, graphOutbox, products, stores } from '../db/schema.js';
import { addBillItem, finalizeBill, openBill } from '../repositories/bills.js';
import {
  acknowledgeGraphEvent,
  appendGraphEvent,
  claimGraphEvents,
} from '../repositories/graph-outbox.js';
import {
  closeGraphDrivers,
  configureGraph,
  configuredWriter,
  getGraphStatus,
  writerSession,
} from './driver.js';
import type { GraphEvent } from './mapping.js';
import { ensureGraphSchema } from './schema.js';
import {
  graphHealth,
  projectGraphEvent,
  projectPendingGraphEvents,
  startGraphProjector,
  stopGraphProjector,
} from './projector.js';
import { backfillGraphHistory } from './backfill.js';
import { readerSession } from './driver.js';
import { explainStockChange } from './reader.js';

const PASSWORD = 'neo4j-recovery-test-password';
const STORE = 999200091n;
let container: StartedNeo4jContainer;
let graphEnv: Pick<
  Env,
  | 'NEO4J_URI'
  | 'NEO4J_USERNAME'
  | 'NEO4J_PASSWORD'
  | 'NEO4J_READER_USERNAME'
  | 'NEO4J_READER_PASSWORD'
  | 'NEO4J_DATABASE'
>;

function event(id: string): GraphEvent {
  return {
    type: 'store',
    storeId: String(STORE),
    id: String(STORE),
    name: `Recovery ${id}`,
    gstin: '27AAAAA0000A1Z5',
    stateCode: '27',
    createdAt: new Date().toISOString(),
  };
}

async function useUnavailableGraph() {
  await closeGraphDrivers();
  configureGraph({ ...graphEnv, NEO4J_URI: 'bolt://127.0.0.1:1' });
  await expect(configuredWriter().verifyConnectivity()).rejects.toThrow();
}

async function useAvailableGraph() {
  await closeGraphDrivers();
  configureGraph(graphEnv);
}

describe('Postgres outbox and Neo4j recovery integration', () => {
  beforeAll(async () => {
    container = await new Neo4jContainer('neo4j:5-community').withPassword(PASSWORD).start();
    graphEnv = {
      NEO4J_URI: container.getBoltUri(),
      NEO4J_USERNAME: container.getUsername(),
      NEO4J_PASSWORD: PASSWORD,
      NEO4J_READER_USERNAME: undefined,
      NEO4J_READER_PASSWORD: undefined,
      NEO4J_DATABASE: 'neo4j',
    } as typeof graphEnv;
    configureGraph(graphEnv);
    const session = writerSession();
    try {
      await ensureGraphSchema(session);
    } finally {
      await session.close();
    }
  }, 120_000);

  beforeEach(async () => {
    await db.delete(stores).where(eq(stores.id, STORE));
    await db
      .insert(stores)
      .values({ id: STORE, name: 'Recovery test shop', gstin: '27AAAAA0000A1Z5' });
    await db.insert(products).values({
      storeId: STORE,
      name: 'Recovery Rice',
      unit: 'packet',
      isLoose: false,
      hsnCode: '10063020',
      gstRateBps: 0,
      costPricePaise: 100,
      mrpPaise: 200,
      quantityBase: 10,
      reorderLevelBase: 1,
    });
  });

  afterAll(async () => {
    await db.delete(stores).where(eq(stores.id, STORE));
    await pool.end();
    await closeGraphDrivers();
    await container?.stop();
  });

  it('replays a graph commit after a crash before acknowledgement without duplicate nodes', async () => {
    await db.transaction(async (tx) => appendGraphEvent(tx, event('replay')));
    const started = new Date();
    const [first] = await claimGraphEvents(10, started, 1000);
    expect(first).toBeDefined();

    await projectGraphEvent(first!);
    const [beforeReplay] = await db.select().from(graphOutbox).where(eq(graphOutbox.id, first!.id));
    expect(beforeReplay?.processedAt).toBeNull();

    const [reclaimed] = await claimGraphEvents(10, new Date(started.getTime() + 1001), 1000);
    expect(reclaimed).toBeDefined();
    await projectGraphEvent(reclaimed!);
    expect(await acknowledgeGraphEvent(reclaimed!.id, reclaimed!.claimToken)).toBe(true);

    const session = writerSession();
    try {
      const result = await session.run(
        'MATCH (s:Store {storeId: $storeId, sourceId: $sourceId}) RETURN count(s) AS count',
        { storeId: String(STORE), sourceId: String(STORE) },
      );
      expect(result.records[0]!.get('count').toNumber()).toBe(1);
    } finally {
      await session.close();
    }
  });

  it('keeps a failed row pending and drains it after Neo4j recovers', async () => {
    await db.transaction(async (tx) => appendGraphEvent(tx, event('recovery')));
    await useUnavailableGraph();

    expect(await projectPendingGraphEvents()).toBe(0);
    const [failed] = await db.select().from(graphOutbox).where(eq(graphOutbox.storeId, STORE));
    expect(failed).toMatchObject({
      processedAt: null,
      claimToken: null,
      lastErrorCode: 'unavailable',
    });
    expect(
      await explainStockChange(STORE, {
        productQuery: 'Recovery Rice',
        from: new Date(Date.now() - 60_000),
        to: new Date(Date.now() + 60_000),
      }),
    ).toEqual({ status: 'unavailable' });
    const health = await graphHealth();
    expect(health.available).toBe(false);
    expect(health.pendingCount).toBeGreaterThan(0);
    expect(health.oldestPendingAgeMs).toEqual(expect.any(Number));
    expect(health.failureCount).toBeGreaterThan(0);

    await useAvailableGraph();
    expect(await projectPendingGraphEvents({ now: new Date(Date.now() + 3000) })).toBe(1);
    const [completed] = await db.select().from(graphOutbox).where(eq(graphOutbox.storeId, STORE));
    expect(completed?.processedAt).toBeInstanceOf(Date);
  });

  it('starts in degraded mode when Neo4j is unavailable at boot', async () => {
    await closeGraphDrivers();
    await expect(
      startGraphProjector({ ...graphEnv, NEO4J_URI: 'bolt://127.0.0.1:1' }),
    ).resolves.toBeUndefined();
    expect(getGraphStatus().available).toBe(false);
    expect(getGraphStatus().lastErrorCategory).toBe('unavailable');
    await stopGraphProjector();
    await useAvailableGraph();
  }, 15_000);

  it('commits a finalized bill and its outbox rows while Neo4j is unreachable', async () => {
    await useUnavailableGraph();
    const { billId } = await openBill(STORE);
    expect(
      await addBillItem(STORE, { billId, productQuery: 'Recovery Rice', qty: 1, unit: 'packet' }),
    ).toMatchObject({ status: 'added' });

    const finalized = await finalizeBill(STORE, { billId, paymentMode: 'cash' });
    expect(finalized.status).toBe('finalized');
    const [bill] = await db.select().from(bills).where(eq(bills.id, billId));
    expect(bill?.status).toBe('finalized');
    expect(
      await db.select().from(graphOutbox).where(eq(graphOutbox.storeId, STORE)),
    ).not.toHaveLength(0);
  });

  it('backfills existing Postgres rows in a bounded resumable and idempotent pass', async () => {
    await useAvailableGraph();
    const directory = await mkdtemp(join(tmpdir(), 'neo4j-source-backfill-'));
    const checkpoint = join(directory, 'state.json');
    const [product] = await db.select().from(products).where(eq(products.storeId, STORE));
    expect(product).toBeDefined();
    try {
      expect(
        await backfillGraphHistory((text, values) => pool.query(text, values), checkpoint),
      ).toBeGreaterThan(0);
      expect(
        await backfillGraphHistory((text, values) => pool.query(text, values), checkpoint),
      ).toBe(0);
      const session = readerSession();
      try {
        const result = await session.executeRead((tx) =>
          tx.run(
            'MATCH (p:Product {storeId: $storeId, sourceId: $sourceId}) RETURN count(p) AS count',
            { storeId: String(STORE), sourceId: product!.id },
          ),
        );
        expect(result.records[0]!.get('count').toNumber()).toBe(1);
      } finally {
        await session.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
