import { z } from 'zod';
import { EVAL_TOOL_NAMES } from './tool-names.js';

const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const paise = z.number().int().refine(Number.isSafeInteger, 'paise must be a safe integer').min(0);
const signedPaise = z.number().int().safe().min(-1_000_000_000_000).max(1_000_000_000_000);
const quantity = z.number().int().safe().min(0).max(1_000_000_000);
export const EVAL_UNITS = ['kg', 'g', 'litre', 'ml', 'packet', 'dozen', 'piece'] as const;
export const EVAL_TAGS = [
  'inventory',
  'billing',
  'khata',
  'analytics',
  'artifact',
  'preferences',
  'hindi',
  'hinglish',
  'adversarial',
  'grounding',
  'ambiguity',
  'reorder',
] as const;

const productSeed = z
  .object({
    ref: id,
    name: z.string().min(1),
    brand: z.string().nullable().default(null),
    packSize: z.string().nullable().default(null),
    unit: z.enum(EVAL_UNITS),
    isLoose: z.boolean().default(false),
    hsnCode: z.string().min(4),
    gstRateBps: z.number().int().safe().min(0).max(10000),
    costPricePaise: paise,
    mrpPaise: paise,
    quantityBase: quantity,
    reorderLevelBase: quantity.default(0),
  })
  .strict();

const customerSeed = z
  .object({
    ref: id,
    name: z.string().min(1),
    phone: z.string().nullable().default(null),
    openingBalancePaise: signedPaise.default(0),
  })
  .strict();
const ledgerSeed = z
  .object({
    ref: id,
    customerRef: id,
    kind: z.enum(['charge', 'payment', 'adjustment']),
    amountPaise: signedPaise,
    note: z.string().nullable().default(null),
    at: z.string().datetime({ offset: true }),
  })
  .strict();
const preferenceSeed = z
  .object({
    key: z.enum(['default_payment_mode', 'preferred_brand', 'shop_name', 'gstin']),
    value: z.unknown(),
  })
  .strict();
const artifactType = z.enum([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const stateExpectation = z
  .object({
    stock: z.array(z.object({ productRef: id, quantityBase: quantity }).strict()).default([]),
    movements: z
      .array(
        z
          .object({
            productRef: id,
            kind: z.enum(['receive', 'sale', 'adjust', 'reversal']),
            qtyBaseDelta: z.number().int().safe(),
            count: z.number().int().safe().positive().optional(),
          })
          .strict(),
      )
      .default([]),
    bills: z
      .array(
        z
          .object({
            ref: id,
            status: z.enum(['draft', 'finalized', 'void']),
            paymentMode: z.enum(['cash', 'upi', 'card', 'khata']).nullable(),
            subtotalPaise: paise.nullable(),
            cgstPaise: paise.nullable(),
            sgstPaise: paise.nullable(),
            roundOffPaise: signedPaise.nullable(),
            totalPaise: paise.nullable(),
            lines: z.array(
              z
                .object({
                  productRef: id,
                  lineNo: z.number().int().positive(),
                  qtyBase: quantity,
                  unitPricePaise: paise,
                  unit: z.enum(EVAL_UNITS),
                  gstRateBps: z.number().int().safe().min(0).max(10000),
                  lineTotalPaise: paise,
                  taxablePaise: paise,
                  cgstPaise: paise,
                  sgstPaise: paise,
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .default([]),
    accounts: z
      .array(
        z
          .object({
            customerRef: id,
            balancePaise: signedPaise,
            ledger: z
              .array(
                z
                  .object({
                    kind: z.enum(['charge', 'payment', 'adjustment']),
                    amountPaise: signedPaise,
                  })
                  .strict(),
              )
              .optional(),
          })
          .strict(),
      )
      .default([]),
    preferences: z.array(z.object({ key: z.string(), value: z.unknown() }).strict()).default([]),
    artifacts: z
      .array(
        z
          .object({
            ref: id,
            mediaType: artifactType,
            contains: z.array(z.string().min(1)).min(1),
            nativeChartCount: quantity.optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

const toolName = z.enum(EVAL_TOOL_NAMES);
const toolRule = z
  .object({
    name: toolName,
    count: z.number().int().safe().min(1).optional(),
    resultStatus: z.string().min(1).optional(),
    refusalCode: z.string().min(1).optional(),
  })
  .strict();
const deterministic = z
  .object({
    tools: z
      .object({ ordered: z.array(toolRule).default([]), forbidden: z.array(toolName).default([]) })
      .strict()
      .default({ ordered: [], forbidden: [] }),
    refusalCodes: z.array(z.string().min(1)).default([]),
    clarification: z
      .object({
        mustAsk: z.boolean(),
        beforeAnyMutation: z.boolean().default(true),
        candidatesRequired: z.boolean().default(false),
      })
      .strict()
      .optional(),
    state: stateExpectation.default({
      stock: [],
      movements: [],
      bills: [],
      accounts: [],
      preferences: [],
      artifacts: [],
    }),
    noBusinessStateChange: z.boolean().default(false),
  })
  .strict();

const judgment = z
  .object({
    tone: z.enum(['helpful', 'neutral', 'terse']),
    clarificationSensible: z.boolean().optional(),
    refusalMeaningConveyed: z.boolean().optional(),
  })
  .strict();
const step = z.discriminatedUnion('kind', [
  z
    .object({
      id,
      kind: z.literal('owner_message'),
      text: z.string().min(1),
      language: z.enum(['en', 'hi', 'hinglish']).default('en'),
    })
    .strict(),
  z.object({ id, kind: z.literal('new') }).strict(),
  z
    .object({
      id,
      kind: z.literal('external_change'),
      change: z.discriminatedUnion('kind', [
        z
          .object({ kind: z.literal('stock'), productRef: id, deltaBase: z.number().int().safe() })
          .strict(),
        z
          .object({
            kind: z.literal('khata'),
            customerRef: id,
            amountPaise: signedPaise,
            entryKind: z.enum(['charge', 'payment', 'adjustment']),
          })
          .strict(),
      ]),
    })
    .strict(),
]);

const stepExpectation = z
  .object({ stepId: id, assert: deterministic, judgment: judgment.optional() })
  .strict();
const storeSeed = z
  .object({
    ref: id,
    chatId: z.string().regex(/^-?[1-9][0-9]*$/),
    name: z.string().min(1),
    gstin: z.string().min(1).default('27ABCDE1234F1Z5'),
    stateCode: z.string().length(2).default('27'),
  })
  .strict();

export const ScenarioSchema = z
  .object({
    version: z.literal(1),
    id,
    description: z.string().min(1),
    tags: z.array(z.enum(EVAL_TAGS)).min(1),
    difficulty: z.enum(['normal', 'hard']),
    seed: z
      .object({
        anchor: z.string().datetime({ offset: true }),
        store: storeSeed,
        products: z.array(productSeed),
        customers: z.array(customerSeed).default([]),
        ledger: z.array(ledgerSeed).default([]),
        preferences: z.array(preferenceSeed).default([]),
        sentinel: storeSeed,
      })
      .strict(),
    steps: z.array(step).min(1),
    expectations: z
      .object({ byStep: z.array(stepExpectation).min(1), final: deterministic })
      .strict(),
  })
  .strict()
  .superRefine((scenario, ctx) => {
    const unique = (values: string[], path: (string | number)[], what: string) => {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value))
          ctx.addIssue({
            code: 'custom',
            path: [...path, index],
            message: `duplicate ${what}: ${value}`,
          });
        seen.add(value);
      });
    };
    unique(
      scenario.seed.products.map((p) => p.ref),
      ['seed', 'products'],
      'product ref',
    );
    unique(
      scenario.seed.customers.map((c) => c.ref),
      ['seed', 'customers'],
      'customer ref',
    );
    unique(
      scenario.steps.map((s) => s.id),
      ['steps'],
      'step id',
    );
    unique(
      scenario.expectations.byStep.map((e) => e.stepId),
      ['expectations', 'byStep'],
      'step expectation',
    );
    const productRefs = new Set(scenario.seed.products.map((p) => p.ref));
    const customerRefs = new Set(scenario.seed.customers.map((c) => c.ref));
    for (const [index, entry] of scenario.steps.entries()) {
      if (entry.kind !== 'external_change') continue;
      const known =
        entry.change.kind === 'stock'
          ? productRefs.has(entry.change.productRef)
          : customerRefs.has(entry.change.customerRef);
      if (!known)
        ctx.addIssue({
          code: 'custom',
          path: ['steps', index, 'change'],
          message: `unknown external-change ${entry.change.kind === 'stock' ? 'product' : 'customer'} ref`,
        });
    }
    const stepIds = new Set(scenario.steps.map((s) => s.id));
    const expectedSteps = new Set(scenario.expectations.byStep.map((e) => e.stepId));
    for (const entry of scenario.seed.ledger) {
      if (!customerRefs.has(entry.customerRef))
        ctx.addIssue({
          code: 'custom',
          path: ['seed', 'ledger'],
          message: `unknown customer ref: ${entry.customerRef}`,
        });
    }
    for (const customer of scenario.seed.customers) {
      const ledgerBalance = scenario.seed.ledger
        .filter((entry) => entry.customerRef === customer.ref)
        .reduce(
          (total, entry) =>
            total +
            (entry.kind === 'charge'
              ? entry.amountPaise
              : entry.kind === 'payment'
                ? -entry.amountPaise
                : entry.amountPaise),
          0,
        );
      if (!Number.isSafeInteger(ledgerBalance) || ledgerBalance !== customer.openingBalancePaise) {
        ctx.addIssue({
          code: 'custom',
          path: ['seed', 'customers'],
          message: `ledger does not reconcile to opening balance for ${customer.ref}`,
        });
      }
    }
    for (const ownerStep of scenario.steps.filter((entry) => entry.kind === 'owner_message')) {
      if (!expectedSteps.has(ownerStep.id))
        ctx.addIssue({
          code: 'custom',
          path: ['expectations', 'byStep'],
          message: `missing deterministic expectation for owner step ${ownerStep.id}`,
        });
    }
    for (const [index, entry] of scenario.expectations.byStep.entries()) {
      if (!stepIds.has(entry.stepId))
        ctx.addIssue({
          code: 'custom',
          path: ['expectations', 'byStep', index, 'stepId'],
          message: `unknown step ref: ${entry.stepId}`,
        });
    }
    const validateState = (state: z.infer<typeof stateExpectation>, path: (string | number)[]) => {
      const artifactRefs = new Set<string>();
      const billRefs = new Set<string>();
      for (const [i, stock] of state.stock.entries())
        if (!productRefs.has(stock.productRef))
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'stock', i],
            message: `unknown product ref: ${stock.productRef}`,
          });
      for (const [i, move] of state.movements.entries())
        if (!productRefs.has(move.productRef))
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'movements', i],
            message: `unknown product ref: ${move.productRef}`,
          });
      for (const [i, bill] of state.bills.entries()) {
        if (billRefs.has(bill.ref))
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'bills', i, 'ref'],
            message: `duplicate fixture ref: ${bill.ref}`,
          });
        billRefs.add(bill.ref);
        for (const [j, line] of bill.lines.entries())
          if (!productRefs.has(line.productRef))
            ctx.addIssue({
              code: 'custom',
              path: [...path, 'bills', i, 'lines', j],
              message: `unknown product ref: ${line.productRef}`,
            });
      }
      for (const [i, account] of state.accounts.entries())
        if (!customerRefs.has(account.customerRef))
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'accounts', i],
            message: `unknown customer ref: ${account.customerRef}`,
          });
      for (const [i, artifact] of state.artifacts.entries()) {
        if (artifactRefs.has(artifact.ref))
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'artifacts', i, 'ref'],
            message: `duplicate fixture ref: ${artifact.ref}`,
          });
        artifactRefs.add(artifact.ref);
      }
    };
    scenario.expectations.byStep.forEach((entry, index) =>
      validateState(entry.assert.state, ['expectations', 'byStep', index, 'assert', 'state']),
    );
    validateState(scenario.expectations.final.state, ['expectations', 'final', 'state']);
    for (const product of scenario.seed.products) {
      if (product.costPricePaise > product.mrpPaise)
        ctx.addIssue({
          code: 'custom',
          path: ['seed', 'products'],
          message: `cost exceeds MRP for ${product.ref}`,
        });
    }
    if (
      scenario.seed.store.ref === scenario.seed.sentinel.ref ||
      scenario.seed.store.chatId === scenario.seed.sentinel.chatId
    )
      ctx.addIssue({
        code: 'custom',
        path: ['seed', 'sentinel'],
        message: 'sentinel store identity must be distinct',
      });
  });

export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioStep = Scenario['steps'][number];
export type DeterministicExpectation = z.infer<typeof deterministic>;

export function parseScenario(value: unknown): Scenario {
  return ScenarioSchema.parse(value);
}
