import { describe, expect, it } from 'vitest';
import { CATALOGUE } from './catalogue.js';

describe('seed catalogue', () => {
  // The brief's own example is "add atta -> which one, Aashirvaad 5kg or loose?". That
  // clarifying question can only happen if the seeded shop actually stocks two attas.
  it('stocks two products matching "atta" so the ambiguity path is reachable', () => {
    const matches = CATALOGUE.filter((p) => /atta/i.test(p.name) || /atta/i.test(p.brand ?? ''));
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('offers a loose atta alongside the branded pack', () => {
    const loose = CATALOGUE.find((p) => /atta/i.test(p.name) && p.isLoose === true);
    expect(loose).toBeDefined();
    // Loose, unbranded staples are GST-exempt; the branded pack is 5%.
    expect(loose!.gstRateBps).toBe(0);
    expect(loose!.unit).toBe('kg');
  });
});
