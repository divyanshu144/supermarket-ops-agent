import { describe, expect, it, vi } from 'vitest';
import { newToolContext, toolContext } from './context.js';
import { observeRegisteredTools, type ToolObservation } from './observe.js';

function definition(handler: (input: unknown) => Promise<unknown>) {
  return {
    name: 'example',
    description: 'test handler',
    inputSchema: {},
    handler: async (input: unknown, _extra: unknown) => handler(input),
  };
}

describe('registered tool observation', () => {
  it('keeps no-sink calls unchanged and emits nothing', async () => {
    const result = { content: [{ type: 'text', text: 'same result' }] };
    const handler = vi.fn(async () => result);
    const wrapped = observeRegisteredTools([definition(handler)])[0]!;
    const actual = await wrapped.handler({ query: 'milk' }, {});
    expect(actual).toBe(result);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('observes only the context that explicitly supplies the sink', async () => {
    const firstEvents: ToolObservation[] = [];
    const secondEvents: ToolObservation[] = [];
    const wrapped = observeRegisteredTools([definition(async () => 'ok')])[0]!;
    await Promise.all([
      toolContext.run(
        newToolContext(1n, 1n, (event) => firstEvents.push(event)),
        () => wrapped.handler({ query: 'one' }, {}),
      ),
      toolContext.run(
        newToolContext(2n, 2n, (event) => secondEvents.push(event)),
        () => wrapped.handler({ query: 'two' }, {}),
      ),
    ]);
    expect(firstEvents).toHaveLength(1);
    expect(secondEvents).toHaveLength(1);
    expect(firstEvents[0]?.input).toEqual({ query: 'one' });
    expect(secondEvents[0]?.input).toEqual({ query: 'two' });
  });

  it('keeps identical calls distinct and records validated input, result and ordered duration', async () => {
    const events: ToolObservation[] = [];
    const result = { content: [{ type: 'text', text: '{"refusal_code":"oversell"}' }] };
    const wrapped = observeRegisteredTools([definition(async () => result)])[0]!;
    const ctx = newToolContext(1n, 9n, (event) => events.push(event));
    await toolContext.run(ctx, async () => {
      await wrapped.handler({ query: 'rice' }, {});
      await wrapped.handler({ query: 'rice' }, {});
    });
    expect(events).toHaveLength(2);
    expect(events[0]?.callId).not.toBe(events[1]?.callId);
    expect(events[0]?.ordinal).not.toBe(events[1]?.ordinal);
    expect(events[0]?.toolName).toBe('example');
    expect(events[0]?.input).toEqual({ query: 'rice' });
    expect(events[0]?.result).toEqual({
      content: [{ type: 'text', text: '{"refusal_code":"oversell"}' }],
    });
    expect(events[0]?.refusalCode).toBe('oversell');
    expect(events[0]?.outcome).toBe('returned');
    expect(events[0]!.startOrder).toBeLessThan(events[0]!.endOrder);
    expect(events[0]!.endOrder).toBeLessThan(events[1]!.startOrder);
    expect(events[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(events[0]?.errorClass).toBeNull();
    expect(events[1]?.ordinal).toBeGreaterThan(events[0]!.ordinal);
  });

  it('preserves the exact returned object when the sink throws', async () => {
    const result = { content: [{ type: 'text', text: 'ok' }] };
    const wrapped = observeRegisteredTools([definition(async () => result)])[0]!;
    const actual = await toolContext.run(
      newToolContext(1n, 1n, () => {
        throw new Error('sink');
      }),
      () => wrapped.handler({}, {}),
    );
    expect(actual).toBe(result);
  });

  it('preserves the original thrown value and classifies it when the sink throws too', async () => {
    const original = new TypeError('business failure');
    const events: ToolObservation[] = [];
    const wrapped = observeRegisteredTools([
      definition(async () => {
        throw original;
      }),
    ])[0]!;
    const call = toolContext.run(
      newToolContext(1n, 1n, (event) => {
        events.push(event);
        throw new Error('sink failure');
      }),
      () => wrapped.handler({}, {}),
    );
    await expect(call).rejects.toBe(original);
    expect(events[0]).toMatchObject({
      outcome: 'threw',
      errorClass: 'TypeError',
      refusalCode: null,
    });
  });
});
