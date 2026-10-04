import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: vi.fn(),
}));

vi.mock('./session-store.js', () => ({
  postgresSessionStore: { __store: true },
  sessionExists: vi.fn(),
}));

process.env.DATABASE_URL ??= 'postgres://u:p@localhost:5432/db';
process.env.TELEGRAM_BOT_TOKEN ??= 't';
process.env.ANTHROPIC_API_KEY ??= 'k';
process.env.AGENT_TURN_TIMEOUT_MS = '50';

type Msg = Record<string, unknown>;
interface QueryArgs {
  prompt: string;
  options: {
    abortController: AbortController;
    maxBudgetUsd?: number;
    resume?: string;
    sessionStore?: unknown;
  };
}

const { query } = await import('@anthropic-ai/claude-agent-sdk');
const { runAgent } = await import('./runtime.js');
const { OUTCOME_REPLY } = await import('./limits.js');
const { sessionExists } = await import('./session-store.js');
const sessionExistsMock = vi.mocked(sessionExists);

const mockQuery = vi.mocked(query) as unknown as ReturnType<typeof vi.fn>;

const system: Msg = { type: 'system', session_id: 'sess-1' };
const text = (t: string): Msg => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text: t }] },
});
const result = (subtype: string, isError: boolean, cost: number, turns: number): Msg => ({
  type: 'result',
  subtype,
  is_error: isError,
  total_cost_usd: cost,
  num_turns: turns,
});

/** Yields the messages, then (optionally) hangs until aborted and throws, like the SDK. */
function fake(messages: Msg[], after: 'end' | 'throw' | 'hang', error = new Error('boom')) {
  mockQuery.mockImplementation((...a: unknown[]) => {
    const { options } = a[0] as QueryArgs;
    return (async function* () {
      for (const m of messages) yield m;
      if (after === 'throw') throw error;
      if (after === 'hang') {
        const signal = options.abortController.signal;
        await new Promise<void>((_, reject) => {
          if (signal.aborted) reject(new Error('aborted'));
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
    })();
  });
}

beforeAll(() => {
  expect(process.env.AGENT_TURN_TIMEOUT_MS).toBe('50');
});
beforeEach(() => {
  mockQuery.mockReset();
  sessionExistsMock.mockReset();
  sessionExistsMock.mockResolvedValue(true);
});

describe('runAgent', () => {
  it('returns the reply and per-run cost on success', async () => {
    fake([system, text('hello'), result('success', false, 0.4, 2)], 'end');
    const r = await runAgent({ text: 'hi', priorCostUsd: 0.1 });
    expect(r).toMatchObject({ outcome: 'ok', reply: 'hello', totalCostUsd: 0.4, numTurns: 2 });
    expect(r.turnCostUsd).toBeCloseTo(0.3);
    expect(r.sessionId).toBe('sess-1');
  });

  it('swallows the throw that follows an error result', async () => {
    fake([system, result('error_max_turns', true, 0.2, 15)], 'throw');
    const r = await runAgent({ text: 'hi' });
    expect(r.outcome).toBe('max_turns');
    expect(r.reply).toBe(OUTCOME_REPLY.max_turns);
    expect(r.totalCostUsd).toBe(0.2);
  });

  it('maps a timeout with no result to timeout and keeps the session total unchanged', async () => {
    fake([system], 'hang');
    const r = await runAgent({ text: 'hi', priorCostUsd: 0.7 });
    expect(r.outcome).toBe('timeout');
    expect(r.totalCostUsd).toBe(0.7);
    // Unknown real spend: charge the per-run cap (default 0.5) so the daily budget over-counts.
    expect(r.turnCostUsd).toBe(0.5);
    expect(r.reply).toBe(OUTCOME_REPLY.timeout);
  });

  it('keeps a real result when the abort fires late', async () => {
    fake([system, text('done'), result('success', false, 0.3, 1)], 'hang');
    const r = await runAgent({ text: 'hi' });
    expect(r.outcome).toBe('ok');
    expect(r.reply).toBe('done');
    expect(r.turnCostUsd).toBeCloseTo(0.3); // real cost, not the cap
  });

  it('passes the bare cap with no prior spend and cap + prior on a resumed session', async () => {
    fake([system, text('a'), result('success', false, 0.1, 1)], 'end');
    await runAgent({ text: 'hi' });
    const first = (mockQuery.mock.calls[0]![0] as QueryArgs).options.maxBudgetUsd;
    expect(first).toBe(0.5);

    mockQuery.mockReset();
    fake([system, text('a'), result('success', false, 0.2, 1)], 'end');
    await runAgent({ text: 'hi', sessionId: 'sess-1', priorCostUsd: 0.1 });
    const second = (mockQuery.mock.calls[0]![0] as QueryArgs).options.maxBudgetUsd;
    expect(second).toBeCloseTo(0.6);
  });

  it('warns once, with numbers only, when a resumed total falls below the prior total', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      fake([system, text('secret reply'), result('success', false, 0.05, 1)], 'end');
      await runAgent({ text: 'hi', sessionId: 'sess-1', priorCostUsd: 0.3 });
      expect(warn).toHaveBeenCalledTimes(1);
      const line = JSON.parse(String(warn.mock.calls[0]![0]));
      expect(line).toMatchObject({ scope: 'cost', prior: 0.3, total: 0.05 });
      expect(JSON.stringify(line)).not.toContain('secret');
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn on a normal resume or on a fresh session', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      fake([system, text('a'), result('success', false, 0.4, 1)], 'end');
      await runAgent({ text: 'hi', sessionId: 'sess-1', priorCostUsd: 0.3 });
      await runAgent({ text: 'hi' });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('rethrows a genuine failure with no result and no timeout', async () => {
    fake([], 'throw', new Error('network down'));
    await expect(runAgent({ text: 'hi' })).rejects.toThrow('network down');
  });
});

describe('runAgent — session store and resume', () => {
  it('passes the Postgres store and the resume id when the session is known', async () => {
    fake([system, text('a'), result('success', false, 0.2, 1)], 'end');
    const r = await runAgent({ text: 'hi', sessionId: 'sess-1', priorCostUsd: 0.1 });
    const opts = (mockQuery.mock.calls[0]![0] as QueryArgs).options;
    expect(opts.resume).toBe('sess-1');
    expect(opts.sessionStore).toEqual({ __store: true });
    expect(r.resumeDropped).toBe(false);
  });

  it('drops an unknown session to a fresh one with prior cost 0 (the pre-mirror sessions)', async () => {
    sessionExistsMock.mockResolvedValue(false);
    fake([system, text('hello'), result('success', false, 0.2, 1)], 'end');

    const r = await runAgent({ text: 'hi', sessionId: 'old-local-only', priorCostUsd: 0.6 });

    const opts = (mockQuery.mock.calls[0]![0] as QueryArgs).options;
    expect(opts.resume).toBeUndefined();
    expect(opts.maxBudgetUsd).toBe(0.5); // bare cap: the stale 0.6 must not widen it
    expect(r.resumeDropped).toBe(true);
    expect(r.outcome).toBe('ok');
    expect(r.turnCostUsd).toBeCloseTo(0.2); // charged in full, not total - 0.6 clamped to 0
  });

  it('retries once without resume when the run fails to start before any output', async () => {
    mockQuery
      .mockImplementationOnce(() =>
        // eslint-disable-next-line require-yield -- throws before yielding, like a failed spawn
        (async function* () {
          throw new Error('No conversation found with session ID');
        })(),
      )
      .mockImplementationOnce(() =>
        (async function* () {
          yield system;
          yield text('fresh');
          yield result('success', false, 0.1, 1);
        })(),
      );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await runAgent({ text: 'hi', sessionId: 'sess-1', priorCostUsd: 0.3 });
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect((mockQuery.mock.calls[1]![0] as QueryArgs).options.resume).toBeUndefined();
      expect(r).toMatchObject({ outcome: 'ok', reply: 'fresh', resumeDropped: true });
      expect(r.turnCostUsd).toBeCloseTo(0.1);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not retry a failure that happens after output has started', async () => {
    fake([system, text('partial')], 'throw', new Error('mid-run failure'));
    await expect(runAgent({ text: 'hi', sessionId: 'sess-1' })).rejects.toThrow('mid-run failure');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('does not retry a failure on a fresh run (nothing to drop), and never loops', async () => {
    fake([], 'throw', new Error('boom'));
    await expect(runAgent({ text: 'hi' })).rejects.toThrow('boom');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('surfaces the retry failure itself if the fresh start also fails', async () => {
    mockQuery.mockImplementation(() =>
      // eslint-disable-next-line require-yield -- throws before yielding, like a failed spawn
      (async function* () {
        throw new Error('still broken');
      })(),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(runAgent({ text: 'hi', sessionId: 'sess-1' })).rejects.toThrow('still broken');
      expect(mockQuery).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('runAgent — mirror failures', () => {
  it('logs a mirror failure without the error text, which can contain conversation content', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      fake(
        [
          system,
          {
            type: 'system',
            subtype: 'mirror_error',
            session_id: 'sess-1',
            error: 'Failed query: insert ... params: {"text":"khata for Ramesh is 4000"}',
            key: { projectKey: '/p', sessionId: 'sess-1' },
          },
          text('ok'),
          result('success', false, 0.1, 1),
        ],
        'end',
      );
      const r = await runAgent({ text: 'hi' });
      expect(r.outcome).toBe('ok'); // a mirror failure never fails the turn
      expect(err).toHaveBeenCalledTimes(1);
      const line = String(err.mock.calls[0]![0]);
      expect(line).toContain('sess-1');
      expect(line).not.toContain('Ramesh');
      expect(line).not.toContain('Failed query');
    } finally {
      err.mockRestore();
    }
  });
});
