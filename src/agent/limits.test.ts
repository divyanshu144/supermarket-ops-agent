import { describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env.js';
import {
  OUTCOME_REPLY,
  classifyResult,
  microUsd,
  perRunBudgetUsd,
  runLimits,
  turnCostUsd,
} from './limits.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  TELEGRAM_BOT_TOKEN: 't',
  ANTHROPIC_API_KEY: 'k',
  NODE_ENV: 'test',
};

describe('runLimits', () => {
  it('reads the limits from env', () => {
    const limits = runLimits(
      loadEnv({ ...base, AGENT_MAX_TURNS: '9', AGENT_MAX_BUDGET_USD: '0.25' }),
    );
    expect(limits).toMatchObject({
      model: 'claude-opus-5',
      maxTurns: 9,
      maxBudgetUsd: 0.25,
      timeoutMs: 90_000,
    });
  });

  it('treats an empty fallback model as unset', () => {
    expect(runLimits(loadEnv({ ...base, AGENT_FALLBACK_MODEL: '' })).fallbackModel).toBeUndefined();
  });

  it('passes a configured fallback model through', () => {
    expect(
      runLimits(loadEnv({ ...base, AGENT_FALLBACK_MODEL: 'claude-sonnet-5' })).fallbackModel,
    ).toBe('claude-sonnet-5');
  });
});

describe('classifyResult', () => {
  it('maps the SDK result subtypes', () => {
    expect(classifyResult({ subtype: 'success', is_error: false })).toBe('ok');
    expect(classifyResult({ subtype: 'error_max_turns', is_error: true })).toBe('max_turns');
    expect(classifyResult({ subtype: 'error_max_budget_usd', is_error: true })).toBe('max_budget');
    expect(classifyResult({ subtype: 'error_during_execution', is_error: true })).toBe('error');
  });

  it('treats a success whose final API call failed as an error', () => {
    expect(classifyResult({ subtype: 'success', is_error: true })).toBe('error');
  });
});

describe('cost maths', () => {
  it('converts dollars to integer micro-dollars', () => {
    expect(microUsd(0.1234567)).toBe(123_457);
    expect(microUsd(undefined)).toBe(0);
    expect(microUsd(-1)).toBe(0);
  });

  it('charges only the new spend when the SDK total is cumulative', () => {
    expect(turnCostUsd(0.9, 0.6, true)).toBeCloseTo(0.3);
  });

  it('never reports a negative turn cost (a fresh session after a failed resume)', () => {
    expect(turnCostUsd(0.1, 0.6, true)).toBe(0);
  });

  it('uses the total as-is when the SDK reports per-call cost', () => {
    expect(turnCostUsd(0.3, 0.6, false)).toBeCloseTo(0.3);
  });

  it('extends the budget cap by earlier spend only when totals are cumulative', () => {
    expect(perRunBudgetUsd(0.5, 0.6, true)).toBeCloseTo(1.1);
    expect(perRunBudgetUsd(0.5, 0.6, false)).toBe(0.5);
  });
});

describe('OUTCOME_REPLY', () => {
  it('tells the owner to check what went through after a timeout, before repeating', () => {
    expect(OUTCOME_REPLY.timeout).toMatch(/check/i);
    expect(OUTCOME_REPLY.timeout).toMatch(/before/i);
  });

  it('has a reply for every non-ok outcome', () => {
    for (const key of ['max_turns', 'max_budget', 'timeout', 'error'] as const) {
      expect(OUTCOME_REPLY[key].length).toBeGreaterThan(10);
    }
  });
});
