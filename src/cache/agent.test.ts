import { expect, it, vi } from 'vitest';
import { runCachedAgent } from './agent.js';
import { SemanticCache } from './semantic.js';
import { newToolContext, toolContext } from '../tools/context.js';
import type { AgentResult } from '../agent/runtime.js';
const provider = {
  id: 'unit-test',
  embed: async () => ({ vector: [1, 0], tokens: 2, estimatedCostUsd: 0.000001 }),
};
const result: AgentResult = {
  reply: 'Describe the product and its unit to register it.',
  sessionId: 'test-session',
  toolsUsed: [],
  outcome: 'ok',
  totalCostUsd: 0.1,
  turnCostUsd: 0.1,
  numTurns: 1,
  resumeDropped: false,
  attempts: [],
};
it('returns an eligible cached answer without invoking the model or creating a session', async () => {
  const agent = vi.fn(async () => result);
  const cache = new SemanticCache(provider);
  await toolContext.run(newToolContext(1n, 1n), () =>
    runCachedAgent({ text: 'How do I add a product?' }, cache, agent),
  );
  const hit = await toolContext.run(newToolContext(1n, 2n), () =>
    runCachedAgent({ text: 'How can I register an item?' }, cache, agent),
  );
  expect(agent).toHaveBeenCalledTimes(1);
  expect(hit.sessionId).toBe('');
  expect(hit.numTurns).toBe(0);
  expect(hit.turnCostUsd).toBe(0.000001);
});
it('never stores tool-backed answers and bypasses conversation context', async () => {
  const agent = vi.fn(async () => ({ ...result, toolsUsed: ['mcp__store__get_stock'] }));
  const cache = new SemanticCache(provider);
  for (let i = 0; i < 2; i++)
    await toolContext.run(newToolContext(1n, BigInt(i)), () =>
      runCachedAgent({ text: 'How do I add a product?' }, cache, agent),
    );
  expect(agent).toHaveBeenCalledTimes(2);
  const clean = vi.fn(async () => result);
  await toolContext.run(newToolContext(1n, 3n), () =>
    runCachedAgent({ text: 'How do I add a product?' }, cache, clean),
  );
  await toolContext.run(newToolContext(1n, 4n), () =>
    runCachedAgent({ text: 'How do I add a product?', sessionId: 'existing' }, cache, clean),
  );
  expect(clean).toHaveBeenCalledTimes(2);
});
