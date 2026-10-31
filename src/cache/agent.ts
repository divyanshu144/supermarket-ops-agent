import { createHash } from 'node:crypto';
import { runAgent, type AgentResult } from '../agent/runtime.js';
import { requireContext } from '../tools/context.js';
import { OpenAIEmbeddings } from './embeddings.js';
import { SemanticCache, type CacheEvent } from './semantic.js';

let shared: SemanticCache | undefined;
function configuredCache(): SemanticCache | undefined {
  if (process.env.SEMANTIC_CACHE_ENABLED !== 'true' || !process.env.OPENAI_API_KEY)
    return undefined;
  return (shared ??= new SemanticCache(
    new OpenAIEmbeddings(process.env.OPENAI_API_KEY),
    Number(process.env.SEMANTIC_CACHE_THRESHOLD ?? 0.9),
    Number(process.env.SEMANTIC_CACHE_TTL_MS ?? 3_600_000),
  ));
}
export async function runCachedAgent(
  input: Parameters<typeof runAgent>[0],
  cache = configuredCache(),
  agent = runAgent,
): Promise<AgentResult> {
  const started = performance.now();
  let event: CacheEvent = {
    status: 'miss',
    reason: cache ? 'conversation' : 'disabled',
    latencyMs: 0,
    similarity: null,
    embeddingTokens: 0,
    estimatedEmbeddingCostUsd: 0,
  };
  let candidate: Awaited<ReturnType<SemanticCache['lookup']>>['candidate'];
  // Resumed sessions may refer to facts or instructions not represented in the question vector.
  // Until transcript continuity is implemented, only standalone turns are eligible.
  if (cache && !input.sessionId) {
    const scope = createHash('sha256')
      .update(
        JSON.stringify({
          store: String(requireContext().storeId),
          preferences: input.preferences ?? {},
          model: process.env.AGENT_MODEL ?? 'claude-opus-5',
          policy: 'procedural-v1',
        }),
      )
      .digest('hex');
    const found = await cache.lookup(input.text, scope);
    event = found.event;
    candidate = found.candidate;
    if (found.answer !== undefined) {
      console.log(
        JSON.stringify({
          scope: 'semantic-cache',
          ...event,
          totalLatencyMs: performance.now() - started,
          estimatedTokenCostUsd: event.estimatedEmbeddingCostUsd,
          modelCostUsd: 0,
        }),
      );
      return {
        reply: found.answer,
        sessionId: '',
        toolsUsed: [],
        outcome: 'ok',
        totalCostUsd: input.priorCostUsd ?? 0,
        turnCostUsd: event.estimatedEmbeddingCostUsd,
        numTurns: 0,
        resumeDropped: false,
        attempts: [],
      };
    }
  }
  try {
    const result = await agent(input);
    // A successful tool-grounded/live-data response is never inserted, even if eligibility erred.
    if (
      cache &&
      candidate &&
      result.outcome === 'ok' &&
      result.toolsUsed.every((name) => name === 'Skill') &&
      requireContext().pendingConfirmations.length === 0 &&
      requireContext().artifacts.length === 0
    )
      cache.put(candidate, result.reply);
    console.log(
      JSON.stringify({
        scope: 'semantic-cache',
        ...event,
        totalLatencyMs: performance.now() - started,
        estimatedTokenCostUsd: result.turnCostUsd + event.estimatedEmbeddingCostUsd,
        modelCostUsd: result.turnCostUsd,
      }),
    );
    return { ...result, turnCostUsd: result.turnCostUsd + event.estimatedEmbeddingCostUsd };
  } catch (error) {
    console.log(
      JSON.stringify({
        scope: 'semantic-cache',
        ...event,
        totalLatencyMs: performance.now() - started,
        outcome: 'error',
        estimatedTokenCostUsd: event.estimatedEmbeddingCostUsd,
      }),
    );
    throw error;
  }
}
