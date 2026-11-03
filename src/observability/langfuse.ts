import { randomBytes, createHmac } from 'node:crypto';
import type { Env } from '../config/env.js';
import { redact } from '../shared/redact.js';
import { CONFIRM_TOOLS } from '../security/tools.js';

type SpanKind = 1 | 3;
interface SpanRecord {
  name: string;
  spanId: string;
  parentSpanId?: string;
  kind: SpanKind;
  startNs: string;
  endNs: string;
  attributes: Record<string, string | number | boolean>;
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function attr(key: string, value: string | number | boolean) {
  if (typeof value === 'string') return { key, value: { stringValue: value } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  return { key, value: { intValue: String(Math.round(value)) } };
}

function toOtlpSpan(traceId: string, span: SpanRecord) {
  return {
    traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: span.startNs,
    endTimeUnixNano: span.endNs,
    attributes: Object.entries(span.attributes).map(([key, value]) => attr(key, value)),
    status: { code: 1 },
  };
}

function ns(ms: number): string {
  return String(Math.round(ms * 1_000_000));
}

function sensitiveText(value: unknown): unknown {
  const scrub = (text: string) =>
    text
      .replace(/\b(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g, '[phone]')
      .replace(/(?:₹|\bINR\s*)\s?\d[\d,]*(?:\.\d{1,2})?/gi, '[amount]');
  const visit = (input: unknown, key = ''): unknown => {
    if (/(?:customer|person|owner|name)/i.test(key)) return '[name]';
    if (/phone|mobile/i.test(key)) return '[phone]';
    if (/(?:amount|balance|total|price|payment)/i.test(key)) return '[amount]';
    if (typeof input === 'string') {
      // Free-form messages can contain names with no reliable general-purpose name detector.
      // Keep them out even when content capture is enabled; structured safe fields still pass.
      if (/(?:message|text|input|output|reply|note|query|transcript)/i.test(key)) {
        return '[free-form content omitted]';
      }
      return scrub(input);
    }
    if (Array.isArray(input)) return input.map((item) => visit(item));
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input).map(([childKey, child]) => [childKey, visit(child, childKey)]),
      );
    }
    return input;
  };
  return visit(redact(value));
}

export interface TraceToolEvent {
  callId: string;
  toolName: string;
  durationMs: number;
  startedAtMs: number;
  endedAtMs: number;
  outcome: 'returned' | 'threw';
  refusalCode: string | null;
  errorClass: string | null;
  input?: unknown;
  result?: unknown;
  neededConfirmation: boolean;
}

export class LangfuseTurn {
  readonly traceId = hex(16);
  readonly #rootSpanId = hex(8);
  readonly #started = performance.now();
  readonly #startedMs = Date.now();
  readonly #spans: SpanRecord[] = [];
  readonly #tools: TraceToolEvent[] = [];
  readonly #env: Env;
  readonly #pseudonymousStore: string;
  #cache: Record<string, string | number | boolean> = {};
  #tier: Record<string, string | number | boolean> = {};
  #costMicroUsd = 0;
  #ended = false;

  constructor(env: Env, storeId: bigint) {
    this.#env = env;
    const key = env.LANGFUSE_SECRET_KEY ?? '';
    this.#pseudonymousStore = createHmac('sha256', key).update(String(storeId)).digest('hex');
  }

  recordTool(event: TraceToolEvent): void {
    this.#tools.push(event);
  }

  recordCache(event: Record<string, unknown>): void {
    this.#cache = Object.fromEntries(
      Object.entries(event).filter(([, value]) =>
        ['string', 'number', 'boolean'].includes(typeof value),
      ),
    ) as Record<string, string | number | boolean>;
  }

  recordTier(event: Record<string, string | number | boolean>): void {
    this.#tier = event;
  }

  recordCost(costMicroUsd: number): void {
    this.#costMicroUsd = costMicroUsd;
  }

  get costMicroUsd(): number {
    return this.#costMicroUsd;
  }

  usageMetrics() {
    const cacheStatus = this.#cache.status;
    const cacheReason = this.#cache.reason;
    const cacheLookup = cacheStatus === 'hit' || cacheStatus === 'miss';
    const countCache =
      cacheLookup &&
      cacheReason !== 'disabled' &&
      cacheReason !== 'ineligible' &&
      cacheReason !== 'conversation';
    return {
      toolCalls: this.#tools.length,
      toolErrors: this.#tools.filter((tool) => tool.outcome === 'threw').length,
      cacheLookups: countCache ? 1 : 0,
      cacheHits: countCache && cacheStatus === 'hit' ? 1 : 0,
    };
  }

  finish(args: {
    outcome: string;
    costMicroUsd?: number;
    attempts?: Array<{
      startedAtMs?: number;
      endedAtMs?: number;
      modelIds: string[];
      inputTokens: number | null;
      outputTokens: number | null;
      cacheReadInputTokens: number | null;
      cacheCreationInputTokens: number | null;
      costUsd: number | null;
      resultSubtype: string | null;
      retryFresh: boolean;
      numTurns: number | null;
      toolCalls: Array<{
        name: string;
        source: 'mcp' | 'builtin';
        resultState: 'pending' | 'returned' | 'failed';
        isError: boolean | null;
        sdkExecution: { state: 'returned' | 'failed'; durationMs: number | null } | null;
      }>;
    }>;
    input?: string;
    output?: string;
  }): void {
    if (this.#ended) return;
    this.#ended = true;
    const endedMs = Date.now();
    const capture = this.#env.LANGFUSE_CAPTURE_CONTENT === 'true';
    const rootAttributes: Record<string, string | number | boolean> = {
      'langfuse.trace.name': 'telegram.turn',
      'langfuse.user.id': this.#pseudonymousStore,
      'superops.outcome': args.outcome,
      'superops.latency_ms': Math.max(0, performance.now() - this.#started),
      'superops.cost_micro_usd': args.costMicroUsd ?? this.#costMicroUsd,
      'superops.tool_count':
        args.attempts?.reduce((sum, attempt) => sum + attempt.toolCalls.length, 0) ??
        this.#tools.length,
      'superops.tool_calls': JSON.stringify(
        args.attempts?.flatMap((attempt) =>
          attempt.toolCalls.map((call) => {
            const toolName = call.name.replace(/^mcp__store__/, '');
            return {
              name: call.name,
              source: call.source,
              outcome: call.resultState,
              isError: call.isError,
              durationMs: call.sdkExecution?.durationMs ?? null,
              neededConfirmation: call.source === 'mcp' && CONFIRM_TOOLS.has(toolName),
            };
          }),
        ) ?? [],
      ),
      'superops.cache': JSON.stringify(this.#cache),
      'superops.tier': JSON.stringify(this.#tier),
      'superops.attempt_count': args.attempts?.length ?? 0,
      'superops.retry_count': args.attempts?.filter((attempt) => attempt.retryFresh).length ?? 0,
    };
    if (capture) {
      rootAttributes['langfuse.trace.input'] = JSON.stringify(
        sensitiveText({ message: args.input }),
      );
      rootAttributes['langfuse.trace.output'] = JSON.stringify(
        sensitiveText({ reply: args.output }),
      );
    }

    const rootEnd = ns(endedMs);
    const rootStart = ns(this.#startedMs);
    this.#spans.push({
      name: 'telegram.turn',
      spanId: this.#rootSpanId,
      kind: 1,
      startNs: rootStart,
      endNs: rootEnd,
      attributes: rootAttributes,
    });
    for (let index = 0; index < (args.attempts?.length ?? 0); index++) {
      const attempt = args.attempts![index]!;
      const attemptStartNs = ns(attempt.startedAtMs ?? this.#startedMs);
      const attemptEndNs = ns(attempt.endedAtMs ?? endedMs);
      this.#spans.push({
        name: `agent.model_attempt.${index + 1}`,
        spanId: hex(8),
        parentSpanId: this.#rootSpanId,
        kind: 3,
        startNs: attemptStartNs,
        endNs: attemptEndNs,
        attributes: {
          'langfuse.observation.type': 'generation',
          'langfuse.observation.model': attempt.modelIds.at(-1) ?? 'unknown',
          'langfuse.observation.usage_details': JSON.stringify({
            input: attempt.inputTokens,
            output: attempt.outputTokens,
            input_cached: attempt.cacheReadInputTokens,
            input_cache_creation: attempt.cacheCreationInputTokens,
          }),
          'langfuse.observation.cost_details': JSON.stringify({ usd: attempt.costUsd }),
          'superops.result_subtype': attempt.resultSubtype ?? 'unknown',
          'superops.retry_fresh': attempt.retryFresh,
          'superops.num_turns': attempt.numTurns ?? 0,
          'superops.tool_calls': JSON.stringify(
            attempt.toolCalls.map((call) => ({
              name: call.name,
              source: call.source,
              outcome: call.resultState,
              error: call.isError,
              durationMs: call.sdkExecution?.durationMs ?? null,
            })),
          ),
        },
      });
    }
    for (const tool of this.#tools) {
      const toolAttrs: Record<string, string | number | boolean> = {
        'langfuse.observation.type': 'span',
        'superops.tool.name': tool.toolName,
        'superops.tool.outcome': tool.outcome,
        'superops.tool.duration_ms': tool.durationMs,
        'superops.tool.refusal_code': tool.refusalCode ?? '',
        'superops.tool.error_class': tool.errorClass ?? '',
        'superops.tool.needed_confirmation': tool.neededConfirmation,
      };
      if (capture) {
        toolAttrs['langfuse.observation.input'] = JSON.stringify(sensitiveText(tool.input));
        toolAttrs['langfuse.observation.output'] = JSON.stringify(sensitiveText(tool.result));
      }
      this.#spans.push({
        name: `tool.${tool.toolName}`,
        spanId: hex(8),
        parentSpanId: this.#rootSpanId,
        kind: 1,
        startNs: ns(tool.startedAtMs),
        endNs: ns(tool.endedAtMs),
        attributes: toolAttrs,
      });
    }
    const event = {
      resourceSpans: [
        {
          resource: { attributes: [attr('service.name', 'superops-telegram-agent')] },
          scopeSpans: [
            {
              scope: { name: 'superops', version: '1.0.0' },
              spans: this.#spans.map((span) => toOtlpSpan(this.traceId, span)),
            },
          ],
        },
      ],
    };
    queueExport(this.#env, event);
  }
}

const MAX_QUEUE = 128;
const queue: Array<{ env: Env; body: unknown }> = [];
let sending = false;
let timer: NodeJS.Timeout | undefined;

function configured(env: Env): boolean {
  return Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY && env.LANGFUSE_BASE_URL);
}

function queueExport(env: Env, body: unknown): void {
  if (!configured(env)) return;
  if (queue.length >= MAX_QUEUE) {
    console.error(JSON.stringify({ scope: 'langfuse', event: 'queue_full' }));
    return;
  }
  queue.push({ env, body });
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void drainOne(), 0);
  timer.unref();
}

async function drainOne(deadlineMs = 2500): Promise<void> {
  if (sending) return;
  const item = queue.shift();
  if (!item) return;
  sending = true;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), deadlineMs);
  try {
    const endpoint = `${item.env.LANGFUSE_BASE_URL!.replace(/\/$/, '')}/api/public/otel/v1/traces`;
    const auth = Buffer.from(
      `${item.env.LANGFUSE_PUBLIC_KEY}:${item.env.LANGFUSE_SECRET_KEY}`,
    ).toString('base64');
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Basic ${auth}`,
        'content-type': 'application/json',
        'x-langfuse-ingestion-version': '4',
      },
      body: JSON.stringify(item.body),
      signal: controller.signal,
    });
    if (!response.ok)
      console.error(
        JSON.stringify({ scope: 'langfuse', event: 'export_failed', status: response.status }),
      );
  } catch (error) {
    console.error(
      JSON.stringify({ scope: 'langfuse', event: 'export_failed', error: redact(error) }),
    );
  } finally {
    clearTimeout(deadline);
    sending = false;
    if (queue.length) void drainOne();
  }
}

/** Best-effort bounded shutdown drain; never call from a Telegram reply handler. */
export async function flushLangfuse(timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while ((queue.length || sending) && Date.now() < end) {
    if (!sending) void drainOne(Math.max(1, end - Date.now()));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
