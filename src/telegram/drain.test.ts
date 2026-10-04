import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'grammy';
import { beginDrain, drainGate, inFlightCount, isDraining, resetDrainForTests } from './drain.js';

const ctx = {} as Context;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const NEVER = Symbol('never resolved');

/** A handler whose completion the test controls. */
function controllable() {
  let release!: () => void;
  const next = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  return { next, release: () => release() };
}

afterEach(() => resetDrainForTests());

describe('drainGate', () => {
  it('passes updates through and tracks them while not draining', async () => {
    const h = controllable();
    const done = drainGate(ctx, h.next);
    expect(inFlightCount()).toBe(1);
    h.release();
    await done;
    expect(inFlightCount()).toBe(0);
    expect(h.next).toHaveBeenCalledTimes(1);
  });

  it('releases the in-flight count even when the handler throws', async () => {
    await expect(drainGate(ctx, async () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(inFlightCount()).toBe(0);
  });

  it('never handles and never returns for an update that arrives while draining', async () => {
    await beginDrain(10);
    expect(isDraining()).toBe(true);
    const next = vi.fn(async () => {});
    // Returning would let grammY's loop move on and confirm the update by polling again.
    const outcome = await Promise.race([drainGate(ctx, next), sleep(30).then(() => NEVER)]);
    expect(outcome).toBe(NEVER);
    expect(next).not.toHaveBeenCalled();
    expect(inFlightCount()).toBe(0);
  });
});

describe('beginDrain', () => {
  it('resolves drained at once when nothing is in flight', async () => {
    expect(await beginDrain(1000)).toBe('drained');
  });

  it('waits for the in-flight turn to finish', async () => {
    const h = controllable();
    const handling = drainGate(ctx, h.next);
    let settled: string | undefined;
    const drain = beginDrain(1000).then((r) => (settled = r));

    await sleep(20);
    expect(settled).toBeUndefined(); // still waiting

    h.release();
    await handling;
    await drain;
    expect(settled).toBe('drained');
  });

  it('gives up after the grace period if the turn never finishes', async () => {
    const h = controllable();
    void drainGate(ctx, h.next);
    expect(await beginDrain(30)).toBe('timeout');
    h.release();
  });
});
