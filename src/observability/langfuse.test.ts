import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../config/env.js';
import { LangfuseTurn, flushLangfuse } from './langfuse.js';

function env(capture = 'false') {
  return loadEnv({
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    NEO4J_URI: 'bolt://localhost:7687',
    NEO4J_USERNAME: 'neo4j',
    NEO4J_PASSWORD: 'test-password',
    TELEGRAM_BOT_TOKEN: 'test-token',
    ANTHROPIC_API_KEY: 'test-key',
    LANGFUSE_PUBLIC_KEY: 'public-test',
    LANGFUSE_SECRET_KEY: 'secret-test',
    LANGFUSE_BASE_URL: 'https://langfuse.invalid',
    LANGFUSE_CAPTURE_CONTENT: capture,
    NODE_ENV: 'test',
  });
}

const payloads: string[] = [];

afterEach(async () => {
  await flushLangfuse(100);
  vi.unstubAllGlobals();
  payloads.length = 0;
});

describe('Langfuse trace export', () => {
  it('is a complete export no-op without all credentials', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const disabledEnv = loadEnv({
      DATABASE_URL: 'postgres://test:test@localhost:5432/test',
      NEO4J_URI: 'bolt://localhost:7687',
      NEO4J_USERNAME: 'neo4j',
      NEO4J_PASSWORD: 'test-password',
      TELEGRAM_BOT_TOKEN: 'test-token',
      ANTHROPIC_API_KEY: 'test-key',
      NODE_ENV: 'test',
    });
    new LangfuseTurn(disabledEnv, 123456789n).finish({ outcome: 'ok', costMicroUsd: 123 });
    await flushLangfuse(100);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends pseudonymous metadata and cost without content by default', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        payloads.push(String(init?.body));
        return new Response(null, { status: 200 });
      }),
    );
    const trace = new LangfuseTurn(env(), 123456789n);
    trace.recordCache({ status: 'hit', reason: 'similarity', latencyMs: 5 });
    trace.recordTool({
      callId: 'tool-id',
      toolName: 'get_stock',
      durationMs: 4,
      startedAtMs: Date.now(),
      endedAtMs: Date.now() + 4,
      outcome: 'returned',
      refusalCode: null,
      errorClass: null,
      neededConfirmation: false,
    });
    trace.finish({
      outcome: 'ok',
      costMicroUsd: 450,
      input: 'customer Rohit owes ₹150',
      output: 'Rohit owes ₹150',
      attempts: [
        {
          startedAtMs: Date.now() - 5,
          endedAtMs: Date.now(),
          modelIds: ['claude-opus-5'],
          inputTokens: 20,
          outputTokens: 5,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 0,
          costUsd: 0.00045,
          resultSubtype: 'success',
          retryFresh: false,
          numTurns: 2,
          toolCalls: [
            {
              name: 'mcp__store__finalize_bill',
              source: 'mcp',
              resultState: 'returned',
              isError: false,
              sdkExecution: { state: 'returned', durationMs: 4 },
            },
          ],
        },
      ],
    });
    await flushLangfuse(1000);

    const payload = payloads.join('\n');
    expect(payload).toContain('telegram.turn');
    expect(payload).toContain('450');
    expect(payload).toContain('get_stock');
    expect(payload).toContain('claude-opus-5');
    expect(payload).toContain('input_cached');
    expect(payload).toContain('finalize_bill');
    expect(payload).toContain('neededConfirmation');
    expect(payload).not.toContain('123456789');
    expect(payload).not.toContain('Rohit');
    expect(payload).not.toContain('₹150');
  });

  it('keeps free-form text omitted and masks named and phone fields when capture is enabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        payloads.push(String(init?.body));
        return new Response(null, { status: 200 });
      }),
    );
    const trace = new LangfuseTurn(env('true'), 987654321n);
    trace.recordTool({
      callId: 'tool-id',
      toolName: 'lookup_customer',
      durationMs: 4,
      startedAtMs: Date.now(),
      endedAtMs: Date.now() + 4,
      outcome: 'returned',
      refusalCode: null,
      errorClass: null,
      input: { customer_name: 'Sita', phone: '9876543210', note: 'Call Sita about ₹250' },
      result: { balance: '₹250' },
      neededConfirmation: false,
    });
    trace.finish({ outcome: 'ok', costMicroUsd: 0, input: 'Sita owes ₹250', attempts: [] });
    await flushLangfuse(1000);

    const payload = payloads.join('\n');
    expect(payload).not.toContain('Sita');
    expect(payload).not.toContain('9876543210');
    expect(payload).not.toContain('₹250');
    expect(payload).toContain('[name]');
    expect(payload).toContain('[phone]');
    expect(payload).toContain('[amount]');
    expect(payload).toContain('free-form content omitted');
  });

  it('does not wait for a slow exporter to finish a turn', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    );
    const trace = new LangfuseTurn(env(), 123n);
    const started = performance.now();
    trace.finish({ outcome: 'ok', costMicroUsd: 0 });
    expect(performance.now() - started).toBeLessThan(50);
  });
});
