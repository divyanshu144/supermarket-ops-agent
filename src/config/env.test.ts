import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

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
