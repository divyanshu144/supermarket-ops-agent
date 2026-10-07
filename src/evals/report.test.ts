import { describe, expect, it } from 'vitest';
import { summarizeAttempts } from './report.js';

describe('synthetic report summary', () => {
  it('keeps aborted repeats in the all-N denominator and reports flaky scenarios', () => {
    const summary = summarizeAttempts(
      [
        {
          scenarioId: 'a',
          repetition: 1,
          pass: true,
          costMicroUsd: 0,
          turns: 1,
          toolCalls: 1,
          wallMs: 2,
          status: 'complete',
        },
        {
          scenarioId: 'a',
          repetition: 2,
          pass: false,
          costMicroUsd: 0,
          turns: 1,
          toolCalls: 1,
          wallMs: 3,
          status: 'complete',
        },
        {
          scenarioId: 'b',
          repetition: 1,
          pass: true,
          costMicroUsd: null,
          turns: 0,
          toolCalls: 0,
          wallMs: 0,
          status: 'complete',
        },
      ],
      2,
    );
    expect(summary.passAt1).toBe(1);
    expect(summary.allNPassRate).toBe(0);
    expect(summary.flakyScenarios).toEqual(['a']);
    expect(summary.provenance).toBe('synthetic');
  });
});
