import type { Env } from '../config/env.js';

export type AgentOutcome = 'ok' | 'max_turns' | 'max_budget' | 'timeout' | 'error';

export interface RunLimits {
  model: string;
  fallbackModel?: string;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
}

export function runLimits(env: Env): RunLimits {
  return {
    model: env.AGENT_MODEL,
    fallbackModel: env.AGENT_FALLBACK_MODEL || undefined,
    maxTurns: env.AGENT_MAX_TURNS,
    maxBudgetUsd: env.AGENT_MAX_BUDGET_USD,
    timeoutMs: env.AGENT_TURN_TIMEOUT_MS,
  };
}

export function classifyResult(result: { subtype: string; is_error: boolean }): AgentOutcome {
  if (result.subtype === 'error_max_turns') return 'max_turns';
  if (result.subtype === 'error_max_budget_usd') return 'max_budget';
  if (result.subtype === 'success') return result.is_error ? 'error' : 'ok';
  return 'error';
}

/** Model spend is kept as integer micro-USD; see schema.ts `usage`. */
export function microUsd(usd: number | undefined): number {
  return Math.max(0, Math.round((usd ?? 0) * 1_000_000));
}

/**
 * Per the Agent SDK docs, `total_cost_usd` on a resumed session includes the session's earlier
 * spend. `src/agent/cost.probe.ts` confirms this and whether `maxBudgetUsd` compares against
 * the same cumulative figure. If the probe shows per-call semantics, flip this to false — the
 * two helpers below are the only code that depends on it.
 */
export const SDK_COST_IS_CUMULATIVE = true;

/** The `maxBudgetUsd` to pass so the cap bounds THIS run, not the whole conversation. */
export function perRunBudgetUsd(
  cap: number,
  priorUsd: number,
  cumulative: boolean = SDK_COST_IS_CUMULATIVE,
): number {
  return cumulative ? cap + priorUsd : cap;
}

/** What this run cost, given the SDK's reported total and what the session had cost before. */
export function turnCostUsd(
  totalUsd: number,
  priorUsd: number,
  cumulative: boolean = SDK_COST_IS_CUMULATIVE,
): number {
  return cumulative ? Math.max(0, totalUsd - priorUsd) : totalUsd;
}

export const OUTCOME_REPLY: Record<Exclude<AgentOutcome, 'ok'>, string> = {
  max_turns: 'That was too much for one go. Try it in smaller steps?',
  max_budget: 'That was too much for one go. Try it in smaller steps?',
  timeout:
    'That took too long and I stopped partway. Check what went through (ask for the last bill or the stock) before repeating it, so nothing is done twice.',
  error: 'Something went wrong on my side. Try that again?',
};
