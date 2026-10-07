import { z } from 'zod';

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const positiveNumber = (fallback: number) => z.coerce.number().positive().default(fallback);

const schema = z
  .object({
    DATABASE_URL: z.string().url(),
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    ANTHROPIC_API_KEY: z.string().min(1),
    OPENAI_API_KEY: z.string().optional(),
    AGENT_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_MESSAGE_TEXT: z.enum(['true', 'false']).optional(),
    PRIVACY_CONTACT: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .trim()
        .max(120)
        .regex(/^(?:@[A-Za-z0-9_]{5,32}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})$/)
        .optional(),
    ),
    APP_DATA_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),

    AGENT_MODEL: z.string().min(1).default('claude-opus-5'),
    // Empty string is treated as unset by agent/limits.ts, so `AGENT_FALLBACK_MODEL=` in a
    // dotenv file does not break boot.
    AGENT_FALLBACK_MODEL: z.string().optional(),
    AGENT_MAX_TURNS: positiveInt(15),
    AGENT_MAX_BUDGET_USD: positiveNumber(0.5),
    // setTimeout fires immediately above 2^31-1 ms; 10 minutes is far past any sane turn.
    AGENT_TURN_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(90_000),
    STORE_DAILY_BUDGET_USD: positiveNumber(5),
    RATE_LIMIT_TURNS: positiveInt(20),
    RATE_LIMIT_WINDOW_S: positiveInt(600),
    SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().max(120_000).default(30_000),
  })
  .refine((e) => !e.AGENT_FALLBACK_MODEL || e.AGENT_FALLBACK_MODEL !== e.AGENT_MODEL, {
    path: ['AGENT_FALLBACK_MODEL'],
    message: 'must differ from AGENT_MODEL (the SDK throws at startup otherwise)',
  });

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${detail}`);
  }
  return parsed.data;
}

/**
 * Message text is logged in development and withheld in production unless explicitly enabled,
 * so a deployed shop does not write customer names to a log aggregator by default.
 */
export function shouldLogMessageText(env: Env): boolean {
  if (env.LOG_MESSAGE_TEXT !== undefined) return env.LOG_MESSAGE_TEXT === 'true';
  return env.NODE_ENV !== 'production';
}
