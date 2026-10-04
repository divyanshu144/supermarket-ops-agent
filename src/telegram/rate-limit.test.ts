import { describe, expect, it } from 'vitest';
import { SlidingWindowLimiter } from './rate-limit.js';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('SlidingWindowLimiter', () => {
  it('allows up to the limit and then blocks', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(3, 1000, c.now);
    expect([1, 2, 3, 4].map(() => limiter.tryConsume('chat'))).toEqual([true, true, true, false]);
  });

  it('tracks each key separately', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(1, 1000, c.now);
    expect(limiter.tryConsume('a')).toBe(true);
    expect(limiter.tryConsume('b')).toBe(true);
    expect(limiter.tryConsume('a')).toBe(false);
  });

  it('frees capacity as old hits leave the window', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(2, 1000, c.now);
    limiter.tryConsume('chat');
    limiter.tryConsume('chat');
    c.advance(1001);
    expect(limiter.tryConsume('chat')).toBe(true);
  });

  it('does not count blocked attempts, so a spammer is not locked out for longer', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(2, 1000, c.now);
    limiter.tryConsume('chat'); // t=0
    limiter.tryConsume('chat'); // t=0
    c.advance(500);
    expect(limiter.tryConsume('chat')).toBe(false); // blocked at t=500, must not be recorded
    c.advance(501); // t=1001: the two t=0 hits have expired
    expect(limiter.tryConsume('chat')).toBe(true);
    expect(limiter.tryConsume('chat')).toBe(true);
  });
});
