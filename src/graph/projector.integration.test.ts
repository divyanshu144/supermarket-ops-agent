import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Neo4jContainer, type StartedNeo4jContainer } from '@testcontainers/neo4j';
import type { Env } from '../config/env.js';
import { closeGraphDrivers, configureGraph, readerSession, writerSession } from './driver.js';
import { ensureGraphSchema } from './schema.js';
import { projectGraphEvent } from './projector.js';
import type { GraphEvent } from './mapping.js';
import type { ClaimedGraphEvent } from '../repositories/graph-outbox.js';
import { explainStockChange, frequentlyBoughtWith } from './reader.js';

const PASSWORD = 'neo4j-integration-test-password';
let container: StartedNeo4jContainer;

function claimed(event: GraphEvent): ClaimedGraphEvent {
  return {
    id: `outbox-${event.type}-${event.id}`,
    storeId: BigInt(event.storeId),
    eventType: event.type,
    entityId: event.id,
    payload: event,
    createdAt: new Date(),
    processedAt: null,
    lockedUntil: new Date(Date.now() + 60_000),
    claimToken: `claim-${event.id}`,
    attempts: 1,
    nextAttemptAt: new Date(),
    lastErrorCode: null,
  };
}

describe('Neo4j projector integration', () => {
  beforeAll(async () => {
    container = await new Neo4jContainer('neo4j:5-community').withPassword(PASSWORD).start();
    configureGraph({
      NEO4J_URI: container.getBoltUri(),
      NEO4J_USERNAME: container.getUsername(),
      NEO4J_PASSWORD: PASSWORD,
      NEO4J_READER_USERNAME: undefined,
      NEO4J_READER_PASSWORD: undefined,
      NEO4J_DATABASE: 'neo4j',
    } as Pick<
      Env,
      | 'NEO4J_URI'
      | 'NEO4J_USERNAME'
      | 'NEO4J_PASSWORD'
      | 'NEO4J_READER_USERNAME'
      | 'NEO4J_READER_PASSWORD'
      | 'NEO4J_DATABASE'
    >);
    const session = writerSession();
    try {
      await ensureGraphSchema(session);
      await ensureGraphSchema(session);
    } finally {
      await session.close();
    }
  }, 120_000);

  afterAll(async () => {
    await closeGraphDrivers();
    await container?.stop();
  });

  it('replays idempotently, keeps tenants isolated, and treats injection strings as data', async () => {
    const storeId = '999000001';
    const otherStoreId = '999000002';
    const maliciousId = "p-1'}) DETACH DELETE (n) //";
    const createdAt = new Date().toISOString();
    const events: GraphEvent[] = [
      {
        type: 'store',
        storeId,
        id: storeId,
        name: 'Test store',
        gstin: '27AAAAA0000A1Z5',
        stateCode: '27',
        createdAt,
      },
      {
        type: 'product',
        storeId,
        id: maliciousId,
        name: 'Name "; MATCH (n) DETACH DELETE n //',
        brand: null,
        packSize: null,
        unit: 'packet',
        isLoose: false,
        hsnCode: '1006',
        gstRateBps: 500,
        mrpPaise: 100,
      },
      {
        type: 'product',
        storeId,
        id: 'companion',
        name: 'Companion',
        brand: null,
        packSize: null,
        unit: 'packet',
        isLoose: false,
        hsnCode: '1006',
        gstRateBps: 500,
        mrpPaise: 100,
      },
      {
        type: 'bill',
        storeId,
        id: 'bill-1',
        status: 'finalized',
        invoiceNumber: 'INV-1',
        totalPaise: 200,
        createdAt,
        finalizedAt: createdAt,
      },
      {
        type: 'bill_item',
        storeId,
        id: 'item-1',
        billId: 'bill-1',
        productId: maliciousId,
        lineNo: 1,
        qtyBase: 1,
        unitPricePaise: 100,
        gstRateBps: 500,
        hsnCode: '1006',
      },
      {
        type: 'bill_item',
        storeId,
        id: 'item-2',
        billId: 'bill-1',
        productId: 'companion',
        lineNo: 2,
        qtyBase: 1,
        unitPricePaise: 100,
        gstRateBps: 500,
        hsnCode: '1006',
      },
      {
        type: 'pending_action',
        storeId,
        id: 'action-1',
        tool: 'adjust_stock',
        status: 'confirmed',
        outcome: 'adjusted',
        createdAt,
      },
      {
        type: 'audit_event',
        storeId,
        id: 'audit-1',
        action: 'adjust_stock',
        tool: 'adjust_stock',
        outcome: 'adjusted',
        updateId: '8001',
        createdAt,
        pendingActionId: 'action-1',
      },
      {
        type: 'stock_movement',
        storeId,
        id: 'move-1',
        productId: maliciousId,
        kind: 'adjust',
        qtyBaseDelta: -1,
        billId: null,
        pendingActionId: 'action-1',
        createdAt,
      },
      {
        type: 'product',
        storeId: otherStoreId,
        id: maliciousId,
        name: 'Private other store',
        brand: null,
        packSize: null,
        unit: 'packet',
        isLoose: false,
        hsnCode: '1006',
        gstRateBps: 500,
        mrpPaise: 100,
      },
    ];
    for (const event of events) {
      await projectGraphEvent(claimed(event));
      await projectGraphEvent(claimed(event));
    }

    const session = readerSession();
    try {
      const counts = await session.executeRead(async (tx) => {
        const result = await tx.run(
          'MATCH (p:Product {storeId: $storeId, sourceId: $sourceId}) RETURN count(p) AS products',
          { storeId, sourceId: maliciousId },
        );
        const relation = await tx.run(
          'MATCH (:Bill {storeId: $storeId, sourceId: $billId})-[:CONTAINS]->(:BillItem {storeId: $storeId, sourceId: $itemId})-[:OF]->(:Product {storeId: $storeId, sourceId: $productId}) RETURN count(*) AS lines',
          { storeId, billId: 'bill-1', itemId: 'item-1', productId: maliciousId },
        );
        const other = await tx.run(
          'MATCH (p:Product {storeId: $storeId, sourceId: $sourceId}) RETURN p.name AS name',
          { storeId, sourceId: maliciousId },
        );
        return {
          products: result.records[0]!.get('products').toNumber(),
          lines: relation.records[0]!.get('lines').toNumber(),
          visibleNames: other.records.map((record) => record.get('name')),
        };
      });
      expect(counts).toEqual({
        products: 1,
        lines: 1,
        visibleNames: ['Name "; MATCH (n) DETACH DELETE n //'],
      });

      const from = new Date(Date.now() - 60_000);
      const to = new Date(Date.now() + 60_000);
      const explanation = await explainStockChange(BigInt(storeId), {
        productQuery: 'Name "; MATCH (n) DETACH DELETE n //',
        from,
        to,
        limit: 20,
      });
      expect(explanation).toMatchObject({
        status: 'ok',
        movements: [
          { cause: { kind: 'PendingAction', id: 'action-1' }, audit: { action: 'adjust_stock' } },
        ],
      });
      const coOccurrences = await frequentlyBoughtWith(BigInt(storeId), {
        productQuery: 'Name',
        from,
        to,
        limit: 20,
      });
      expect(coOccurrences).toMatchObject({
        status: 'ok',
        products: [{ productName: 'Companion', bills: 1 }],
      });
      expect(
        await frequentlyBoughtWith(BigInt(storeId), {
          productQuery: 'Private other store',
          from,
          to,
          limit: 20,
        }),
      ).toEqual({ status: 'ok', products: [] });
    } finally {
      await session.close();
    }
  }, 30_000);
});
