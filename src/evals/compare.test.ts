import { describe, expect, it } from 'vitest';
import { compareWithBaseline } from './compare.js';

describe('baseline comparison gate', () => {
  it('refuses before reading or accepting any baseline while cost semantics are unverified', async () => {
    await expect(compareWithBaseline('/missing-report', '/missing-baseline')).rejects.toThrow(
      'cost semantics are unverified',
    );
  });
});
