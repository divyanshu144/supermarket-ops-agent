import { describe, expect, it } from 'vitest';
import { decideAccess } from './gate.js';

describe('decideAccess', () => {
  it('allows anyone who owns a store', () => {
    expect(decideAccess({ hasStore: true, isStartCommand: false })).toBe('allow');
  });

  it('lets a stranger send only /start', () => {
    expect(decideAccess({ hasStore: false, isStartCommand: true })).toBe('allow');
    expect(decideAccess({ hasStore: false, isStartCommand: false })).toBe('deny');
  });
});
