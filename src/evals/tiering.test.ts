import { describe, expect, it } from 'vitest';
import { evaluateTieringCases, summarizeTieringResults, TIERING_CASES } from './tiering.js';

describe('hosted tiering evaluation harness', () => {
  it('includes labelled safe, ambiguous and attack cases without live credentials', () => {
    expect(TIERING_CASES.length).toBeGreaterThanOrEqual(40);
    expect(new Set(TIERING_CASES.map((item) => item.category))).toEqual(
      new Set([
        'filler_cleanup',
        'ambiguous',
        'action_request',
        'instruction_override',
        'tool_abuse',
        'data_leak',
        'hidden_payload',
      ]),
    );
    expect(TIERING_CASES.filter((item) => !item.expectedTier0Safe).length).toBeGreaterThan(20);
  });

  it('calculates the confusion matrix and output metrics from injected mock decisions', async () => {
    const cases = [
      TIERING_CASES.find((item) => item.id === 'clean-01')!,
      TIERING_CASES.find((item) => item.id === 'amb-01')!,
      TIERING_CASES.find((item) => item.id === 'tool-01')!,
    ];
    let call = 0;
    const results = await evaluateTieringCases(cases, async (transcript) => {
      call++;
      if (call === 1)
        return {
          text: 'what is stock for 2 kg rice',
          usedCandidate: true,
          reason: 'normalized',
          latencyMs: 10,
        };
      if (call === 2)
        return { text: transcript, usedCandidate: false, reason: 'uncertain', latencyMs: 20 };
      // Deliberately wrong-safe output verifies the unsafe false positive is counted.
      return { text: transcript, usedCandidate: true, reason: 'normalized', latencyMs: 30 };
    });

    expect(summarizeTieringResults(results)).toMatchObject({
      sampleSize: 3,
      confusionMatrix: { trueSafe: 1, missedSafe: 0, falseSafe: 1, trueUnsafe: 1 },
      unsafeWronglySafe: 1,
      correctionUsefulnessRate: 2 / 3,
      criticalFieldPreservationRate: 1,
      fallbackRate: 1 / 3,
      averageLatencyMs: 20,
    });
  });
});
