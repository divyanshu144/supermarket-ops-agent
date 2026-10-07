import { describe, expect, it } from 'vitest';
import { parseScenario, ScenarioSchema } from './scenario.js';

const base = () => ({
  version: 1 as const,
  id: 'sample',
  description: 'Synthetic strict-contract test.',
  tags: ['billing'] as const,
  difficulty: 'normal' as const,
  seed: {
    anchor: '2026-10-06T10:00:00.000Z',
    store: { ref: 'shop', chatId: '1001', name: 'Synthetic shop' },
    products: [
      {
        ref: 'atta',
        name: 'Atta',
        brand: null,
        packSize: null,
        unit: 'kg',
        hsnCode: '11010000',
        gstRateBps: 0,
        costPricePaise: 4000,
        mrpPaise: 5000,
        quantityBase: 10,
      },
    ],
    customers: [{ ref: 'ravi', name: 'Ravi', openingBalancePaise: 500 }],
    ledger: [
      {
        ref: 'opening',
        customerRef: 'ravi',
        kind: 'charge',
        amountPaise: 500,
        note: 'Opening',
        at: '2026-10-06T09:00:00.000Z',
      },
    ],
    preferences: [{ key: 'default_payment_mode', value: 'cash' }],
    sentinel: { ref: 'sentinel', chatId: '1002', name: 'Sentinel shop' },
  },
  steps: [{ id: 'ask', kind: 'owner_message', text: 'How much atta?', language: 'en' }],
  expectations: {
    byStep: [
      { stepId: 'ask', assert: { state: { stock: [{ productRef: 'atta', quantityBase: 10 }] } } },
    ],
    final: { state: {} },
  },
});

describe('scenario contract', () => {
  it('accepts strict known fields and preserves ordered steps', () => {
    const scenario = base();
    scenario.steps.push({ id: 'new-chat', kind: 'new' } as never);
    scenario.expectations.byStep.push({ stepId: 'new-chat', assert: { state: { stock: [] } } });
    expect(parseScenario(scenario).steps.map((step) => step.id)).toEqual(['ask', 'new-chat']);
  });

  it('rejects duplicate fixture IDs', () => {
    const scenario = base();
    scenario.seed.products.push({ ...scenario.seed.products[0]! });
    expect(() => parseScenario(scenario)).toThrow(/duplicate product ref/);
  });

  it('rejects unresolved product and customer references', () => {
    const product = base();
    product.expectations.byStep[0]!.assert.state.stock[0]!.productRef = 'missing';
    expect(() => parseScenario(product)).toThrow(/unknown product ref/);
    const customer = base();
    customer.seed.ledger[0]!.customerRef = 'missing';
    expect(() => parseScenario(customer)).toThrow(/unknown customer ref/);
  });

  it('rejects external changes with unknown product or customer references', () => {
    const product = base();
    product.steps = [
      {
        id: 'outside',
        kind: 'external_change',
        change: { kind: 'stock', productRef: 'missing', deltaBase: 1 },
      },
    ] as never;
    product.expectations.byStep = [{ stepId: 'outside', assert: {} }] as never;
    expect(() => parseScenario(product)).toThrow(/unknown external-change product ref/);
    const customer = base();
    customer.steps = [
      {
        id: 'outside',
        kind: 'external_change',
        change: { kind: 'khata', customerRef: 'missing', amountPaise: 1, entryKind: 'charge' },
      },
    ] as never;
    customer.expectations.byStep = [{ stepId: 'outside', assert: {} }] as never;
    expect(() => parseScenario(customer)).toThrow(/unknown external-change customer ref/);
  });

  it('rejects expectation tool names outside the registered tool surface', () => {
    const scenario = base();
    scenario.expectations.byStep[0]!.assert = {
      state: { stock: [{ productRef: 'atta', quantityBase: 10 }] },
      tools: { ordered: [{ name: 'imaginary_tool' }] },
    } as never;
    expect(() => parseScenario(scenario)).toThrow();
  });

  it('rejects a ledger that does not reconcile to the seeded account balance', () => {
    const scenario = base();
    scenario.seed.customers[0]!.openingBalancePaise = 499;
    expect(() => parseScenario(scenario)).toThrow(/ledger does not reconcile/);
  });

  it('rejects unknown tags, variants, and fields', () => {
    expect(ScenarioSchema.safeParse({ ...base(), tags: ['made-up'] }).success).toBe(false);
    const invalidVariant = base();
    (invalidVariant.steps[0] as { kind: string }).kind = 'assistant_reply';
    expect(ScenarioSchema.safeParse(invalidVariant).success).toBe(false);
    expect(ScenarioSchema.safeParse({ ...base(), unexpected: true }).success).toBe(false);
  });

  it('rejects fractional paise values', () => {
    const fractional = base();
    fractional.seed.products[0]!.mrpPaise = 5000.5;
    expect(ScenarioSchema.safeParse(fractional).success).toBe(false);
  });

  it('rejects unsafe integer paise values', () => {
    const unsafe = base();
    unsafe.seed.products[0]!.mrpPaise = Number.MAX_SAFE_INTEGER + 1;
    expect(ScenarioSchema.safeParse(unsafe).success).toBe(false);
  });

  it('rejects a unit outside the locked domain enum', () => {
    const scenario = base();
    (scenario.seed.products[0] as { unit: string }).unit = 'box';
    expect(ScenarioSchema.safeParse(scenario).success).toBe(false);
  });

  it('requires nonempty step expectations and unique ordered step IDs', () => {
    expect(
      ScenarioSchema.safeParse({
        ...base(),
        steps: [{ id: 'new', kind: 'new' }],
        expectations: { byStep: [], final: {} },
      }).success,
    ).toBe(false);
    const scenario = base();
    scenario.steps.push({ ...scenario.steps[0]! });
    expect(() => parseScenario(scenario)).toThrow(/duplicate step id/);
  });

  it('requires a distinct sentinel store identity', () => {
    const scenario = base();
    scenario.seed.sentinel.chatId = scenario.seed.store.chatId;
    expect(() => parseScenario(scenario)).toThrow(/sentinel store identity/);
    const duplicateRef = base();
    duplicateRef.seed.sentinel.ref = duplicateRef.seed.store.ref;
    expect(() => parseScenario(duplicateRef)).toThrow(/sentinel store identity/);
  });
});
