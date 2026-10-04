import { describe, expect, it } from 'vitest';
import { loadEnv, shouldLogMessageText } from './env.js';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  TELEGRAM_BOT_TOKEN: 'token',
  ANTHROPIC_API_KEY: 'key',
  AGENT_EFFORT: 'medium',
  NODE_ENV: 'test',
};

describe('loadEnv', () => {
  it('returns a typed env when every value is present', () => {
    expect(loadEnv(valid).AGENT_EFFORT).toBe('medium');
  });

  it('throws naming the missing variable', () => {
    const { TELEGRAM_BOT_TOKEN, ...missing } = valid;
    expect(() => loadEnv(missing)).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('rejects an unknown effort level', () => {
    expect(() => loadEnv({ ...valid, AGENT_EFFORT: 'turbo' })).toThrow(/AGENT_EFFORT/);
  });

  it('defaults effort to medium when unset', () => {
    const { AGENT_EFFORT, ...rest } = valid;
    expect(loadEnv(rest).AGENT_EFFORT).toBe('medium');
  });
});

describe('shouldLogMessageText', () => {
  it('returns true when LOG_MESSAGE_TEXT is explicitly true', () => {
    expect(shouldLogMessageText(loadEnv({ ...valid, LOG_MESSAGE_TEXT: 'true' }))).toBe(true);
  });

  it('returns false when LOG_MESSAGE_TEXT is explicitly false', () => {
    expect(shouldLogMessageText(loadEnv({ ...valid, LOG_MESSAGE_TEXT: 'false' }))).toBe(false);
  });

  it('defaults to false in production when unset', () => {
    expect(shouldLogMessageText(loadEnv({ ...valid, NODE_ENV: 'production' }))).toBe(false);
  });

  it('defaults to true in development when unset', () => {
    expect(shouldLogMessageText(loadEnv({ ...valid, NODE_ENV: 'development' }))).toBe(true);
  });
});

describe('loadEnv limits', () => {
  it('applies the documented defaults', () => {
    const env = loadEnv(valid);
    expect(env.AGENT_MODEL).toBe('claude-opus-5');
    expect(env.AGENT_FALLBACK_MODEL).toBeUndefined();
    expect(env.AGENT_MAX_TURNS).toBe(15);
    expect(env.AGENT_MAX_BUDGET_USD).toBe(0.5);
    expect(env.AGENT_TURN_TIMEOUT_MS).toBe(90_000);
    expect(env.STORE_DAILY_BUDGET_USD).toBe(5);
    expect(env.RATE_LIMIT_TURNS).toBe(20);
    expect(env.RATE_LIMIT_WINDOW_S).toBe(600);
  });

  it('coerces numeric strings from the environment', () => {
    expect(loadEnv({ ...valid, AGENT_MAX_TURNS: '7' }).AGENT_MAX_TURNS).toBe(7);
    expect(loadEnv({ ...valid, AGENT_MAX_BUDGET_USD: '1.25' }).AGENT_MAX_BUDGET_USD).toBe(1.25);
  });

  it('caps the turn timeout at 10 minutes', () => {
    expect(loadEnv({ ...valid, AGENT_TURN_TIMEOUT_MS: '600000' }).AGENT_TURN_TIMEOUT_MS).toBe(
      600_000,
    );
    expect(() => loadEnv({ ...valid, AGENT_TURN_TIMEOUT_MS: '600001' })).toThrow(
      /AGENT_TURN_TIMEOUT_MS/,
    );
  });

  it('rejects an infinite budget cap', () => {
    expect(() => loadEnv({ ...valid, AGENT_MAX_BUDGET_USD: 'Infinity' })).toThrow(
      /AGENT_MAX_BUDGET_USD/,
    );
  });

  it('rejects a non-positive limit', () => {
    expect(() => loadEnv({ ...valid, AGENT_MAX_BUDGET_USD: '0' })).toThrow(/AGENT_MAX_BUDGET_USD/);
    expect(() => loadEnv({ ...valid, RATE_LIMIT_TURNS: '-3' })).toThrow(/RATE_LIMIT_TURNS/);
  });

  it('rejects a fallback model equal to the primary', () => {
    expect(() =>
      loadEnv({ ...valid, AGENT_MODEL: 'claude-opus-5', AGENT_FALLBACK_MODEL: 'claude-opus-5' }),
    ).toThrow(/AGENT_FALLBACK_MODEL/);
  });
});
