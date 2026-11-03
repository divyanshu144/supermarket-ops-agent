import type { Pool } from 'pg';

export interface UsageDayReport {
  day: string;
  requests: number;
  toolErrorRate: number | null;
  idempotentReplays: number;
  cacheHitRate: number | null;
  costPerModelTurnUsd: number | null;
}

export interface UsageReport {
  observedStoreCount: number;
  days: UsageDayReport[];
}

/** Local PostgreSQL SELECT-only usage summary; intentionally omits store identifiers. */
export async function readUsageReport(client: Pick<Pool, 'query'>): Promise<UsageReport> {
  const { rows } = await client.query<{
    day: string;
    requests: string;
    tool_calls: number;
    tool_errors: number;
    cache_lookups: number;
    cache_hits: number;
    replay_count: string;
    cost_micro_usd: number;
    turns: number;
  }>(`WITH observed_days AS (
      SELECT s.id AS store_id, (p.claimed_at AT TIME ZONE 'Asia/Kolkata')::date AS day
      FROM stores s JOIN processed_updates p ON p.chat_id = s.id
      UNION
      SELECT store_id, day FROM usage
      UNION
      SELECT store_id, (created_at AT TIME ZONE 'Asia/Kolkata')::date AS day FROM idempotency_keys
    )
    SELECT
      to_char(d.day, 'YYYY-MM-DD') AS day,
      (SELECT count(*)::text FROM processed_updates p
       WHERE p.chat_id = d.store_id AND (p.claimed_at AT TIME ZONE 'Asia/Kolkata')::date = d.day) AS requests,
      coalesce(u.tool_calls, 0) AS tool_calls, coalesce(u.tool_errors, 0) AS tool_errors,
      coalesce(u.cache_lookups, 0) AS cache_lookups, coalesce(u.cache_hits, 0) AS cache_hits,
      (SELECT coalesce(sum(i.replay_count), 0)::text FROM idempotency_keys i
       WHERE i.store_id = d.store_id AND (i.created_at AT TIME ZONE 'Asia/Kolkata')::date = d.day) AS replay_count,
      coalesce(u.cost_micro_usd, 0) AS cost_micro_usd, coalesce(u.turns, 0) AS turns
    FROM observed_days d
    LEFT JOIN usage u ON u.store_id = d.store_id AND u.day = d.day
    WHERE d.day >= (now() AT TIME ZONE 'Asia/Kolkata')::date - 89
    ORDER BY d.day DESC, d.store_id
    LIMIT 90`);
  const stores = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM stores',
  );
  return {
    observedStoreCount: Number(stores.rows[0]?.count ?? 0),
    days: rows.map((row) => ({
      day: row.day,
      requests: Number(row.requests),
      toolErrorRate: row.tool_calls ? row.tool_errors / row.tool_calls : null,
      idempotentReplays: Number(row.replay_count),
      cacheHitRate: row.cache_lookups ? row.cache_hits / row.cache_lookups : null,
      costPerModelTurnUsd: row.turns ? row.cost_micro_usd / row.turns / 1_000_000 : null,
    })),
  };
}
