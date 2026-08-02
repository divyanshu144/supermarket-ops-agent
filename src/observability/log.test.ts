import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logTurn } from './log.js';

let written: string[];

beforeEach(() => {
  written = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void written.push(line));
});

afterEach(() => vi.restoreAllMocks());

const base = {
  updateId: 42n,
  storeId: 7n,
  tools: ['mcp__store__get_stock'],
  durationMs: 1234,
  outcome: 'ok' as const,
};

describe('logTurn', () => {
  it('writes one line of JSON with bigints stringified', () => {
    logTurn(base);
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0]!);
    expect(parsed.update_id).toBe('42');
    expect(parsed.store_id).toBe('7');
    expect(parsed.duration_ms).toBe(1234);
    expect(parsed.tools).toEqual(['mcp__store__get_stock']);
    expect(parsed.outcome).toBe('ok');
    expect(typeof parsed.ts).toBe('string');
  });

  it('omits message text unless logging text is enabled', () => {
    logTurn({ ...base, text: 'Ramesh owes 485' }, { includeText: false });
    expect(written[0]).not.toContain('Ramesh');
  });

  it('includes message text when enabled', () => {
    logTurn({ ...base, text: 'Ramesh owes 485' }, { includeText: true });
    expect(JSON.parse(written[0]!).text).toBe('Ramesh owes 485');
  });

  it('redacts secrets that reach the error field', () => {
    logTurn({
      ...base,
      outcome: 'error',
      error: new Error('failed with 7891234560:AAHkq2LpXvBn3RtYw8ZcQe1FgH5JmNoPqRs'),
    });
    expect(written[0]).not.toContain('AAHkq2LpXvBn3RtYw8ZcQe1FgH5JmNoPqRs');
  });
});
