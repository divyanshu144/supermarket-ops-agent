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
 * Two independent SDK facts, both taken from the docs and both UNVERIFIED until
 * `src/agent/cost.probe.ts` has been run against the live API (Q1 sets this one, Q2 the next).
 *
 * SDK_COST_IS_CUMULATIVE drives `turnCostUsd`: is `total_cost_usd` on a resumed session the
 * session's lifetime total (true) or only this call (false)? If it is really per-call but this
 * says true, the daily budget UNDER-counts (we subtract the prior spend from a figure that never
 * included it) and the per-run cap ratchets upward as the stored session total grows.
 */
export const SDK_COST_IS_CUMULATIVE = true;

/**
 * SDK_BUDGET_IS_CUMULATIVE drives `perRunBudgetUsd`: is `maxBudgetUsd` compared against that
 * cumulative session total (true) or only this run's spend (false)? If the SDK compares against
 * the cumulative total but this says false, the per-run cap effectively becomes cap + lifetime
 * session spend until `/new`, i.e. it stops bounding a run. If it is per-run but this says true,
 * the cap is looser than intended by the prior spend.
 */
export const SDK_BUDGET_IS_CUMULATIVE = true;

/** The `maxBudgetUsd` to pass so the cap bounds THIS run, not the whole conversation. */
export function perRunBudgetUsd(
  cap: number,
  priorUsd: number,
  cumulative: boolean = SDK_BUDGET_IS_CUMULATIVE,
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
