export interface Embedding {
  vector: number[];
  tokens: number;
  estimatedCostUsd: number;
}
export interface EmbeddingProvider {
  id: string;
  embed(text: string): Promise<Embedding>;
}
export interface CacheEntry {
  question: string;
  answer: string;
  vector: number[];
  scope: string;
  intent: string;
  expiresAt: number;
}
export interface CacheEvent {
  status: 'hit' | 'miss';
  reason: string;
  latencyMs: number;
  similarity: number | null;
  embeddingTokens: number;
  estimatedEmbeddingCostUsd: number;
}

// A deliberately closed grammar for procedural help, not an agent intent router.
// Anything outside it goes to the normal agent, including mixed requests and GST rates.
const tasks: Array<[string, RegExp]> = [
  ['add-product', /(?:add|register|create) (?:a |an |new |a new )?(?:product|item|sku)/],
  [
    'receive-stock',
    /(?:receive|record|book|add) (?:a |an |new |a new )?(?:stock delivery|delivery|stock shipment|stock)/,
  ],
  ['open-bill', /(?:open|start|create) (?:a |an |new |a new )?(?:bill|sale|invoice)/],
  ['edit-bill', /(?:edit|amend|change|update) (?:a |the )?(?:draft bill|draft invoice)/],
  [
    'void-bill',
    /(?:void|reverse|cancel) (?:a |the )?(?:finalized bill|completed bill|finalized invoice)/,
  ],
  [
    'invoice-pdf',
    /(?:generate|download|export|create) (?:a |an |the )?(?:pdf invoice|invoice pdf|gst invoice pdf)/,
  ],
  [
    'khata-payment',
    /(?:record|enter|register) (?:a |an )?(?:khata payment|customer repayment|credit repayment)/,
  ],
  [
    'khata-charge',
    /(?:record|enter|register) (?:a |an )?(?:khata charge|credit sale|customer credit charge)/,
  ],
  [
    'daily-report',
    /(?:request|generate|get|view) (?:a |the )?(?:daily report|daily sales report|daily summary)/,
  ],
  [
    'stock-report',
    /(?:request|generate|get|view) (?:a |the )?(?:stock report|inventory report|stock list)/,
  ],
  ['preferences', /(?:set|save|change|update) (?:a |my |the )?(?:preference|default payment mode)/],
  ['reset-chat', /(?:reset|clear|restart) (?:a |my |the )?(?:conversation|chat)/],
];
export function cacheIntent(text: string): string | null {
  if (text.length > 180) return null;
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[?.!]$/, '');
  const prefix =
    /^(?:how (?:do i|can i|should i|to)|what is the (?:procedure|process) to|explain how to|tell me how to|show me how to|what are the steps to) /;
  if (!prefix.test(normalized)) return null;
  const task = normalized.replace(prefix, '');
  for (const [intent, pattern] of tasks) {
    if (
      new RegExp(`^(?:${pattern.source})(?: in superops| using superops| in the bot)?$`).test(task)
    )
      return intent;
  }
  return null;
}
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (!a.length || a.length !== b.length || [...a, ...b].some((v) => !Number.isFinite(v)))
    return -1;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    aa += a[i]! ** 2;
    bb += b[i]! ** 2;
  }
  return aa && bb ? Math.max(-1, Math.min(1, dot / Math.sqrt(aa * bb))) : -1;
}
export class SemanticCache {
  private entries: CacheEntry[] = [];
  constructor(
    readonly provider: EmbeddingProvider,
    readonly threshold = 0.9,
    readonly ttlMs = 3_600_000,
    readonly maxEntries = 500,
    private now = Date.now,
  ) {
    if (
      !(threshold > 0 && threshold <= 1) ||
      !Number.isFinite(ttlMs) ||
      ttlMs <= 0 ||
      !Number.isInteger(maxEntries) ||
      maxEntries <= 0
    )
      throw new Error('Invalid cache configuration');
  }
  async lookup(
    question: string,
    scope: string,
  ): Promise<{
    answer?: string;
    matchedQuestion?: string;
    candidate?: Omit<CacheEntry, 'answer' | 'expiresAt'>;
    event: CacheEvent;
  }> {
    const started = performance.now();
    const event: CacheEvent = {
      status: 'miss',
      reason: 'ineligible',
      latencyMs: 0,
      similarity: null,
      embeddingTokens: 0,
      estimatedEmbeddingCostUsd: 0,
    };
    const intent = cacheIntent(question);
    if (!intent) return { event: { ...event, latencyMs: performance.now() - started } };
    this.entries = this.entries.filter((e) => e.expiresAt > this.now());
    try {
      const embedding = await this.provider.embed(question);
      if (cosine(embedding.vector, embedding.vector) < 0.99) throw new Error('Invalid embedding');
      event.embeddingTokens = embedding.tokens;
      event.estimatedEmbeddingCostUsd = embedding.estimatedCostUsd;
      const candidate = {
        question,
        scope: `${this.provider.id}:${scope}`,
        intent,
        vector: embedding.vector,
      };
      let best: CacheEntry | undefined;
      let score = -1;
      for (const entry of this.entries) {
        if (entry.scope !== candidate.scope || entry.intent !== intent) continue;
        const similarity = cosine(entry.vector, candidate.vector);
        if (similarity > score) {
          best = entry;
          score = similarity;
        }
      }
      event.similarity = best ? score : null;
      if (best && score >= this.threshold) {
        event.status = 'hit';
        event.reason = 'similar';
      } else event.reason = best ? 'below_threshold' : 'cold';
      event.latencyMs = performance.now() - started;
      return {
        ...(event.status === 'hit'
          ? { answer: best!.answer, matchedQuestion: best!.question }
          : { candidate }),
        event,
      };
    } catch {
      return {
        event: { ...event, reason: 'embedding_error', latencyMs: performance.now() - started },
      };
    }
  }
  put(candidate: Omit<CacheEntry, 'answer' | 'expiresAt'>, answer: string): void {
    if (!answer.trim() || answer.length > 8000) return;
    this.entries = this.entries.filter((e) => e.expiresAt > this.now());
    this.entries.push({
      ...candidate,
      vector: [...candidate.vector],
      answer,
      expiresAt: this.now() + this.ttlMs,
    });
    if (this.entries.length > this.maxEntries)
      this.entries.splice(0, this.entries.length - this.maxEntries);
  }
}
