import { describe, expect, it } from 'vitest';
import { IdempotencyIssuer, newToolContext, requireContext, toolContext } from './context.js';

describe('requireContext', () => {
  it('throws outside a run', () => {
    expect(() => requireContext()).toThrow(/outside a request context/);
  });

  it('returns the ambient context inside a run', () => {
    const ctx = newToolContext(7n, 1n);
    toolContext.run(ctx, () => {
      expect(requireContext().storeId).toBe(7n);
    });
  });

  it('does not leak context between sibling runs', () => {
    const a = newToolContext(1n, 1n);
    const b = newToolContext(2n, 2n);

    toolContext.run(a, () => expect(requireContext().storeId).toBe(1n));
    toolContext.run(b, () => expect(requireContext().storeId).toBe(2n));
    expect(() => requireContext()).toThrow();
  });

  it('survives an await boundary', async () => {
    const ctx = newToolContext(42n, 1n);
    await toolContext.run(ctx, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(requireContext().storeId).toBe(42n);
    });
  });
});

describe('IdempotencyIssuer', () => {
  it('gives identical calls distinct ordinals', () => {
    const issuer = new IdempotencyIssuer(42n);
    const first = issuer.next('add_bill_item', { sku: 'maggi', qty: 2 });
    const second = issuer.next('add_bill_item', { sku: 'maggi', qty: 2 });

    expect(first).not.toBe(second);
    expect(first.endsWith(':1')).toBe(true);
    expect(second.endsWith(':2')).toBe(true);
  });

  it('is stable across key order in args', () => {
    const one = new IdempotencyIssuer(42n).next('t', { a: 1, b: 2 });
    const two = new IdempotencyIssuer(42n).next('t', { b: 2, a: 1 });
    expect(one).toBe(two);
  });

  it('treats an explicit undefined the same as an omitted key', () => {
    const one = new IdempotencyIssuer(42n).next('t', { a: 1, b: undefined });
    const two = new IdempotencyIssuer(42n).next('t', { a: 1 });
    expect(one).toBe(two);
  });

  it('separates different tools and different args', () => {
    const issuer = new IdempotencyIssuer(42n);
    expect(issuer.next('a', {})).not.toBe(issuer.next('b', {}));
    expect(issuer.next('a', { q: 1 })).not.toBe(issuer.next('a', { q: 2 }));
  });

  it('separates different updates', () => {
    const one = new IdempotencyIssuer(1n).next('t', { q: 1 });
    const two = new IdempotencyIssuer(2n).next('t', { q: 1 });
    expect(one).not.toBe(two);
  });

  it('replays an identical call sequence to identical keys', () => {
    // Two issuers for the same update_id, given the same calls in the same order, must produce
    // the same keys — that is what makes a reprocessed turn return stored results rather than
    // re-applying them.
    const first = new IdempotencyIssuer(42n);
    const second = new IdempotencyIssuer(42n);

    const runOne = [first.next('t', { q: 1 }), first.next('t', { q: 1 })];
    const runTwo = [second.next('t', { q: 1 }), second.next('t', { q: 1 })];

    expect(runOne).toEqual(runTwo);
  });
});
