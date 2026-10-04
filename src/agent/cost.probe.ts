/**
 * Probe: how does the Agent SDK account cost across a resumed session?
 *
 *   pnpm tsx src/agent/cost.probe.ts
 *
 * Turn 1 is output-heavy (a long essay), so it is expensive relative to the one-word turns after it.
 *   Q1. Is total_cost_usd cumulative across `resume`? Turn 2 is a trivial resume. Under PER-CALL
 *       semantics its total is far BELOW turn 1's; under CUMULATIVE it is always >= turn 1's.
 *   Q2. Is maxBudgetUsd compared against that cumulative figure? Turn 3 resumes with a cap of
 *       0.9 * turn 1's total. If the cap is compared with the cumulative total, the earlier spend
 *       already exceeds it and turn 3 ends error_max_budget_usd. If it ends success, the cap is
 *       PER-RUN, or the budget is only checked between turns and this single-call run slipped
 *       through, which is INCONCLUSIVE.
 *
 * Q1 sets SDK_COST_IS_CUMULATIVE and Q2 sets SDK_BUDGET_IS_CUMULATIVE in limits.ts; they are
 * independent facts and both ship `true` UNVERIFIED. The consequences of a wrong value:
 *   - cost total is really per-call but SDK_COST_IS_CUMULATIVE is true: the daily budget
 *     under-counts and the per-run cap ratchets upward.
 *   - total is cumulative but the cap is really per-run and SDK_BUDGET_IS_CUMULATIVE is true: the
 *     cap is looser than intended by the prior spend. The reverse (cap compared against the
 *     cumulative total, constant false): the per-run cap becomes cap + lifetime session spend
 *     until `/new`.
 *
 * Q3 (printed at the end): does resuming return the SAME session id? If turn 2's session_id
 * differs from turn 1's, a resume forks a new session, which matters for the deferred
 * failed-resume cost fix.
 *
 * Record the result in tasks/agent_memory.md and set both constants in limits.ts.
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
        maxTurns: 1,
        systemPrompt: 'Be brief.',
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
    const seen = total !== undefined ? 'after result' : 'with no result';
    console.log(`  (threw ${seen}: ${(error as Error).message})`);
  }
  console.log(`  subtype=${subtype} total_cost_usd=${total}`);
  return { sessionId, total, subtype };
}

console.log('turn 1 (output-heavy)');
const one = await turn('Write a 1200-word essay about tea.');
console.log('turn 2 (resume, trivial)');
const two = await turn('Reply with one word: ok', one.sessionId);
const oneTotal = one.total ?? 0;
const twoTotal = two.total ?? 0;
console.log(
  `\nQ1: turn 2 total ${twoTotal} vs turn 1 total ${oneTotal} -> ` +
    (twoTotal < oneTotal
      ? 'PER-CALL (definitive)'
      : 'CUMULATIVE (very likely; per-call would need a one-word turn to cost more than a 1200-word essay)'),
);

console.log('turn 3 (resume, cap = 0.9 * turn 1 total)');
const cap = 0.9 * oneTotal;
const three = await turn('Reply with one word: third', two.sessionId, cap);
console.log(
  `\nQ2: cap ${cap}, turn 3 ended ${three.subtype} -> ` +
    (three.subtype === 'error_max_budget_usd'
      ? 'cap is CUMULATIVE'
      : 'cap is PER-RUN, OR the budget is only checked between turns and this single-call run slipped through (INCONCLUSIVE; the shipped default is the safe choice either way)'),
);

console.log(
  `\nQ3: turn 1 session ${one.sessionId}, turn 2 session ${two.sessionId} -> ` +
    (one.sessionId === two.sessionId
      ? 'resume KEEPS the same session id'
      : 'resume returns a DIFFERENT session id (the stored id must be updated every turn)'),
);
