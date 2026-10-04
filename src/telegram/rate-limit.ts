import { loadEnv } from '../config/env.js';

/**
 * Per-key sliding-window limiter, in memory.
 *
 * In memory is correct for the deployment this repo targets — one replica, long-polling — and
 * resets on restart. That is a known limit, documented in DEPLOY.md, not an oversight: a second
 * replica would need this state in Postgres, and a second replica already breaks long-polling.
 */
export class SlidingWindowLimiter {
  readonly #hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit and returns true if the key is within its limit. Blocked attempts are not recorded. */
  tryConsume(key: string): boolean {
    const t = this.now();
    const live = (this.#hits.get(key) ?? []).filter((at) => t - at < this.windowMs);
    if (live.length >= this.limit) {
      this.#hits.set(key, live);
      return false;
    }
    live.push(t);
    this.#hits.set(key, live);
    return true;
  }
}

const env = loadEnv();

/** One shared limiter for owner turns, text and voice alike. */
export const turnLimiter = new SlidingWindowLimiter(
  env.RATE_LIMIT_TURNS,
  env.RATE_LIMIT_WINDOW_S * 1000,
);
