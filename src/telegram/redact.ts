/**
 * Strips credentials out of anything bound for a log.
 *
 * This exists because grammY's `BotError` holds the whole context: `error.ctx.api.token` is the
 * bot token, and Node's unhandled-rejection printer walks that chain. Logging an error
 * unredacted puts full control of the bot into log retention.
 */

const SECRET_KEY = /^(token|api_?key|authorization|secret|password)$/i;

const SECRET_PATTERNS: RegExp[] = [
  // Telegram bot token: numeric id, colon, then a long opaque string. Matches it standalone
  // and inside a URL such as https://api.telegram.org/file/bot<TOKEN>/...
  /\d{6,}:[A-Za-z0-9_-]{30,}/g,
  // Anthropic and OpenAI keys.
  /sk-[A-Za-z0-9-]{8,}/g,
];

const REDACTED = '[redacted]';
const MAX_DEPTH = 8;

function scrubString(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';

  // grammY contexts reference themselves; without this the walk never terminates.
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      stack: value.stack ? scrubString(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : redact(item, depth + 1, seen);
  }
  return out;
}
