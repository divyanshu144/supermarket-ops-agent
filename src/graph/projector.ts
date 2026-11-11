import neo4j, { type ManagedTransaction } from 'neo4j-driver';
import type { Env } from '../config/env.js';
import {
  acknowledgeGraphEvent,
  claimGraphEvents,
  failGraphEvent,
  graphOutboxLag,
  type ClaimedGraphEvent,
} from '../repositories/graph-outbox.js';
import { mapGraphEvent, type GraphEvent, type GraphMutation } from './mapping.js';
import {
  closeGraphDrivers,
  configureGraph,
  configuredWriter,
  getGraphStatus,
  graphDatabaseName,
  markGraphAvailable,
  readerSession,
  recordGraphFailure,
} from './driver.js';
import { ensureGraphSchema } from './schema.js';
import { graphToolMetrics } from './reader.js';

const POLL_MS = 750;
const NODE_UPSERTS: Record<GraphMutation['kind'], string> = {
  store: 'MERGE (n:Store {storeId: $storeId, sourceId: $sourceId}) SET n += $properties',
  product:
    'MERGE (s:Store {storeId: $storeId, sourceId: $storeId}) MERGE (n:Product {storeId: $storeId, sourceId: $sourceId}) SET n += $properties MERGE (s)-[:OWNS]->(n)',
  bill: 'MERGE (s:Store {storeId: $storeId, sourceId: $storeId}) MERGE (n:Bill {storeId: $storeId, sourceId: $sourceId}) SET n += $properties MERGE (s)-[:OWNS]->(n)',
  bill_item:
    'MERGE (s:Store {storeId: $storeId, sourceId: $storeId}) MERGE (n:BillItem {storeId: $storeId, sourceId: $sourceId}) SET n += $properties MERGE (s)-[:OWNS]->(n)',
  stock_movement:
    'MERGE (s:Store {storeId: $storeId, sourceId: $storeId}) MERGE (n:StockMovement {storeId: $storeId, sourceId: $sourceId}) SET n += $properties MERGE (s)-[:OWNS]->(n)',
  khata_account:
    'MERGE (s:Store {storeId: $storeId, sourceId: $storeId}) MERGE (n:KhataAccount {storeId: $storeId, sourceId: $sourceId}) SET n += $properties MERGE (s)-[:OWNS]->(n)',
  khata_entry:
    'MERGE (s:Store {storeId: $storeId, sourceId: $storeId}) MERGE (n:KhataEntry {storeId: $storeId, sourceId: $sourceId}) SET n += $properties MERGE (s)-[:OWNS]->(n)',
  pending_action:
    'MERGE (s:Store {storeId: $storeId, sourceId: $storeId}) MERGE (n:PendingAction {storeId: $storeId, sourceId: $sourceId}) SET n += $properties MERGE (s)-[:OWNS]->(n)',
  audit_event:
    'MERGE (s:Store {storeId: $storeId, sourceId: $storeId}) MERGE (n:AuditEvent {storeId: $storeId, sourceId: $sourceId}) SET n += $properties MERGE (s)-[:OWNS]->(n)',
};
const RELATION_UPSERTS: Record<string, string> = {
  'Bill:CONTAINS:BillItem':
    'MERGE (a:Bill {storeId: $storeId, sourceId: $fromId}) MERGE (b:BillItem {storeId: $storeId, sourceId: $toId}) MERGE (a)-[r:CONTAINS]->(b) SET r += $properties',
  'BillItem:OF:Product':
    'MERGE (a:BillItem {storeId: $storeId, sourceId: $fromId}) MERGE (b:Product {storeId: $storeId, sourceId: $toId}) MERGE (a)-[r:OF]->(b) SET r += $properties',
  'StockMovement:OF:Product':
    'MERGE (a:StockMovement {storeId: $storeId, sourceId: $fromId}) MERGE (b:Product {storeId: $storeId, sourceId: $toId}) MERGE (a)-[r:OF]->(b) SET r += $properties',
  'StockMovement:CAUSED_BY:Bill':
    'MERGE (a:StockMovement {storeId: $storeId, sourceId: $fromId}) MERGE (b:Bill {storeId: $storeId, sourceId: $toId}) MERGE (a)-[r:CAUSED_BY]->(b) SET r += $properties',
  'StockMovement:CAUSED_BY:PendingAction':
    'MERGE (a:StockMovement {storeId: $storeId, sourceId: $fromId}) MERGE (b:PendingAction {storeId: $storeId, sourceId: $toId}) MERGE (a)-[r:CAUSED_BY]->(b) SET r += $properties',
  'KhataAccount:HAS_ENTRY:KhataEntry':
    'MERGE (a:KhataAccount {storeId: $storeId, sourceId: $fromId}) MERGE (b:KhataEntry {storeId: $storeId, sourceId: $toId}) MERGE (a)-[r:HAS_ENTRY]->(b) SET r += $properties',
  'KhataEntry:CAUSED_BY:Bill':
    'MERGE (a:KhataEntry {storeId: $storeId, sourceId: $fromId}) MERGE (b:Bill {storeId: $storeId, sourceId: $toId}) MERGE (a)-[r:CAUSED_BY]->(b) SET r += $properties',
  'KhataEntry:CAUSED_BY:PendingAction':
    'MERGE (a:KhataEntry {storeId: $storeId, sourceId: $fromId}) MERGE (b:PendingAction {storeId: $storeId, sourceId: $toId}) MERGE (a)-[r:CAUSED_BY]->(b) SET r += $properties',
  'PendingAction:RECORDED_IN:AuditEvent':
    'MERGE (a:PendingAction {storeId: $storeId, sourceId: $fromId}) MERGE (b:AuditEvent {storeId: $storeId, sourceId: $toId}) MERGE (a)-[r:RECORDED_IN]->(b) SET r += $properties',
};

let stopping = false;
let running: Promise<void> | null = null;
let lastVerifiedAt = 0;

function payloadOf(row: ClaimedGraphEvent): GraphEvent {
  return row.payload as unknown as GraphEvent;
}

async function persistMutation(tx: ManagedTransaction, mutation: GraphMutation): Promise<void> {
  await tx.run(NODE_UPSERTS[mutation.kind], {
    storeId: mutation.storeId,
    sourceId: mutation.sourceId,
    properties: mutation.properties,
  });

  for (const relation of mutation.relationships) {
    const fromKind = relation.fromKind === 'bill_item' ? 'BillItem' : relation.fromKind;
    const toKind = relation.toKind === 'bill_item' ? 'BillItem' : relation.toKind;
    const statement = RELATION_UPSERTS[`${fromKind}:${relation.type}:${toKind}`];
    if (!statement) throw new Error('Invalid graph relationship mapping');
    await tx.run(statement, {
      storeId: mutation.storeId,
      fromId: relation.fromId,
      toId: relation.toId,
      properties: relation.properties ?? {},
    });
  }
}

export async function projectGraphEvent(row: ClaimedGraphEvent): Promise<void> {
  const mutation = mapGraphEvent(payloadOf(row));
  const session = configuredWriter().session({
    database: graphDatabaseName(),
    defaultAccessMode: neo4j.session.WRITE,
  });
  try {
    await session.executeWrite((tx) => persistMutation(tx, mutation));
  } finally {
    await session.close();
  }
}

async function prepareGraph(): Promise<void> {
  const driver = configuredWriter();
  await driver.verifyConnectivity();
  const session = driver.session({
    database: graphDatabaseName(),
    defaultAccessMode: neo4j.session.WRITE,
  });
  try {
    await ensureGraphSchema(session);
  } finally {
    await session.close();
  }
  const readSession = readerSession();
  try {
    await readSession.executeRead((tx) => tx.run('RETURN 1'));
  } finally {
    await readSession.close();
  }
  markGraphAvailable();
  lastVerifiedAt = Date.now();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function projectPendingGraphEvents(
  options: {
    limit?: number;
    now?: Date;
  } = {},
): Promise<number> {
  const batch = await claimGraphEvents(options.limit ?? 25, options.now ?? new Date());
  let acknowledged = 0;
  for (const row of batch) {
    if (stopping) break;
    try {
      await projectGraphEvent(row);
      if (await acknowledgeGraphEvent(row.id, row.claimToken)) {
        markGraphAvailable();
        acknowledged += 1;
      }
    } catch (error) {
      const category = recordGraphFailure(error);
      await failGraphEvent(row.id, row.claimToken, category).catch(() => false);
      console.error(
        JSON.stringify({ scope: 'graph-projector', event: 'projection_failed', category }),
      );
    }
  }
  return acknowledged;
}

async function runProjector(): Promise<void> {
  let schemaReady = false;
  while (!stopping) {
    try {
      if (!schemaReady || !getGraphStatus().available) {
        await prepareGraph();
        schemaReady = true;
      } else if (Date.now() - lastVerifiedAt > 30_000) {
        await prepareGraph();
      }
      await projectPendingGraphEvents();
    } catch (error) {
      const category = recordGraphFailure(error);
      schemaReady = false;
      console.error(JSON.stringify({ scope: 'graph-projector', event: 'unavailable', category }));
    }
    if (!stopping) await sleep(POLL_MS);
  }
}

export async function startGraphProjector(env: Env): Promise<void> {
  if (running) return;
  stopping = false;
  configureGraph(env);
  try {
    await prepareGraph();
  } catch (error) {
    const category = recordGraphFailure(error);
    console.error(JSON.stringify({ scope: 'graph-projector', event: 'boot_degraded', category }));
  }
  running = runProjector();
}

export async function stopGraphProjector(): Promise<void> {
  stopping = true;
  await running;
  running = null;
  await closeGraphDrivers();
}

export async function graphHealth(): Promise<{
  available: boolean;
  lastErrorCategory: string | null;
  pendingCount: number;
  oldestPendingAt: string | null;
  oldestPendingAgeMs: number | null;
  failureCount: number;
  toolLatency: ReturnType<typeof graphToolMetrics>;
}> {
  const [state, lag] = [getGraphStatus(), await graphOutboxLag()];
  const oldestPendingAt = lag.oldestPendingAt ? new Date(lag.oldestPendingAt) : null;
  return {
    available: state.available,
    lastErrorCategory: state.lastErrorCategory,
    pendingCount: lag.pendingCount,
    oldestPendingAt: oldestPendingAt?.toISOString() ?? null,
    oldestPendingAgeMs: oldestPendingAt
      ? Math.max(0, Date.now() - oldestPendingAt.getTime())
      : null,
    failureCount: state.failureCount,
    toolLatency: graphToolMetrics(),
  };
}
