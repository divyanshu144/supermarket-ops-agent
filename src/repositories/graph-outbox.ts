import { sql } from 'drizzle-orm';
import type { GraphEvent } from '../graph/mapping.js';

export interface GraphOutboxExecutor {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}

/** Append an immutable event using the caller's Postgres transaction. */
export async function appendGraphEvent(tx: GraphOutboxExecutor, event: GraphEvent): Promise<void> {
  await tx.execute(sql`
    INSERT INTO graph_outbox (store_id, event_type, entity_id, payload)
    VALUES (${event.storeId}::bigint, ${event.type}, ${event.id}, ${JSON.stringify(event)}::jsonb)
  `);
}
