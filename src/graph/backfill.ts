import { readFile, writeFile } from 'node:fs/promises';
import type { GraphEvent } from './mapping.js';
import { projectGraphEvent } from './projector.js';

type SourceKind = GraphEvent['type'];
type SourceRow = Record<string, unknown> & { cursor: string; store_id: string };
type Checkpoint = Partial<Record<SourceKind, string>>;

const PAGE_SIZE = 200;
const SOURCE_QUERIES: Record<SourceKind, string> = {
  store: `SELECT id::text AS cursor, id::text AS store_id, id::text AS id, name, gstin,
    state_code, created_at FROM stores WHERE id::text > $1 ORDER BY id::text LIMIT $2`,
  product: `SELECT p.id::text AS cursor, p.store_id::text AS store_id, p.id::text AS id, p.name,
    p.brand, p.pack_size, p.unit::text AS unit, p.is_loose, p.hsn_code, p.gst_rate_bps,
    p.mrp_paise FROM products p WHERE p.id::text > $1 ORDER BY p.id::text LIMIT $2`,
  bill: `SELECT id::text AS cursor, store_id::text AS store_id, id::text AS id, status::text AS status,
    invoice_number, total_paise, created_at, finalized_at FROM bills
    WHERE id::text > $1 ORDER BY id::text LIMIT $2`,
  bill_item: `SELECT i.id::text AS cursor, b.store_id::text AS store_id, i.id::text AS id,
    i.bill_id::text AS bill_id, i.product_id::text AS product_id, i.line_no, i.qty_base,
    i.unit_price_paise, i.gst_rate_bps, i.hsn_code FROM bill_items i
    JOIN bills b ON b.id = i.bill_id WHERE i.id::text > $1 ORDER BY i.id::text LIMIT $2`,
  stock_movement: `SELECT m.id::text AS cursor, m.store_id::text AS store_id, m.id::text AS id,
    m.product_id::text AS product_id, m.kind::text AS kind, m.qty_base_delta,
    m.bill_id::text AS bill_id, m.created_at FROM stock_movements m
    WHERE m.id::text > $1 ORDER BY m.id::text LIMIT $2`,
  khata_account: `SELECT id::text AS cursor, store_id::text AS store_id, id::text AS id, created_at
    FROM khata_accounts WHERE id::text > $1 ORDER BY id::text LIMIT $2`,
  khata_entry: `SELECT e.id::text AS cursor, a.store_id::text AS store_id, e.id::text AS id,
    e.account_id::text AS account_id, e.kind::text AS kind, e.amount_paise, e.bill_id::text AS bill_id,
    e.created_at FROM khata_entries e JOIN khata_accounts a ON a.id = e.account_id
    WHERE e.id::text > $1 ORDER BY e.id::text LIMIT $2`,
  pending_action: `SELECT id::text AS cursor, store_id::text AS store_id, id::text AS id, tool,
    status::text AS status, outcome, created_at FROM pending_actions
    WHERE status = 'confirmed' AND id::text > $1 ORDER BY id::text LIMIT $2`,
  audit_event: `SELECT a.id::text AS cursor, a.store_id::text AS store_id, a.id::text AS id,
    a.action, a.tool, a.outcome, a.update_id::text AS update_id, a.created_at,
    p.id::text AS pending_action_id FROM audit_log a LEFT JOIN pending_actions p
    ON p.store_id = a.store_id AND p.confirmed_update_id = a.update_id
    WHERE a.id::text > $1 ORDER BY a.id::text LIMIT $2`,
};

export function mapBackfillRow(kind: SourceKind, row: SourceRow): GraphEvent {
  const text = (key: string) => String(row[key]);
  const nullableText = (key: string) => (row[key] == null ? null : String(row[key]));
  const numeric = (key: string) => Number(row[key]);
  const timestamp = (key: string) => new Date(String(row[key])).toISOString();
  const base = { storeId: text('store_id'), id: text('id') };
  switch (kind) {
    case 'store':
      return {
        type: kind,
        ...base,
        name: text('name'),
        gstin: text('gstin'),
        stateCode: text('state_code'),
        createdAt: timestamp('created_at'),
      };
    case 'product':
      return {
        type: kind,
        ...base,
        name: text('name'),
        brand: nullableText('brand'),
        packSize: nullableText('pack_size'),
        unit: text('unit'),
        isLoose: Boolean(row.is_loose),
        hsnCode: text('hsn_code'),
        gstRateBps: numeric('gst_rate_bps'),
        mrpPaise: numeric('mrp_paise'),
      };
    case 'bill':
      return {
        type: kind,
        ...base,
        status: text('status'),
        invoiceNumber: nullableText('invoice_number'),
        totalPaise: row.total_paise == null ? null : numeric('total_paise'),
        createdAt: timestamp('created_at'),
        finalizedAt: row.finalized_at == null ? null : timestamp('finalized_at'),
      };
    case 'bill_item':
      return {
        type: kind,
        ...base,
        billId: text('bill_id'),
        productId: text('product_id'),
        lineNo: numeric('line_no'),
        qtyBase: numeric('qty_base'),
        unitPricePaise: numeric('unit_price_paise'),
        gstRateBps: numeric('gst_rate_bps'),
        hsnCode: text('hsn_code'),
      };
    case 'stock_movement':
      return {
        type: kind,
        ...base,
        productId: text('product_id'),
        kind: text('kind'),
        qtyBaseDelta: numeric('qty_base_delta'),
        billId: nullableText('bill_id'),
        createdAt: timestamp('created_at'),
      };
    case 'khata_account':
      return { type: kind, ...base, createdAt: timestamp('created_at') };
    case 'khata_entry':
      return {
        type: kind,
        ...base,
        accountId: text('account_id'),
        kind: text('kind'),
        amountPaise: numeric('amount_paise'),
        billId: nullableText('bill_id'),
        createdAt: timestamp('created_at'),
      };
    case 'pending_action':
      return {
        type: kind,
        ...base,
        tool: text('tool'),
        status: text('status'),
        outcome: nullableText('outcome'),
        createdAt: timestamp('created_at'),
      };
    case 'audit_event':
      return {
        type: kind,
        ...base,
        action: text('action'),
        tool: text('tool'),
        outcome: text('outcome'),
        updateId: text('update_id'),
        createdAt: timestamp('created_at'),
        pendingActionId: nullableText('pending_action_id'),
      };
  }
}

async function loadCheckpoint(path: string): Promise<Checkpoint> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Checkpoint;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

/** Idempotent source-history projection. Set GRAPH_BACKFILL_STATE_FILE to a durable writable path. */
export async function backfillGraphHistory(
  query: (sql: string, values: unknown[]) => Promise<{ rows: SourceRow[] }>,
  checkpointPath: string,
  project: typeof projectGraphEvent = projectGraphEvent,
): Promise<number> {
  const checkpoint = await loadCheckpoint(checkpointPath);
  let projected = 0;
  for (const kind of Object.keys(SOURCE_QUERIES) as SourceKind[]) {
    let cursor = checkpoint[kind] ?? '';
    while (true) {
      const { rows } = await query(SOURCE_QUERIES[kind], [cursor, PAGE_SIZE]);
      for (const row of rows) {
        const event = mapBackfillRow(kind, row);
        await project({
          id: `backfill-${kind}-${row.cursor}`,
          storeId: BigInt(event.storeId),
          eventType: kind,
          entityId: event.id,
          payload: event,
          createdAt: new Date(),
          processedAt: null,
          lockedUntil: null,
          claimToken: '00000000-0000-4000-8000-000000000000',
          attempts: 1,
          nextAttemptAt: new Date(),
          lastErrorCode: null,
        });
        cursor = row.cursor;
        checkpoint[kind] = cursor;
        projected += 1;
      }
      await writeFile(checkpointPath, JSON.stringify(checkpoint), { mode: 0o600 });
      if (rows.length < PAGE_SIZE) break;
    }
  }
  return projected;
}
