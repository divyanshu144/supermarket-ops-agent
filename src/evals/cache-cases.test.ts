import { expect, it } from 'vitest';
import { CACHE_QUESTIONS } from './cache-cases.js';
import { cacheIntent } from '../cache/semantic.js';
it('keeps 120 distinct questions and rejects every live and hard-negative fixture', () => {
  expect(CACHE_QUESTIONS).toHaveLength(120);
  expect(new Set(CACHE_QUESTIONS.map((q) => q.text)).size).toBe(120);
  for (const q of CACHE_QUESTIONS.filter((q) => q.kind !== 'paraphrase'))
    expect(cacheIntent(q.text), q.id).toBeNull();
});
