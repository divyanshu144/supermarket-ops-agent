import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getStoreOwnerId } = vi.hoisted(() => ({ getStoreOwnerId: vi.fn() }));
vi.mock('../repositories/access.js', () => ({ getStoreOwnerId }));

import { decideAccess, accessGate } from './gate.js';

describe('decideAccess', () => {
  it('allows anyone who owns a store', () => {
    expect(decideAccess({ hasStore: true, isStartCommand: false })).toBe('allow');
  });

  it('lets a stranger send only /start', () => {
    expect(decideAccess({ hasStore: false, isStartCommand: true })).toBe('allow');
    expect(decideAccess({ hasStore: false, isStartCommand: false })).toBe('deny');
  });
});

describe('accessGate owner binding', () => {
  beforeEach(() => getStoreOwnerId.mockReset());

  it('does not pass a private update from a different user to handlers', async () => {
    getStoreOwnerId.mockResolvedValue(123n);
    const next = vi.fn();
    const reply = vi.fn();
    const ctx = {
      chat: { id: 456, type: 'private' },
      from: { id: 789 },
      message: { text: 'change prices' },
      callbackQuery: undefined,
      hasCommand: () => false,
      reply,
    };

    await accessGate(ctx as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
  });

  it('answers a denied callback so Telegram clears its spinner', async () => {
    getStoreOwnerId.mockResolvedValue(123n);
    const next = vi.fn();
    const answerCallbackQuery = vi.fn();
    const ctx = {
      chat: { id: 456, type: 'private' },
      from: { id: 789 },
      message: undefined,
      callbackQuery: { data: 'rai:c:abcdefghijkl' },
      hasCommand: () => false,
      answerCallbackQuery,
    };

    await accessGate(ctx as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith({
      text: expect.any(String),
      show_alert: true,
    });
  });
});
