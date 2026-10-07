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
    hooks?: Record<
      string,
      Array<{ hooks: Array<(input: never, toolUseID: string | undefined) => Promise<unknown>> }>
    >;
  };
}

const { query } = await import('@anthropic-ai/claude-agent-sdk');
const { AgentRunFailure, runAgent } = await import('./runtime.js');
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
  usage: {
    input_tokens: 3,
    output_tokens: 4,
    cache_read_input_tokens: 1,
    cache_creation_input_tokens: 2,
  },
  modelUsage: {
    'claude-opus-current': {
      inputTokens: 3,
      outputTokens: 4,
      cacheReadInputTokens: 1,
      cacheCreationInputTokens: 2,
      costUSD: cost,
      contextWindow: 200000,
      maxOutputTokens: 4096,
      canonicalModel: 'claude-opus-current',
      provider: 'firstParty',
    },
  },
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

async function runToolHookScenario(
  hookEvent: 'PostToolUse' | 'PostToolUseFailure',
  protocolIsError: boolean,
) {
  const toolTurn: Msg = {
    type: 'assistant',
    message: {
      content: [{ type: 'mcp_tool_use', id: 'hook-call', name: 'get_stock', input: {} }],
    },
  };
  const returned: Msg = {
    type: 'user',
    message: {
      content: [{ type: 'mcp_tool_result', tool_use_id: 'hook-call', is_error: protocolIsError }],
    },
  };
  fake([system, toolTurn, returned, result('success', false, 0.1, 2)], 'end');
  const promise = runAgent({ text: 'stock?' });
  await vi.waitFor(() => {
    expect((mockQuery.mock.calls[0]?.[0] as QueryArgs).options.hooks).toBeDefined();
  });
  const hooks = (mockQuery.mock.calls[0]?.[0] as QueryArgs).options.hooks!;
  const callback = hooks[hookEvent]?.[0]?.hooks[0];
  expect(callback).toBeDefined();
  await callback!(
    {
      hook_event_name: hookEvent,
      tool_name: 'get_stock',
      tool_input: {},
      tool_response: {},
      tool_use_id: 'hook-call',
      duration_ms: 5,
      ...(hookEvent === 'PostToolUseFailure' ? { error: 'handler failed' } : {}),
    } as never,
    'hook-call',
  );
  return promise;
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
    const assistant = text('hello');
    assistant.message = {
      model: 'claude-opus-current',
      content: [{ type: 'text', text: 'hello' }],
    };
    fake([system, assistant, result('success', false, 0.4, 2)], 'end');
    const r = await runAgent({ text: 'hi', priorCostUsd: 0.1 });
    expect(r).toMatchObject({ outcome: 'ok', reply: 'hello', totalCostUsd: 0.4, numTurns: 2 });
    expect(r.turnCostUsd).toBeCloseTo(0.3);
    expect(r.sessionId).toBe('sess-1');
    expect(r.attempts).toMatchObject([
      {
        ordinal: 1,
        modelIds: ['claude-opus-current'],
        modelUsage: {
          'claude-opus-current': {
            inputTokens: 3,
            outputTokens: 4,
            cacheReadInputTokens: 1,
            cacheCreationInputTokens: 2,
            costUsd: 0.4,
            canonicalModel: 'claude-opus-current',
            provider: 'firstParty',
          },
        },
        resultSubtype: 'success',
        outcome: 'ok',
        inputTokens: 3,
        outputTokens: 4,
        cacheReadInputTokens: 1,
        cacheCreationInputTokens: 2,
        costUsd: 0.4,
        numTurns: 2,
        resumed: false,
        retryFresh: false,
      },
    ]);
  });

  it('keeps repeated registered tool names distinct by SDK call id', async () => {
    const toolTurn: Msg = {
      type: 'assistant',
      message: {
        model: 'claude-sonnet-current',
        content: [
          {
            type: 'mcp_tool_use',
            id: 'call-a',
            name: 'get_stock',
            input: {},
            server_name: 'store',
          },
          {
            type: 'mcp_tool_use',
            id: 'call-b',
            name: 'get_stock',
            input: {},
            server_name: 'store',
          },
        ],
      },
    };
    const returned: Msg = {
      type: 'user',
      message: { content: [{ type: 'mcp_tool_result', tool_use_id: 'call-a' }] },
    };
    fake([system, toolTurn, returned, result('success', false, 0.1, 2)], 'end');
    const r = await runAgent({ text: 'stock?' });
    expect(r.toolsUsed).toEqual(['get_stock', 'get_stock']);
    expect(r.attempts[0]?.toolCalls).toEqual([
      {
        toolUseId: 'call-a',
        name: 'get_stock',
        source: 'mcp',
        resultState: 'returned',
        isError: null,
        sdkExecution: null,
      },
      {
        toolUseId: 'call-b',
        name: 'get_stock',
        source: 'mcp',
        resultState: 'pending',
        isError: null,
        sdkExecution: null,
      },
    ]);
  });

  it('retains explicit model IDs and usage for primary and fallback models', async () => {
    const primary = text('working');
    primary.message = { model: 'claude-primary-raw', content: [{ type: 'text', text: 'working' }] };
    const fallback = text('done');
    fallback.message = { model: 'claude-fallback-raw', content: [{ type: 'text', text: 'done' }] };
    const final = result('success', false, 0.08, 2);
    final.modelUsage = {
      'claude-primary-raw': {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.03,
        contextWindow: 200000,
        maxOutputTokens: 4096,
      },
      'claude-fallback-raw': {
        inputTokens: 5,
        outputTokens: 8,
        cacheReadInputTokens: 1,
        cacheCreationInputTokens: 0,
        costUSD: 0.05,
        contextWindow: 200000,
        maxOutputTokens: 4096,
        canonicalModel: 'claude-fallback-canonical',
        provider: 'firstParty',
      },
    };
    fake([system, primary, fallback, final], 'end');
    const r = await runAgent({ text: 'hi' });
    expect(r.attempts[0]?.modelIds).toEqual(['claude-primary-raw', 'claude-fallback-raw']);
    expect(r.attempts[0]?.modelUsage).toEqual({
      'claude-primary-raw': {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUsd: 0.03,
        canonicalModel: null,
        provider: null,
      },
      'claude-fallback-raw': {
        inputTokens: 5,
        outputTokens: 8,
        cacheReadInputTokens: 1,
        cacheCreationInputTokens: 0,
        costUsd: 0.05,
        canonicalModel: 'claude-fallback-canonical',
        provider: 'firstParty',
      },
    });
  });

  it('records completed same-name calls by SDK hook tool_use_id, including repeated calls', async () => {
    const toolTurn: Msg = {
      type: 'assistant',
      message: {
        model: 'claude-sonnet-current',
        content: [
          { type: 'mcp_tool_use', id: 'repeat-a', name: 'get_stock', input: { product: 'atta' } },
          { type: 'mcp_tool_use', id: 'repeat-b', name: 'get_stock', input: { product: 'atta' } },
        ],
      },
    };
    const returned: Msg = {
      type: 'user',
      message: {
        content: [
          { type: 'mcp_tool_result', tool_use_id: 'repeat-a', is_error: false },
          { type: 'mcp_tool_result', tool_use_id: 'repeat-b', is_error: false },
        ],
      },
    };
    fake([system, toolTurn, returned, result('success', false, 0.1, 2)], 'end');
    const promise = runAgent({ text: 'stock?' });
    await vi.waitFor(async () => {
      const options = (mockQuery.mock.calls[0]?.[0] as QueryArgs).options;
      expect(options.hooks).toBeDefined();
    });
    const hooks = (mockQuery.mock.calls[0]?.[0] as QueryArgs).options.hooks!;
    const postToolUse = hooks.PostToolUse?.[0]?.hooks[0];
    expect(postToolUse).toBeDefined();
    await postToolUse!(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'get_stock',
        tool_input: { product: 'atta' },
        tool_response: { content: [{ type: 'text', text: '1' }] },
        tool_use_id: 'repeat-b',
        duration_ms: 12,
      } as never,
      'repeat-b',
    );
    await postToolUse!(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'get_stock',
        tool_input: { product: 'atta' },
        tool_response: { content: [{ type: 'text', text: '1' }] },
        tool_use_id: 'repeat-a',
        duration_ms: 8,
      } as never,
      'repeat-a',
    );
    const r = await promise;
    expect(r.attempts[0]?.toolCalls).toMatchObject([
      {
        toolUseId: 'repeat-a',
        resultState: 'returned',
        isError: false,
        sdkExecution: { state: 'returned', durationMs: 8 },
      },
      {
        toolUseId: 'repeat-b',
        resultState: 'returned',
        isError: false,
        sdkExecution: { state: 'returned', durationMs: 12 },
      },
    ]);
  });

  it('preserves a PostToolUseFailure outcome when the protocol result says no error', async () => {
    const r = await runToolHookScenario('PostToolUseFailure', false);
    expect(r.attempts[0]?.toolCalls[0]).toMatchObject({
      toolUseId: 'hook-call',
      resultState: 'failed',
      isError: true,
      sdkExecution: { state: 'failed', durationMs: 5 },
    });
  });

  it('lets explicit protocol is_error override a PostToolUse success', async () => {
    const r = await runToolHookScenario('PostToolUse', true);
    expect(r.attempts[0]?.toolCalls[0]).toMatchObject({
      toolUseId: 'hook-call',
      resultState: 'failed',
      isError: true,
      sdkExecution: { state: 'returned', durationMs: 5 },
    });
  });

  it('records a forbidden built-in attempt and leaves a missing tool result pending', async () => {
    const toolTurn: Msg = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'shell-call', name: 'Bash', input: { command: 'pwd' } }],
      },
    };
    fake([system, toolTurn, result('success', false, 0.1, 1)], 'end');
    const r = await runAgent({ text: 'run shell' });
    expect(r.attempts[0]?.toolCalls).toEqual([
      {
        toolUseId: 'shell-call',
        name: 'Bash',
        source: 'builtin',
        resultState: 'pending',
        isError: null,
        sdkExecution: null,
      },
    ]);
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

  it('charges the full cap for an unreported failed resume before a successful fresh retry', async () => {
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
      expect(r.attempts).toMatchObject([
        { ordinal: 1, resumed: true, retryFresh: false, costUsd: null },
        { ordinal: 2, resumed: false, retryFresh: true, costUsd: 0.1 },
      ]);
      // The first query threw before SDK usage, so its cap is added to the fresh retry's cost.
      expect(r.turnCostUsd).toBeCloseTo(0.6);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]![0]);
      expect(line).toContain('"errorName":"Error"');
      expect(line).toContain('"sessionId":"sess-1"');
      expect(line).not.toContain('No conversation found');
    } finally {
      warn.mockRestore();
    }
  });

  it('retries once without resume when a resumed run ends in error_during_execution before any output', async () => {
    mockQuery
      .mockImplementationOnce(() =>
        (async function* () {
          yield system;
          yield result('error_during_execution', true, 0, 0);
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
      expect((mockQuery.mock.calls[0]![0] as QueryArgs).options.resume).toBe('sess-1');
      expect((mockQuery.mock.calls[1]![0] as QueryArgs).options.resume).toBeUndefined();
      expect(r).toMatchObject({ outcome: 'ok', reply: 'fresh', resumeDropped: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).not.toContain('error result');
    } finally {
      warn.mockRestore();
    }
  });

  it('retains failed-resume attempt evidence and spend when retry-fresh succeeds', async () => {
    mockQuery
      .mockImplementationOnce(() =>
        (async function* () {
          yield system;
          yield result('error_during_execution', true, 0.35, 0);
        })(),
      )
      .mockImplementationOnce(() =>
        (async function* () {
          yield system;
          yield text('fresh');
          yield result('success', false, 0.2, 1);
        })(),
      );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await runAgent({ text: 'hi', sessionId: 'sess-1', priorCostUsd: 0.3 });
      expect(r.attempts).toHaveLength(2);
      expect(r.attempts.map((attempt) => attempt.resultSubtype)).toEqual([
        'error_during_execution',
        'success',
      ]);
      expect(r.attempts.map((attempt) => attempt.costUsd)).toEqual([0.35, 0.2]);
      expect(r.attempts.map((attempt) => attempt.resumed)).toEqual([true, false]);
      expect(r.attempts.map((attempt) => attempt.retryFresh)).toEqual([false, true]);
      expect(r.turnCostUsd).toBeCloseTo(0.25);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not retry a resumed success+is_error result (a transient API error must not wipe the conversation)', async () => {
    fake([system, result('success', true, 0.1, 1)], 'end');
    const r = await runAgent({ text: 'hi', sessionId: 'sess-1' });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(r.outcome).toBe('error');
    expect(r.resumeDropped).toBe(false);
  });

  it('does not retry a resumed error_during_execution that came after assistant output', async () => {
    fake([system, text('partial'), result('error_during_execution', true, 0.1, 1)], 'end');
    const r = await runAgent({ text: 'hi', sessionId: 'sess-1' });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(r.outcome).toBe('error');
  });

  it('does not retry error_during_execution on a fresh run', async () => {
    fake([system, result('error_during_execution', true, 0, 0)], 'end');
    const r = await runAgent({ text: 'hi' });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(r.outcome).toBe('error');
  });

  it('does not retry a failure that happens after output has started', async () => {
    fake([system, text('partial')], 'throw', new Error('mid-run failure'));
    await expect(runAgent({ text: 'hi', sessionId: 'sess-1' })).rejects.toThrow('mid-run failure');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the only output so far was a tool call (the tool already ran)', async () => {
    fake(
      [
        system,
        {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'get_stock', id: 't1', input: {} }] },
        },
      ],
      'throw',
      new Error('died after tool call'),
    );
    await expect(runAgent({ text: 'hi', sessionId: 'sess-1' })).rejects.toThrow(
      'died after tool call',
    );
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('does not retry a failure on a fresh run (nothing to drop), and never loops', async () => {
    fake([], 'throw', new Error('boom'));
    await expect(runAgent({ text: 'hi' })).rejects.toThrow('boom');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('preserves both attempts and worst-case cost if the fresh retry also fails', async () => {
    for (const message of ['first', 'second']) {
      mockQuery.mockImplementationOnce(() =>
        // eslint-disable-next-line require-yield -- throws before yielding, like a failed spawn
        (async function* () {
          throw new Error(message);
        })(),
      );
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let failure: unknown;
      try {
        await runAgent({ text: 'hi', sessionId: 'sess-1' });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AgentRunFailure);
      expect(failure).toMatchObject({
        attempts: [
          { ordinal: 1, resumed: true, retryFresh: false, costUsd: null },
          { ordinal: 2, resumed: false, retryFresh: true, costUsd: null },
        ],
        conservativelyChargedTurnCostUsd: 1,
      });
      expect((failure as { original: unknown }).original).toMatchObject({ message: 'second' });
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
