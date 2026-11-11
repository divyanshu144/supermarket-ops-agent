import neo4j from 'neo4j-driver';
import { pool } from '../db/client.js';
import { readerSession } from './driver.js';

export type GraphReconcileReport = {
  storeId: string;
  counts: {
    bills: { postgres: number; neo4j: number };
    billItems: { postgres: number; neo4j: number };
    stockMovements: { postgres: number; neo4j: number };
  };
  stockMismatches: Array<{ productId: string; postgresDelta: number; neo4jDelta: number }>;
};

/** Read-only reconciliation; it never logs customer, product, bill or event payloads. */
export async function reconcileGraphStore(storeId: bigint): Promise<GraphReconcileReport> {
  const sid = String(storeId);
  const sourceCounts = await pool.query<{
    bills: string;
    bill_items: string;
    stock_movements: string;
  }>(
    `SELECT
      (SELECT count(*) FROM bills WHERE store_id = $1) AS bills,
      (SELECT count(*) FROM bill_items i JOIN bills b ON b.id = i.bill_id WHERE b.store_id = $1) AS bill_items,
      (SELECT count(*) FROM stock_movements WHERE store_id = $1) AS stock_movements`,
    [sid],
  );
  const sourceStock = await pool.query<{ product_id: string; stock_delta: string }>(
    `SELECT p.id::text AS product_id, COALESCE(sum(m.qty_base_delta), 0)::text AS stock_delta
    FROM products p LEFT JOIN stock_movements m ON m.product_id = p.id
    WHERE p.store_id = $1 GROUP BY p.id ORDER BY p.id`,
    [sid],
  );
  const session = readerSession();
  try {
    const graphCounts = await session.executeRead(
      async (tx) => {
        const result = await tx.run(
          `OPTIONAL MATCH (s:Store {storeId: $storeId})
        CALL { WITH s MATCH (b:Bill {storeId: $storeId}) RETURN count(b) AS bills }
        CALL { WITH s MATCH (i:BillItem {storeId: $storeId}) RETURN count(i) AS billItems }
        CALL { WITH s MATCH (m:StockMovement {storeId: $storeId}) RETURN count(m) AS stockMovements }
        RETURN bills, billItems, stockMovements`,
          { storeId: sid },
        );
        return result.records[0]!;
      },
      { timeout: 5000 },
    );
    const graphStock = await session.executeRead(
      async (tx) =>
        tx.run(
          `MATCH (p:Product {storeId: $storeId})
        OPTIONAL MATCH (m:StockMovement {storeId: $storeId})-[:OF]->(p)
        RETURN p.sourceId AS productId, coalesce(sum(m.qtyBaseDelta), 0) AS stockDelta`,
          { storeId: sid },
        ),
      { timeout: 5000 },
    );
    const graphStockByProduct = new Map(
      graphStock.records.map((row) => [
        String(row.get('productId')),
        Number(row.get('stockDelta')?.toNumber?.() ?? row.get('stockDelta') ?? 0),
      ]),
    );
    const sourceStockByProduct = new Map(
      sourceStock.rows.map((row) => [row.product_id, Number(row.stock_delta)]),
    );
    const productIds = new Set([...sourceStockByProduct.keys(), ...graphStockByProduct.keys()]);
    const stockMismatches = [...productIds].flatMap((productId) => {
      const postgresDelta = sourceStockByProduct.get(productId) ?? 0;
      const neo4jDelta = graphStockByProduct.get(productId) ?? 0;
      return postgresDelta === neo4jDelta ? [] : [{ productId, postgresDelta, neo4jDelta }];
    });
    return {
      storeId: sid,
      counts: {
        bills: {
          postgres: Number(sourceCounts.rows[0]?.bills ?? 0),
          neo4j: graphCounts.get('bills').toNumber(),
        },
        billItems: {
          postgres: Number(sourceCounts.rows[0]?.bill_items ?? 0),
          neo4j: graphCounts.get('billItems').toNumber(),
        },
        stockMovements: {
          postgres: Number(sourceCounts.rows[0]?.stock_movements ?? 0),
          neo4j: graphCounts.get('stockMovements').toNumber(),
        },
      },
      stockMismatches,
    };
  } finally {
    await session.close();
  }
}

export function reconciliationHasMismatch(report: GraphReconcileReport): boolean {
  return (
    Object.values(report.counts).some((count) => count.postgres !== count.neo4j) ||
    report.stockMismatches.length > 0
  );
}

export function graphCount(value: unknown): number {
  if (neo4j.isInt(value)) return value.toNumber();
  return Number(value ?? 0);
}
