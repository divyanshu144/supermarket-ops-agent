import { describe, expect, it, vi } from 'vitest';
import { recordTurnCost } from './turn-accounting.js';

describe('turn cost reconciliation', () => {
  it('writes the same integer micro-USD amount to usage and the trace', async () => {
    const writer = vi.fn(async () => {});
    const traceCost = vi.fn();
    const cost = await recordTurnCost(12n, 0.1234567, { cacheHits: 1 }, traceCost, writer);
    expect(cost).toBe(123457);
    expect(writer).toHaveBeenCalledWith(12n, 123457, { cacheHits: 1 });
    expect(traceCost).toHaveBeenCalledWith(123457);
  });

  it('records the trace cost even if the usage database write fails', async () => {
    const writer = vi.fn(async () => {
      throw new Error('db unavailable');
    });
    const traceCost = vi.fn();
    await expect(recordTurnCost(12n, 0.25, {}, traceCost, writer)).rejects.toThrow(
      'db unavailable',
    );
    expect(traceCost).toHaveBeenCalledWith(250000);
  });

  it('includes prepaid voice transcription spend in the trace while adding only model cost again', async () => {
    const writer = vi.fn(async () => {});
    const traceCost = vi.fn();
    const cost = await recordTurnCost(12n, 0.25, {}, traceCost, writer, 500);
    expect(cost).toBe(250500);
    expect(writer).toHaveBeenCalledWith(12n, 250000, {});
    expect(traceCost).toHaveBeenCalledWith(250500);
  });
});
