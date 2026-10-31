import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runAgent } from '../agent/runtime.js';
import { pool, getPoolTarget } from '../db/client.js';
import { newToolContext, toolContext } from '../tools/context.js';
import { sandboxOwnershipVerifier } from './database.js';
import { CACHE_QUESTIONS } from './cache-cases.js';
import { OpenAIEmbeddings } from '../cache/embeddings.js';
import { SemanticCache, cacheIntent, type Embedding } from '../cache/semantic.js';

// Record real isolated agent runs once. Threshold replay reuses identical measured miss
// latency/cost, so network jitter or stochastic responses cannot masquerade as a threshold effect.
const proof = JSON.parse(process.env.EVAL_SANDBOX_PROOF ?? 'null');
if (!proof) throw new Error('Run through the sandbox launcher');
await sandboxOwnershipVerifier(proof)();
if (getPoolTarget().database !== proof.database || getPoolTarget().user !== proof.role)
  throw new Error('Sandbox mismatch');
if (!process.env.OPENAI_API_KEY)
  throw new Error('Configure OPENAI_API_KEY locally for real embeddings; no synthetic fallback');
const provider = new OpenAIEmbeddings(process.env.OPENAI_API_KEY);
const corpusSha256 = createHash('sha256').update(JSON.stringify(CACHE_QUESTIONS)).digest('hex');
type Row = {
  id: string;
  answer: string;
  latencyMs: number;
  costUsd: number;
  cacheable: boolean;
  embedding?: Embedding;
  embeddingMs: number;
  outcome: string;
  tools: string[];
};
const rows: Row[] = [];
try {
  for (const [i, q] of CACHE_QUESTIONS.entries()) {
    await sandboxOwnershipVerifier(proof)();
    const store = BigInt(990000 + i);
    await pool.query('INSERT INTO stores(id,owner_user_id,name,gstin) VALUES ($1,$1,$2,$3)', [
      String(store),
      'Synthetic cache benchmark',
      '27AAAAA0000A1Z5',
    ]);
    await pool.query(
      "INSERT INTO products(store_id,name,unit,hsn_code,gst_rate_bps,cost_price_paise,mrp_paise,quantity_base) VALUES ($1,'Test Rice','packet','1006',500,5000,10000,100)",
      [String(store)],
    );
    let embedding: Embedding | undefined;
    const embedStarted = performance.now();
    if (cacheIntent(q.text)) embedding = await provider.embed(q.text);
    const embeddingMs = embedding ? performance.now() - embedStarted : 0;
    const start = performance.now();
    const context = newToolContext(store, BigInt(i + 1), undefined, store);
    const result = await toolContext.run(context, () => runAgent({ text: q.text }));
    rows.push({
      id: q.id,
      answer: result.reply,
      latencyMs: performance.now() - start,
      costUsd: result.turnCostUsd,
      cacheable:
        result.outcome === 'ok' &&
        result.toolsUsed.every((t) => t === 'Skill') &&
        context.pendingConfirmations.length === 0 &&
        context.artifacts.length === 0,
      embedding,
      embeddingMs,
      outcome: result.outcome,
      tools: result.toolsUsed,
    });
    await mkdir('evals/engineering/results', { recursive: true });
    await writeFile(
      'evals/engineering/results/cache-measurements.json',
      JSON.stringify(
        {
          provenance: 'live',
          corpusSha256,
          provider: provider.id,
          model: process.env.AGENT_MODEL,
          rows,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`cache measurement ${i + 1}/${CACHE_QUESTIONS.length}: ${result.outcome}`);
    if (result.outcome !== 'ok')
      throw new Error('Incomplete model run; refusing to publish benchmark estimates');
  }
  const tables = [];
  for (const threshold of [0.85, 0.9, 0.95]) {
    let active: Row;
    const cache = new SemanticCache(
      { id: provider.id, embed: async () => active.embedding! },
      threshold,
      86_400_000,
    );
    let hits = 0,
      falseHits = 0,
      unsafeHits = 0,
      estimatedLatencyMs = 0,
      estimatedCostUsd = 0;
    const answers = new Map<string, string>();
    const requests = [];
    for (const [i, q] of CACHE_QUESTIONS.entries()) {
      active = rows[i]!;
      const start = performance.now();
      const lookup = await cache.lookup(q.text, 'fixed-synthetic-store');
      const lookupMs = performance.now() - start;
      const hit = lookup.answer !== undefined;
      if (hit) {
        hits++;
        if (answers.get(lookup.answer!) !== q.meaning) falseHits++;
        if (q.kind !== 'paraphrase') unsafeHits++;
      } else if (lookup.candidate && active.cacheable) {
        cache.put(lookup.candidate, active.answer);
        answers.set(active.answer, q.meaning);
      }
      estimatedLatencyMs += active.embeddingMs + lookupMs + (hit ? 0 : active.latencyMs);
      estimatedCostUsd += (active.embedding?.estimatedCostUsd ?? 0) + (hit ? 0 : active.costUsd);
      requests.push({
        id: q.id,
        hit,
        reason: lookup.event.reason,
        similarity: lookup.event.similarity,
      });
    }
    const baselineCostUsd = rows.reduce((s, r) => s + r.costUsd, 0);
    tables.push({
      threshold,
      questions: rows.length,
      hits,
      hitRate: hits / rows.length,
      falseHits,
      falseHitRate: hits ? falseHits / hits : 0,
      unsafeHits,
      baselineAverageLatencyMs: rows.reduce((s, r) => s + r.latencyMs, 0) / rows.length,
      estimatedCacheAverageLatencyMs: estimatedLatencyMs / rows.length,
      baselineCostUsd,
      estimatedCacheCostUsd: estimatedCostUsd,
      estimatedSavingsUsd: baselineCostUsd - estimatedCostUsd,
      estimatedSavingsPercent: (100 * (baselineCostUsd - estimatedCostUsd)) / baselineCostUsd,
      requests,
    });
  }
  await writeFile(
    'evals/engineering/results/cache-thresholds.json',
    JSON.stringify(
      {
        method:
          'counterfactual replay over measured live per-question model and embedding latency/cost; not a second end-to-end timing run',
        corpusSha256,
        tables,
      },
      null,
      2,
    ) + '\n',
  );
  console.table(tables.map(({ requests, ...row }) => ({ ...row, requests: requests.length })));
} finally {
  await pool.end();
}
