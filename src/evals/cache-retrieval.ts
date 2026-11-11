import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { AppleWordEmbeddings, OpenAIEmbeddings } from '../cache/embeddings.js';
import { SemanticCache } from '../cache/semantic.js';
import { CACHE_QUESTIONS } from './cache-cases.js';
const provider = process.env.OPENAI_API_KEY
  ? new OpenAIEmbeddings(process.env.OPENAI_API_KEY)
  : new AppleWordEmbeddings();
const referenceAnswers: Record<string, string> = {
  'add-product':
    'Provide the product name, unit, HSN, supported GST slab, cost and MRP. Review the registration and confirm it.',
  'receive-stock':
    'Describe the delivered product, quantity and unit. Include price changes only if intended. Review and confirm the stock receipt.',
  'open-bill':
    'Ask to start a bill, then name the products, quantities and units. Review each proposed change and confirm before finalizing payment.',
  'edit-bill':
    'Identify the draft bill and the product, then state the new quantity and unit. Review and confirm the edit.',
  'void-bill':
    'Identify the finalized bill and request a reversal. Review and confirm using the owner button; the system records the reversal.',
  'invoice-pdf':
    'Identify the finalized bill and ask for its PDF invoice. The bot generates and sends the document.',
  'khata-payment':
    'Name the customer and amount received. Review the payment and confirm using the owner button.',
  'khata-charge':
    'Name the customer and credit amount. For a sale of goods, build a bill and choose khata payment. Review and confirm the charge.',
};
const meanings = new Map(CACHE_QUESTIONS.map((q) => [q.text, q.meaning]));
const tables = [];
for (const threshold of [0.85, 0.9, 0.95]) {
  const cache = new SemanticCache(provider, threshold);
  let hits = 0,
    falseHits = 0,
    unsafeHits = 0,
    totalMs = 0;
  const requests = [];
  for (const q of CACHE_QUESTIONS) {
    const start = performance.now();
    const found = await cache.lookup(q.text, 'synthetic-reference-store');
    if (found.event.reason === 'embedding_error')
      throw new Error('Real embedding failure; no synthetic fallback');
    const latencyMs = performance.now() - start;
    totalMs += latencyMs;
    const hit = found.answer !== undefined;
    if (hit) {
      hits++;
      if (meanings.get(found.matchedQuestion!) !== q.meaning) falseHits++;
      if (q.kind !== 'paraphrase') unsafeHits++;
    } else if (found.candidate && referenceAnswers[q.meaning])
      cache.put(found.candidate, referenceAnswers[q.meaning]!);
    requests.push({
      id: q.id,
      kind: q.kind,
      hit,
      matchedQuestion: found.matchedQuestion,
      latencyMs,
      event: found.event,
    });
  }
  tables.push({
    threshold,
    questions: CACHE_QUESTIONS.length,
    hits,
    hitRate: hits / CACHE_QUESTIONS.length,
    falseHits,
    falseHitRate: hits ? falseHits / hits : 0,
    unsafeHits,
    averageLookupMs: totalMs / CACHE_QUESTIONS.length,
    requests,
  });
}
await mkdir('evals/engineering/results', { recursive: true });
await writeFile(
  'evals/engineering/results/cache-retrieval.json',
  JSON.stringify(
    {
      provenance: 'measured real embeddings with authored reference answers; no LLM calls',
      provider: provider.id,
      corpusSha256: createHash('sha256').update(JSON.stringify(CACHE_QUESTIONS)).digest('hex'),
      createdAt: new Date().toISOString(),
      platform: process.platform,
      referenceAnswers,
      tables,
    },
    null,
    2,
  ) + '\n',
);
console.table(tables.map(({ requests, ...row }) => ({ ...row, requests: requests.length })));
