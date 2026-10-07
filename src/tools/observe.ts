import { randomUUID } from 'node:crypto';
import { redact } from '../shared/redact.js';
import { requireContext } from './context.js';

export interface ToolObservation {
  callId: string;
  ordinal: number;
  toolName: string;
  /** The SDK invokes handlers only after validating the registered Zod input schema. */
  input: unknown;
  startOrder: number;
  endOrder: number;
  durationMs: number;
  outcome: 'returned' | 'threw';
  result?: unknown;
  refusalCode: string | null;
  errorClass: string | null;
}

export type ToolObserver = (event: ToolObservation) => void;

let order = 0;
let callOrdinal = 0;

function refusalCode(value: unknown): string | null {
  if (typeof value === 'string') {
    try {
      return refusalCode(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const code = refusalCode(entry);
      if (code) return code;
    }
    return null;
  }
  const object = value as Record<string, unknown>;
  for (const key of ['refusal_code', 'refusalCode']) {
    if (typeof object[key] === 'string') return object[key] as string;
  }
  for (const entry of Object.values(object)) {
    const code = refusalCode(entry);
    if (code) return code;
  }
  return null;
}

/**
 * Adds test/eval observation to registered MCP handlers. No event is emitted unless the
 * current request context explicitly carries an observer. The original result and thrown
 * value always pass through unchanged, even if the observer itself fails.
 */
interface HandlerDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (input: unknown, extra: unknown) => Promise<unknown>;
  [key: string]: unknown;
}

export function observeRegisteredTools<Tools extends readonly unknown[]>(
  tools: Tools,
): Array<Tools[number]> {
  return tools.map((registered) => {
    const definition = registered as HandlerDefinition;
    return {
      ...definition,
      handler: async (input: unknown, extra: unknown) => {
        const observer = (() => {
          try {
            return requireContext().observer;
          } catch {
            return undefined;
          }
        })();
        if (!observer) return definition.handler(input, extra);

        const callId = randomUUID();
        const ordinal = ++callOrdinal;
        const startOrder = ++order;
        const started = performance.now();
        let event: ToolObservation;
        try {
          const result = await definition.handler(input, extra);
          event = {
            callId,
            ordinal,
            toolName: definition.name,
            input: redact(input),
            startOrder,
            endOrder: ++order,
            durationMs: Math.max(0, performance.now() - started),
            outcome: 'returned',
            result: redact(result),
            refusalCode: refusalCode(result),
            errorClass: null,
          };
          try {
            observer(event);
          } catch {
            // Observation is diagnostic only. It must not affect a business result.
          }
          return result;
        } catch (error) {
          event = {
            callId,
            ordinal,
            toolName: definition.name,
            input: redact(input),
            startOrder,
            endOrder: ++order,
            durationMs: Math.max(0, performance.now() - started),
            outcome: 'threw',
            refusalCode: null,
            errorClass: error instanceof Error ? error.name : typeof error,
          };
          try {
            observer(event);
          } catch {
            // Preserve the handler's exact thrown value.
          }
          throw error;
        }
      },
    } as Tools[number];
  });
}
