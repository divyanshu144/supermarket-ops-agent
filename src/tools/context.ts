import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

/**
 * Deterministic JSON. Object keys are sorted so that argument order never changes the hash,
 * and `undefined` members are dropped so an explicitly-absent optional matches an omitted one.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);

  return `{${entries.join(',')}}`;
}

/**
 * Issues idempotency keys of the form `<updateId>:<tool>:<argsHash>:<ordinal>`.
 *
 * The ordinal is what makes two legitimately identical calls in one turn — a bill with two
 * identical lines, say — map to two distinct keys. Without it the second call would collide
 * with the first, return its stored result, and silently become a no-op.
 *
 * Keys are derived here rather than accepted from the model, for the same reason `storeId` is:
 * anything the model can supply, a prompt injection can also supply.
 */
export class IdempotencyIssuer {
  readonly #counts = new Map<string, number>();

  constructor(private readonly updateId: bigint) {}

  next(toolName: string, args: unknown): string {
    const hash = createHash('sha256').update(stableStringify(args)).digest('hex').slice(0, 16);
    const base = `${this.updateId}:${toolName}:${hash}`;
    const ordinal = (this.#counts.get(base) ?? 0) + 1;
    this.#counts.set(base, ordinal);
    return `${base}:${ordinal}`;
  }
}

/** A file produced during a turn, awaiting delivery by the transport. */
export interface ProducedArtifact {
  artifactId: string;
  path: string;
  filename: string;
  mime: string;
}

export interface ToolContext {
  /**
   * Injected from the verified Telegram chat. NEVER a tool parameter — the model has no
   * argument with which to address another tenant, so no prompt can talk it into one.
   */
  storeId: bigint;
  updateId: bigint;
  idempotency: IdempotencyIssuer;
  /**
   * Files generated this turn. Tools push here; the adapter drains it after the reply.
   * Keeping delivery out of the tools is what lets an artifact be generated in a test with
   * no bot running at all.
   */
  artifacts: ProducedArtifact[];
}

export const toolContext = new AsyncLocalStorage<ToolContext>();

export function requireContext(): ToolContext {
  const ctx = toolContext.getStore();
  if (!ctx) throw new Error('Tool invoked outside a request context — refusing to execute.');
  return ctx;
}

export function recordArtifact(artifact: ProducedArtifact): void {
  requireContext().artifacts.push(artifact);
}

/**
 * Builds a fresh per-turn context. Use this rather than an object literal so a new field
 * cannot be silently forgotten at one of the call sites.
 */
export function newToolContext(storeId: bigint, updateId: bigint): ToolContext {
  return {
    storeId,
    updateId,
    idempotency: new IdempotencyIssuer(updateId),
    artifacts: [],
  };
}
