import type { Context, NextFunction } from 'grammy';

/**
 * Process-lifecycle state for graceful shutdown.
 *
 * grammY's long-polling loop handles one update at a time and confirms a batch only when it
 * fetches the next one. Shutdown must therefore (1) stop starting work, (2) let the in-flight
 * turn finish, and (3) exit WITHOUT `bot.stop()` — stop() calls getUpdates with
 * `offset = lastTriedUpdateId + 1`, which confirms the update currently being handled, so a
 * turn cut off by exit would be lost instead of redelivered.
 */
let draining = false;
let inFlight = 0;
let waiters: Array<() => void> = [];

export function isDraining(): boolean {
  return draining;
}

export function inFlightCount(): number {
  return inFlight;
}

/**
 * First middleware. While draining it neither handles the update nor returns: returning would let
 * grammY's loop carry on and issue another getUpdates, confirming the update we declined to
 * handle. Hanging keeps it unconfirmed, so Telegram redelivers it to the next process.
 */
export async function drainGate(_ctx: Context, next: NextFunction): Promise<void> {
  if (draining) return new Promise<void>(() => {});
  inFlight++;
  try {
    await next();
  } finally {
    inFlight--;
    if (inFlight === 0) for (const wake of waiters.splice(0)) wake();
  }
}

/** Stops accepting updates and resolves when the in-flight one finishes, or after the grace period. */
export function beginDrain(graceMs: number): Promise<'drained' | 'timeout'> {
  draining = true;
  if (inFlight === 0) return Promise.resolve('drained');
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve('drained');
    };
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== done);
      resolve('timeout');
    }, graceMs);
    waiters.push(done);
  });
}

export function resetDrainForTests(): void {
  draining = false;
  inFlight = 0;
  waiters = [];
}
