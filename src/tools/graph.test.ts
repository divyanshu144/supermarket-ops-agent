import { describe, expect, it } from 'vitest';
import { GRAPH_TOOL_NAMES, validateGraphQuery } from './graph.js';

describe('graph tool input contract', () => {
  it('limits product query, date range and result size', () => {
    expect(validateGraphQuery({ product_query: '  milk  ', limit: 20 }).status).toBe('valid');
    expect(validateGraphQuery({ product_query: 'milk', limit: 21 }).status).toBe('invalid');
    expect(
      validateGraphQuery({ product_query: 'milk', from: '2026-01-01', to: '2026-04-02' }).status,
    ).toBe('invalid');
    expect(validateGraphQuery({ product_query: 'milk', from: 'not-a-date' }).status).toBe(
      'invalid',
    );
  });

  it('registers only the two read-only graph tools', () => {
    expect(GRAPH_TOOL_NAMES).toEqual(['explain_stock_change', 'frequently_bought_with']);
  });
});
