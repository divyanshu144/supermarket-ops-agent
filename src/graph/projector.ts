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

const POLL_MS = 750;
const NODE_LABELS: Record<GraphMutation['kind'], string> = {
  store: 'Store',
  product: 'Product',
  bill: 'Bill',
  bill_item: 'BillItem',
  stock_movement: 'StockMovement',
  khata_account: 'KhataAccount',
  khata_entry: 'KhataEntry',
  pending_action: 'PendingAction',
  audit_event: 'AuditEvent',
};
const RELATIONSHIPS = new Set(['OWNS', 'CONTAINS', 'OF', 'CAUSED_BY', 'HAS_ENTRY', 'RECORDED_IN']);

let stopping = false;
let running: Promise<void> | null = null;
let lastVerifiedAt = 0;

function payloadOf(row: ClaimedGraphEvent): GraphEvent {
  return row.payload as unknown as GraphEvent;
}

async function persistMutation(tx: ManagedTransaction, mutation: GraphMutation): Promise<void> {
  const label = NODE_LABELS[mutation.kind];
  if (mutation.kind === 'store') {
    await tx.run('MERGE (n:Store {storeId: $storeId, sourceId: $sourceId}) SET n += $properties', {
      storeId: mutation.storeId,
      sourceId: mutation.sourceId,
      properties: mutation.properties,
    });
  } else {
    await tx.run(
      `MERGE (s:Store {storeId: $storeId, sourceId: $storeId}) MERGE (n:${label} {storeId: $storeId, sourceId: $sourceId}) SET n += $properties MERGE (s)-[:OWNS]->(n)`,
      { storeId: mutation.storeId, sourceId: mutation.sourceId, properties: mutation.properties },
    );
  }

  for (const relation of mutation.relationships) {
    if (!RELATIONSHIPS.has(relation.type)) throw new Error('Invalid graph relationship type');
    const fromLabel = relation.fromKind === 'bill_item' ? 'BillItem' : relation.fromKind;
    const toLabel = relation.toKind === 'bill_item' ? 'BillItem' : relation.toKind;
    if (
      ![...Object.values(NODE_LABELS)].includes(fromLabel) ||
      ![...Object.values(NODE_LABELS)].includes(toLabel)
    ) {
      throw new Error('Invalid graph node label');
    }
    await tx.run(
      `MERGE (a:${fromLabel} {storeId: $storeId, sourceId: $fromId}) MERGE (b:${toLabel} {storeId: $storeId, sourceId: $toId}) MERGE (a)-[r:${relation.type}]->(b) SET r += $properties`,
      {
        storeId: mutation.storeId,
        fromId: relation.fromId,
        toId: relation.toId,
        properties: relation.properties ?? {},
      },
    );
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
      const batch = await claimGraphEvents(25);
      for (const row of batch) {
        if (stopping) break;
        try {
          await projectGraphEvent(row);
          await acknowledgeGraphEvent(row.id, row.claimToken);
          markGraphAvailable();
        } catch (error) {
          const category = recordGraphFailure(error);
          await failGraphEvent(row.id, row.claimToken, category).catch(() => false);
          console.error(
            JSON.stringify({ scope: 'graph-projector', event: 'projection_failed', category }),
          );
        }
      }
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
  failureCount: number;
}> {
  const [state, lag] = [getGraphStatus(), await graphOutboxLag()];
  return {
    available: state.available,
    lastErrorCategory: state.lastErrorCategory,
    pendingCount: lag.pendingCount,
    oldestPendingAt: lag.oldestPendingAt?.toISOString() ?? null,
    failureCount: state.failureCount,
  };
}
