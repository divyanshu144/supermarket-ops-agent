import neo4j, { type Record as Neo4jRecord, type Session } from 'neo4j-driver';
import { graphErrorIdentifier, readerSession, recordGraphFailure } from './driver.js';

export const GRAPH_READ_TIMEOUT_MS = 2500;
export const GRAPH_RESULT_LIMIT = 25;
export type GraphQueryName = 'explainStockChange' | 'frequentlyBoughtWith';

const CYPHER: Record<GraphQueryName, string> = {
  explainStockChange: `
    MATCH (p:Product {storeId: $storeId})
    WHERE toLower(p.name) CONTAINS toLower($productQuery)
    WITH p ORDER BY p.name LIMIT 5
    OPTIONAL MATCH (m:StockMovement {storeId: $storeId})-[:OF]->(p)
    WHERE m.createdAt >= $from AND m.createdAt <= $to
    OPTIONAL MATCH (m)-[:CAUSED_BY]->(cause)
    WHERE cause.storeId = $storeId
    OPTIONAL MATCH (cause:PendingAction {storeId: $storeId})-[:RECORDED_IN]->(audit:AuditEvent {storeId: $storeId})
    RETURN p.name AS productName, m.sourceId AS movementId, m.kind AS kind,
      m.qtyBaseDelta AS qtyBaseDelta, m.createdAt AS at,
      labels(cause)[0] AS causeKind, cause.sourceId AS causeId,
      audit.action AS auditAction, audit.outcome AS auditOutcome, audit.updateId AS auditUpdateId
    ORDER BY at DESC LIMIT $limit
  `,
  frequentlyBoughtWith: `
    MATCH (source:Product {storeId: $storeId})
    WHERE toLower(source.name) CONTAINS toLower($productQuery)
    WITH source ORDER BY source.name LIMIT 5
    MATCH (bill:Bill {storeId: $storeId, status: 'finalized'})
    WHERE bill.createdAt >= $from AND bill.createdAt <= $to
    MATCH (bill)-[:CONTAINS]->(sourceItem:BillItem {storeId: $storeId})-[:OF]->(source)
    MATCH (bill)-[:CONTAINS]->(candidateItem:BillItem {storeId: $storeId})-[:OF]->(candidate:Product {storeId: $storeId})
    WHERE candidate.sourceId <> source.sourceId
    RETURN candidate.sourceId AS productId, candidate.name AS productName,
      count(DISTINCT bill) AS bills, count(*) AS coOccurrences
    ORDER BY bills DESC, coOccurrences DESC, productName ASC LIMIT $limit
  `,
};

export interface GraphToolMetric {
  calls: number;
  failures: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
}

const metrics: Record<GraphQueryName, GraphToolMetric> = {
  explainStockChange: { calls: 0, failures: 0, totalLatencyMs: 0, maxLatencyMs: 0 },
  frequentlyBoughtWith: { calls: 0, failures: 0, totalLatencyMs: 0, maxLatencyMs: 0 },
};

export function graphToolMetrics(): Record<GraphQueryName, GraphToolMetric> {
  return structuredClone(metrics);
}

export async function runGraphRead(
  session: Session,
  queryName: GraphQueryName,
  params: Record<string, unknown>,
) {
  return session.executeRead((tx) => tx.run(CYPHER[queryName], params), {
    timeout: GRAPH_READ_TIMEOUT_MS,
  });
}

async function queryGraph(
  storeId: bigint,
  queryName: GraphQueryName,
  params: Record<string, unknown>,
): Promise<Neo4jRecord[] | null> {
  const startedAt = performance.now();
  const metric = metrics[queryName];
  metric.calls += 1;
  let failed = false;
  let session: Session | null = null;
  try {
    session = readerSession();
    const result = await runGraphRead(session, queryName, {
      ...params,
      storeId: String(storeId),
      limit: neo4j.int(
        Math.max(1, Math.min(GRAPH_RESULT_LIMIT, Math.floor(Number(params.limit) || 10))),
      ),
    });
    return result.records;
  } catch (error) {
    failed = true;
    const category = recordGraphFailure(error);
    console.error(
      JSON.stringify({
        scope: 'graph-tool',
        event: 'query_failed',
        category,
        driverCode: graphErrorIdentifier(error),
        tool: queryName,
      }),
    );
    return null;
  } finally {
    await session?.close().catch(() => undefined);
    const elapsed = performance.now() - startedAt;
    metric.totalLatencyMs += elapsed;
    metric.maxLatencyMs = Math.max(metric.maxLatencyMs, elapsed);
    if (failed) metric.failures += 1;
  }
}

function value(record: Neo4jRecord, key: string): unknown {
  return record.get(key) ?? null;
}

function integer(value_: unknown): number | null {
  if (value_ === null || value_ === undefined) return null;
  return typeof value_ === 'number' ? value_ : (value_ as { toNumber(): number }).toNumber();
}

export type StockExplanation = {
  productName: string;
  movementId: string;
  kind: string;
  qtyBaseDelta: number;
  at: string;
  cause: { kind: string; id: string } | null;
  audit: { action: string; outcome: string; updateId: string } | null;
};

export async function explainStockChange(
  storeId: bigint,
  input: { productQuery: string; from: Date; to: Date; limit?: number },
): Promise<{ status: 'ok'; movements: StockExplanation[] } | { status: 'unavailable' }> {
  const records = await queryGraph(storeId, 'explainStockChange', {
    productQuery: input.productQuery,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    limit: input.limit,
  });
  if (!records) return { status: 'unavailable' };
  return {
    status: 'ok',
    movements: records
      .filter((record) => value(record, 'movementId') !== null)
      .map((record) => {
        const causeId = value(record, 'causeId');
        const auditAction = value(record, 'auditAction');
        return {
          productName: String(value(record, 'productName')),
          movementId: String(value(record, 'movementId')),
          kind: String(value(record, 'kind')),
          qtyBaseDelta: integer(value(record, 'qtyBaseDelta')) ?? 0,
          at: String(value(record, 'at')),
          cause:
            causeId === null
              ? null
              : { kind: String(value(record, 'causeKind')), id: String(causeId) },
          audit:
            auditAction === null
              ? null
              : {
                  action: String(auditAction),
                  outcome: String(value(record, 'auditOutcome')),
                  updateId: String(value(record, 'auditUpdateId')),
                },
        };
      }),
  };
}

export async function frequentlyBoughtWith(
  storeId: bigint,
  input: { productQuery: string; from: Date; to: Date; limit?: number },
): Promise<
  | {
      status: 'ok';
      products: Array<{
        productId: string;
        productName: string;
        bills: number;
        coOccurrences: number;
      }>;
    }
  | { status: 'unavailable' }
> {
  const records = await queryGraph(storeId, 'frequentlyBoughtWith', {
    productQuery: input.productQuery,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    limit: input.limit,
  });
  if (!records) return { status: 'unavailable' };
  return {
    status: 'ok',
    products: records.map((record) => ({
      productId: String(value(record, 'productId')),
      productName: String(value(record, 'productName')),
      bills: integer(value(record, 'bills')) ?? 0,
      coOccurrences: integer(value(record, 'coOccurrences')) ?? 0,
    })),
  };
}
