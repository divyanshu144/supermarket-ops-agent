import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().optional(),
  AGENT_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_MESSAGE_TEXT: z.enum(['true', 'false']).optional(),
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
