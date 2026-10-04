/**
 * Probe: how does the Agent SDK account cost across a resumed session?
 *
 *   pnpm tsx src/agent/cost.probe.ts
 *
 * Two questions, both about `resume`:
 *   1. Does turn 2's total_cost_usd include turn 1's spend?        (cumulative or per-call)
 *   2. Does maxBudgetUsd compare against that cumulative figure?   (turn 3 uses a cap smaller
 *      than turn 1's spend; if it stops with error_max_budget_usd at once, the cap is cumulative)
 *
 * Record the result in tasks/agent_memory.md and set SDK_COST_IS_CUMULATIVE in limits.ts.
 */
import 'dotenv/config';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

async function turn(prompt: string, resume?: string, maxBudgetUsd?: number) {
  let sessionId = resume ?? '';
  let total: number | undefined;
  let subtype = '';
  try {
    for await (const m of query({
      prompt,
      options: {
        model: env.AGENT_MODEL,
        resume,
        maxBudgetUsd,
        maxTurns: 3,
        settingSources: [],
        allowedTools: [],
      },
    })) {
      if (m.type === 'system' && 'session_id' in m) sessionId = String(m.session_id);
      if (m.type === 'result') {
        total = m.total_cost_usd;
        subtype = m.subtype;
      }
    }
  } catch (error) {
    console.log(`  (threw after result: ${(error as Error).message})`);
  }
  console.log(`  subtype=${subtype} total_cost_usd=${total}`);
  return { sessionId, total };
}

console.log('turn 1');
const one = await turn('Reply with the single word: ready');
console.log('turn 2 (resume)');
const two = await turn('Reply with the single word: again', one.sessionId);
console.log(
  `\nQ1 cumulative? turn2 total ${two.total} vs turn1 total ${one.total} -> ` +
    `${(two.total ?? 0) > (one.total ?? 0) ? 'CUMULATIVE (turn 2 >= turn 1)' : 'PER-CALL'}`,
);

console.log('turn 3 (resume, cap below turn 1 spend)');
const tiny = Math.max((one.total ?? 0) / 2, 0.0001);
await turn('Reply with the single word: third', two.sessionId, tiny);
console.log(
  `\nQ2: cap was ${tiny}. If turn 3 ended error_max_budget_usd, the cap is CUMULATIVE; ` +
    'if it ended success, the cap is PER-RUN.',
);
