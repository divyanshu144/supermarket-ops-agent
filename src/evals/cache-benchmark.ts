import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runAgent } from '../agent/runtime.js';
import { pool, getPoolTarget } from '../db/client.js';
import { newToolContext, toolContext } from '../tools/context.js';
import { sandboxOwnershipVerifier } from './database.js';
import { CACHE_QUESTIONS } from './cache-cases.js';
import { OpenAIEmbeddings, AppleWordEmbeddings } from '../cache/embeddings.js';
import { SemanticCache } from '../cache/semantic.js';

const proof = JSON.parse(process.env.EVAL_SANDBOX_PROOF ?? 'null');
if (!proof) throw new Error('Run through the sandbox launcher');
const verify = sandboxOwnershipVerifier(proof);
await verify();
if (getPoolTarget().database !== proof.database || getPoolTarget().user !== proof.role)
  throw new Error('Sandbox mismatch');
const provider = process.env.OPENAI_API_KEY
  ? new OpenAIEmbeddings(process.env.OPENAI_API_KEY)
  : new AppleWordEmbeddings();
await provider.embed('Embedding availability check');
const failures: Array<Record<string, unknown>> = [];
const corpusSha256 = createHash('sha256').update(JSON.stringify(CACHE_QUESTIONS)).digest('hex');
let sequence = 0;
let spentUsd = 0;
const maxCostUsd = Number(process.env.EVAL_MAX_COST_USD ?? 40);
if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) throw new Error('Invalid evaluation cost cap');
const measuredAgent = async (text: string) => {
  await verify();
  if (spentUsd + 0.5 > maxCostUsd)
    throw new Error('Evaluation cost cap reached; resume with an explicit higher cap');
  const store = BigInt(990000 + sequence++);
  await pool.query('INSERT INTO stores(id,owner_user_id,name,gstin) VALUES ($1,$1,$2,$3)', [
    String(store),
    'Synthetic cache benchmark',
    '27AAAAA0000A1Z5',
  ]);
  await pool.query(
    "INSERT INTO products(store_id,name,unit,hsn_code,gst_rate_bps,cost_price_paise,mrp_paise,quantity_base) VALUES ($1,'Test Rice','packet','1006',500,5000,10000,100)",
    [String(store)],
  );
  const context = newToolContext(store, store, undefined, store);
  const started = performance.now();
  const result = await toolContext.run(context, () => runAgent({ text }));
  spentUsd += result.turnCostUsd;
  if (result.outcome !== 'ok') {
    failures.push({
      text,
      outcome: result.outcome,
      attempts: result.attempts,
      costUsd: result.turnCostUsd,
      latencyMs: performance.now() - started,
    });
    await mkdir('evals/engineering/results', { recursive: true });
    await writeFile(
      'evals/engineering/results/cache-failures.json',
      JSON.stringify(failures, null, 2) + '\n',
    );
    throw new Error(
      `Incomplete model run (${result.outcome}); evidence saved, no benchmark headline`,
    );
  }
  return {
    answer: result.reply,
    latencyMs: performance.now() - started,
    costUsd: result.turnCostUsd,
    cacheable:
      result.toolsUsed.every((t) => t === 'Skill') &&
      context.pendingConfirmations.length === 0 &&
      context.artifacts.length === 0,
    attempts: result.attempts,
  };
};
const rows: Array<Awaited<ReturnType<typeof measuredAgent>> & { id: string }> = [];
const tables: Array<Record<string, unknown>> = [];
if (process.argv.includes('--resume')) {
  const prior = JSON.parse(
    await readFile('evals/engineering/results/cache-benchmark.json', 'utf8'),
  );
  if (
    prior.corpusSha256 !== corpusSha256 ||
    prior.provider !== provider.id ||
    prior.model !== process.env.AGENT_MODEL
  )
    throw new Error('Resume metadata mismatch');
  rows.push(...prior.rows);
  tables.push(...prior.tables);
  spentUsd =
    rows.reduce((sum, row) => sum + row.costUsd, 0) +
    tables.reduce((sum, row) => sum + Number(row.cacheCostUsd), 0);
}

const save = async () => {
  await mkdir('evals/engineering/results', { recursive: true });
  await writeFile(
    'evals/engineering/results/cache-benchmark.json',
    JSON.stringify(
      {
        provenance: 'live',
        spentUsd,
        maxCostUsd,
        complete: rows.length === CACHE_QUESTIONS.length && tables.length === 3,
        method:
          'separate measured baseline and threshold executions; cold cache per threshold; standalone requests; database fixture setup excluded from model latency',
        corpusSha256,
        provider: provider.id,
        model: process.env.AGENT_MODEL,
        rows,
        tables,
      },
      null,
      2,
    ) + '\n',
  );
};
try {
  for (const [i, q] of CACHE_QUESTIONS.entries()) {
    if (i < rows.length) continue;
    rows.push({ id: q.id, ...(await measuredAgent(q.text)) });
    await save();
    console.log(`baseline ${i + 1}/${CACHE_QUESTIONS.length}`);
  }
  const baselineCostUsd = rows.reduce((s, r) => s + r.costUsd, 0);
  const meanings = new Map(CACHE_QUESTIONS.map((q) => [q.text, q.meaning]));
  for (const threshold of [0.85, 0.9, 0.95]) {
    if (tables.some((row) => row.threshold === threshold)) continue;
    const cache = new SemanticCache(provider, threshold, 86_400_000);
    let hits = 0,
      falseHits = 0,
      unsafeHits = 0,
      totalLatencyMs = 0,
      totalCostUsd = 0;
    const requests = [];
    for (const [i, q] of CACHE_QUESTIONS.entries()) {
      const lookupStarted = performance.now();
      const lookup = await cache.lookup(q.text, 'fixed-synthetic-store');
      const lookupMs = performance.now() - lookupStarted;
      if (lookup.event.reason === 'embedding_error')
        throw new Error('Embedding failure; refusing misleading cache results');
      const hit = lookup.answer !== undefined;
      let measured: Awaited<ReturnType<typeof measuredAgent>> | undefined;
      if (hit) {
        hits++;
        if (meanings.get(lookup.matchedQuestion!) !== q.meaning) falseHits++;
        if (q.kind !== 'paraphrase') unsafeHits++;
      } else {
        measured = await measuredAgent(q.text);
        if (lookup.candidate && measured.cacheable) cache.put(lookup.candidate, measured.answer);
      }
      const latencyMs = lookupMs + (measured?.latencyMs ?? 0);
      const costUsd = lookup.event.estimatedEmbeddingCostUsd + (measured?.costUsd ?? 0);
      totalLatencyMs += latencyMs;
      totalCostUsd += costUsd;
      requests.push({
        id: q.id,
        hit,
        matchedQuestion: lookup.matchedQuestion,
        latencyMs,
        costUsd,
        event: lookup.event,
        model: measured,
      });
      console.log(
        `threshold ${threshold}: ${i + 1}/${CACHE_QUESTIONS.length} ${hit ? 'hit' : 'miss'}`,
      );
    }
    tables.push({
      threshold,
      questions: rows.length,
      hits,
      hitRate: hits / rows.length,
      falseHits,
      falseHitRate: hits ? falseHits / hits : 0,
      unsafeHits,
      baselineAverageLatencyMs: rows.reduce((s, r) => s + r.latencyMs, 0) / rows.length,
      cacheAverageLatencyMs: totalLatencyMs / rows.length,
      baselineCostUsd,
      cacheCostUsd: totalCostUsd,
      estimatedSavingsUsd: baselineCostUsd - totalCostUsd,
      estimatedSavingsPercent: (100 * (baselineCostUsd - totalCostUsd)) / baselineCostUsd,
      requests,
    });
    await save();
  }
  console.table(
    tables.map(({ requests, ...row }) => ({ ...row, requests: (requests as unknown[]).length })),
  );
} finally {
  await pool.end();
}
