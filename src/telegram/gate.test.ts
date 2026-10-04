import { describe, expect, it } from 'vitest';
import { decideAccess, isStartCommand } from './gate.js';

describe('isStartCommand', () => {
  it('recognises /start with or without an argument or bot suffix', () => {
    expect(isStartCommand('/start')).toBe(true);
    expect(isStartCommand('/start abc123')).toBe(true);
    expect(isStartCommand('/start@divagentBot abc123')).toBe(true);
    expect(isStartCommand('  /start  ')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isStartCommand(undefined)).toBe(false);
    expect(isStartCommand('')).toBe(false);
    expect(isStartCommand('hello')).toBe(false);
    expect(isStartCommand('/reset confirm')).toBe(false);
    expect(isStartCommand('please /start')).toBe(false);
    expect(isStartCommand('/starting')).toBe(false);
  });
});

describe('decideAccess', () => {
  it('allows anyone who owns a store', () => {
    expect(decideAccess({ hasStore: true, text: 'how much sugar?' })).toBe('allow');
    expect(decideAccess({ hasStore: true, text: undefined })).toBe('allow');
  });

  it('lets a stranger send only /start', () => {
    expect(decideAccess({ hasStore: false, text: '/start code' })).toBe('allow');
    expect(decideAccess({ hasStore: false, text: 'how much sugar?' })).toBe('deny');
    expect(decideAccess({ hasStore: false, text: '/reset confirm' })).toBe('deny');
    expect(decideAccess({ hasStore: false, text: undefined })).toBe('deny'); // voice, photo, sticker
  });
});
