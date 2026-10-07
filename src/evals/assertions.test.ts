import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import pdfmake from 'pdfmake';
import type { ToolObservation } from '../tools/observe.js';
import { gradeDeterministically, type StepEvidence } from './assertions.js';
import type { DeterministicExpectation } from './scenario.js';
import type { FixtureBindings, ScenarioSnapshot } from './seed.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function state(quantity = 10): ScenarioSnapshot {
  return {
    products: [{ id: 'p1', name: 'Atta', quantityBase: quantity, storeId: '1', unit: 'kg' }],
    movements: [],
    bills: [],
    billItems: [],
    accounts: [],
    ledger: [],
    preferences: [{ key: 'default_payment_mode', value: 'cash' }],
    artifacts: [],
    sentinel: {
      products: [{ id: 'p2', name: 'Sentinel', quantityBase: 3 }],
      movements: [],
      bills: [],
      billItems: [],
      accounts: [],
      ledger: [],
      preferences: [],
    },
  };
}
function call(
  toolName: string,
  result: unknown = { status: 'ok' },
  refusalCode: string | null = null,
): ToolObservation {
  return {
    callId: `${toolName}-1`,
    ordinal: 1,
    toolName,
    input: {},
    startOrder: 1,
    endOrder: 2,
    durationMs: 1,
    outcome: 'returned',
    result,
    refusalCode,
    errorClass: null,
  };
}
const bindings: FixtureBindings = {
  storeIds: { shop: '1', sentinel: '2' },
  productIds: { atta: 'p1' },
  customerIds: {},
  billIds: {},
  sentinelProductId: 'p2',
};
const evidence = (
  tools: ToolObservation[] = [],
  before = state(),
  after = before,
  reply = 'Done.',
): StepEvidence => ({ before, after, tools, reply, askedClarifyingQuestion: false });
const blank = (): DeterministicExpectation => ({
  tools: { ordered: [], forbidden: [] },
  refusalCodes: [],
  state: { stock: [], movements: [], bills: [], accounts: [], preferences: [], artifacts: [] },
  noBusinessStateChange: false,
});

describe('deterministic scenario assertions', () => {
  it('detects a wrong stock quantity and a missing stock movement', async () => {
    const expected = blank();
    expected.state.stock = [{ productRef: 'atta', quantityBase: 10 }];
    expected.state.movements = [{ productRef: 'atta', kind: 'receive', qtyBaseDelta: 4 }];
    const actual = state(9);
    const result = await gradeDeterministically(expected, evidence([], state(), actual), bindings);
    expect(result.failures.map((failure) => failure.path)).toContain('state.stock.atta');
    expect(result.failures.map((failure) => failure.path)).toContain(
      'state.movements.atta.receive.4',
    );
    const duplicated = state(10);
    duplicated.movements = [
      { productId: 'p1', kind: 'receive', qtyBaseDelta: 4 },
      { productId: 'p1', kind: 'receive', qtyBaseDelta: 4 },
    ];
    const duplicateResult = await gradeDeterministically(
      expected,
      evidence([], state(), duplicated),
      bindings,
    );
    expect(duplicateResult.failures.map((failure) => failure.path)).toContain(
      'state.movements.atta.receive.4',
    );
  });

  it('requires dependent tools in order and rejects forbidden calls', async () => {
    const expected = blank();
    expected.tools.ordered = [
      { name: 'get_stock' },
      { name: 'finalize_bill', resultStatus: 'finalized' },
    ];
    expected.tools.forbidden = ['adjust_stock'];
    const result = await gradeDeterministically(
      expected,
      evidence([
        call('finalize_bill', { status: 'finalized' }),
        call('get_stock'),
        call('adjust_stock'),
      ]),
      bindings,
    );
    expect(result.pass).toBe(false);
    expect(result.failures.map((failure) => failure.path)).toContain('tools.ordered');
    expect(result.failures.map((failure) => failure.path)).toContain('tools.forbidden');
  });

  it('checks tool result status and refusal codes explicitly', async () => {
    const expected = blank();
    expected.tools.ordered = [
      {
        name: 'finalize_bill',
        resultStatus: 'insufficient_stock',
        refusalCode: 'insufficient_stock',
      },
    ];
    expected.refusalCodes = ['insufficient_stock'];
    const valid = await gradeDeterministically(
      expected,
      evidence([call('finalize_bill', { status: 'insufficient_stock' }, 'insufficient_stock')]),
      bindings,
    );
    const missingCode = await gradeDeterministically(
      expected,
      evidence([call('finalize_bill', { status: 'finalized' })]),
      bindings,
    );
    expect(valid.pass).toBe(true);
    expect(missingCode.failures.map((failure) => failure.path)).toContain(
      'tools.finalize_bill.resultStatus',
    );
    expect(missingCode.failures.map((failure) => failure.path)).toContain(
      'tools.finalize_bill.refusalCode',
    );
    expect(missingCode.failures.map((failure) => failure.path)).toContain('refusalCodes');
  });

  it('checks line tax against explicit paise values without calling the domain calculator', async () => {
    const expected = blank();
    expected.state.bills = [
      {
        ref: 'sale',
        status: 'finalized',
        paymentMode: 'cash',
        subtotalPaise: 5536,
        cgstPaise: 332,
        sgstPaise: 332,
        roundOffPaise: 0,
        totalPaise: 6200,
        lines: [
          {
            productRef: 'atta',
            lineNo: 1,
            qtyBase: 1,
            unitPricePaise: 6200,
            unit: 'piece',
            gstRateBps: 1200,
            lineTotalPaise: 6200,
            taxablePaise: 5536,
            cgstPaise: 332,
            sgstPaise: 332,
          },
        ],
      },
    ];
    bindings.billIds.sale = 'b1';
    const make = (taxRate = 1200) => ({
      ...state(),
      bills: [
        {
          id: 'b1',
          status: 'finalized',
          payment_mode: 'cash',
          subtotal_paise: 5536,
          cgst_paise: 332,
          sgst_paise: 332,
          round_off_paise: 0,
          total_paise: 6200,
        },
      ],
      billItems: [
        {
          bill_id: 'b1',
          product_id: 'p1',
          line_no: 1,
          qty_base: 1,
          unit_price_paise: 6200,
          gst_rate_bps: taxRate,
          unit: 'piece',
        },
      ],
    });
    const good = await gradeDeterministically(expected, evidence([], state(), make()), bindings);
    const bad = await gradeDeterministically(expected, evidence([], state(), make(500)), bindings);
    expect(good).toEqual({ pass: true, failures: [] });
    expect(bad.pass).toBe(false);
    expect(bad.failures.some((failure) => failure.path.includes('lines.1'))).toBe(true);
  });

  it('checks persisted account balance, ledger entries, and preference values separately', async () => {
    const expected = blank();
    expected.state.accounts = [
      { customerRef: 'ravi', balancePaise: 500, ledger: [{ kind: 'charge', amountPaise: 500 }] },
    ];
    expected.state.preferences = [{ key: 'default_payment_mode', value: 'upi' }];
    const current = state();
    current.accounts = [{ id: 'c1', customerName: 'Ravi', balancePaise: 500 }];
    current.ledger = [{ accountId: 'c1', kind: 'charge', amountPaise: 500 }];
    current.preferences = [{ key: 'default_payment_mode', value: 'upi' }];
    const accountBindings = { ...bindings, customerIds: { ravi: 'c1' } };
    const correct = await gradeDeterministically(
      expected,
      evidence([], current, current),
      accountBindings,
    );
    expect(correct.pass).toBe(true);

    const wrongBalance = structuredClone(current);
    wrongBalance.accounts[0]!.balancePaise = 501;
    expect(
      (
        await gradeDeterministically(expected, evidence([], current, wrongBalance), accountBindings)
      ).failures.map((failure) => failure.path),
    ).toContain('state.accounts.ravi.balancePaise');

    const wrongLedger = structuredClone(current);
    wrongLedger.ledger[0]!.amountPaise = 499;
    expect(
      (
        await gradeDeterministically(expected, evidence([], current, wrongLedger), accountBindings)
      ).failures.map((failure) => failure.path),
    ).toContain('state.accounts.ravi.ledger');

    const wrongPreference = structuredClone(current);
    wrongPreference.preferences[0]!.value = 'cash';
    expect(
      (
        await gradeDeterministically(
          expected,
          evidence([], current, wrongPreference),
          accountBindings,
        )
      ).failures.map((failure) => failure.path),
    ).toContain('state.preferences.default_payment_mode');
  });

  it('proves refusals are no-ops and a sentinel store stays isolated', async () => {
    const expected = blank();
    expected.noBusinessStateChange = true;
    const changed = state(9);
    const result = await gradeDeterministically(
      expected,
      evidence(
        [call('finalize_bill', { status: 'insufficient_stock' }, 'insufficient_stock')],
        state(),
        changed,
      ),
      bindings,
    );
    expect(result.pass).toBe(false);
    expect(
      result.failures.some((failure) => failure.path === 'noBusinessStateChange.products'),
    ).toBe(true);
    const sentinelChanged = state();
    sentinelChanged.sentinel.products[0]!.quantityBase = 2;
    const isolated = await gradeDeterministically(
      blank(),
      evidence([], state(), sentinelChanged),
      bindings,
    );
    expect(isolated.failures.map((failure) => failure.path)).toContain('sentinel.isolation');
  });

  it('requires a specific get_stock ambiguous result with actual named candidates', async () => {
    const expected = blank();
    expected.clarification = { mustAsk: true, beforeAnyMutation: true, candidatesRequired: true };
    const changed = state(9);
    const guessed = await gradeDeterministically(
      expected,
      {
        ...evidence(
          [stockCandidates([{ name: 'A' }, { name: 'B' }])],
          state(),
          changed,
          'I sold A. Which did you mean?',
        ),
        askedClarifyingQuestion: true,
      },
      bindings,
    );
    const silentLookup = await gradeDeterministically(
      expected,
      evidence(
        [stockCandidates([{ name: 'A' }, { name: 'B' }])],
        state(),
        state(),
        'I found two options.',
      ),
      bindings,
    );
    expect(guessed.pass).toBe(false);
    expect(silentLookup.pass).toBe(false);
    expect(silentLookup.failures.map((failure) => failure.path)).toContain('clarification.shape');
    const noCandidates = await gradeDeterministically(
      expected,
      { ...evidence([], state(), state(), 'Which one?'), askedClarifyingQuestion: true },
      bindings,
    );
    expect(noCandidates.failures.map((failure) => failure.path)).toContain(
      'clarification.candidates',
    );
    for (const badCall of [
      stockCandidates([]),
      call('daily_summary', { status: 'ambiguous', candidates: [{ name: 'A' }] }),
      { ...stockCandidates([{ name: '' }]), result: { content: [{ type: 'text', text: '{bad' }] } },
    ]) {
      const bad = await gradeDeterministically(
        expected,
        evidence([badCall], state(), state(), 'Which one?'),
        bindings,
      );
      expect(bad.failures.map((failure) => failure.path)).toContain('clarification.candidates');
    }
  });

  it('grounds an external stock change to the exact current product and returned quantity', async () => {
    const before = state(10);
    const after = state(12);
    after.products[0]!.unit = 'piece';
    const expectedCall = stockFound('Atta', '12 piece');
    const grounded = await gradeDeterministically(
      blank(),
      {
        ...evidence([expectedCall], before, after),
        externalChange: { kind: 'stock', productRef: 'atta' },
      },
      bindings,
    );
    expect(grounded.pass).toBe(true);
    for (const badCall of [
      call('get_stock', { status: 'found', product: { name: 'Other', in_stock: '12 piece' } }),
      stockFound('Atta', '10 piece'),
      call('finalize_bill'),
    ]) {
      const result = await gradeDeterministically(
        blank(),
        {
          ...evidence([badCall], before, after),
          externalChange: { kind: 'stock', productRef: 'atta' },
        },
        bindings,
      );
      expect(result.failures.map((failure) => failure.path)).toContain(
        'grounding.externalChange.stock',
      );
    }
  });

  it('grounds an external khata change to the exact current customer and paise balance', async () => {
    const before = state();
    const after = state();
    after.accounts = [{ id: 'c1', customerName: 'Ravi', balancePaise: 12345 }];
    const khataBindings = { ...bindings, customerIds: { ravi: 'c1' } };
    const exact = call('get_khata_balance', {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ status: 'found', name: 'Ravi', balance: '₹123.45' }),
        },
      ],
    });
    const grounded = await gradeDeterministically(
      blank(),
      {
        ...evidence([exact], before, after),
        externalChange: { kind: 'khata', customerRef: 'ravi' },
      },
      khataBindings,
    );
    expect(grounded.pass).toBe(true);
    const stale = call('get_khata_balance', {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ status: 'found', name: 'Ravi', balance: '₹100.00' }),
        },
      ],
    });
    const result = await gradeDeterministically(
      blank(),
      {
        ...evidence([stale], before, after),
        externalChange: { kind: 'khata', customerRef: 'ravi' },
      },
      khataBindings,
    );
    expect(result.failures.map((failure) => failure.path)).toContain(
      'grounding.externalChange.khata',
    );
  });

  it('invalidates analytics evidence that crossed its declared day boundary', async () => {
    const result = await gradeDeterministically(
      blank(),
      {
        ...evidence(),
        analyticsWindow: {
          requestedDate: '2026-10-06',
          startedAt: '2026-10-06T18:29:59Z',
          finishedAt: '2026-10-06T18:30:01Z',
        },
      },
      bindings,
    );
    expect(result.pass).toBe(false);
    expect(result.failures.map((failure) => failure.path)).toContain('analytics.window');
  });

  it('checks the PDF signature from generated bytes and ignores fabricated extraction evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eval-artifact-test-'));
    tempDirs.push(directory);
    const path = join(directory, 'invoice.pdf');
    pdfmake.setFonts({
      Helvetica: {
        normal: 'Helvetica',
        bold: 'Helvetica-Bold',
        italics: 'Helvetica-Oblique',
        bolditalics: 'Helvetica-BoldOblique',
      },
    });
    const pdf = await pdfmake
      .createPdf({
        defaultStyle: { font: 'Helvetica' },
        content: [{ text: 'TAX INVOICE INV-EVAL-1' }],
      })
      .getBuffer();
    await writeFile(path, pdf);
    const expected = blank();
    expected.state.artifacts = [
      { ref: 'invoice', mediaType: 'application/pdf', contains: ['TAX INVOICE', 'INV-EVAL-1'] },
    ];
    const snapshot = {
      ...state(),
      artifacts: [{ ref: 'invoice', mediaType: 'application/pdf', path }],
    };
    const goodPdf = await gradeDeterministically(
      expected,
      evidence([], state(), snapshot),
      bindings,
    );
    expect(goodPdf).toEqual({ pass: true, failures: [] });
    await writeFile(path, 'not a PDF');
    (snapshot.artifacts[0] as unknown as Record<string, unknown>).extractedText = 'Invoice 6200';
    const invalidSignature = await gradeDeterministically(
      expected,
      evidence([], state(), snapshot),
      bindings,
    );
    expect(invalidSignature.failures.map((failure) => failure.path)).toContain(
      'state.artifacts.invoice.signature',
    );
    const wrongPdf = await pdfmake
      .createPdf({
        defaultStyle: { font: 'Helvetica' },
        content: [{ text: 'Wrong invoice content' }],
      })
      .getBuffer();
    await writeFile(path, wrongPdf);
    const validEnvelope = await gradeDeterministically(
      expected,
      evidence([], state(), snapshot),
      bindings,
    );
    expect(
      validEnvelope.failures.filter(
        (failure) => failure.path === 'state.artifacts.invoice.contains',
      ),
    ).toHaveLength(2);
  });

  it('reads slide text and native chart XML from a real PPTX ZIP file', async () => {
    const require = createRequire(import.meta.url);
    const PptxGenJS = require('pptxgenjs') as typeof import('pptxgenjs').default;
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    const slide = pptx.addSlide();
    slide.addText('Weekly Sales Evidence');
    slide.addChart(pptx.ChartType.line, [{ name: 'Sales', labels: ['Oct 06'], values: [42] }], {
      x: 1,
      y: 1,
      w: 8,
      h: 4,
    });
    const directory = await mkdtemp(join(tmpdir(), 'eval-deck-test-'));
    tempDirs.push(directory);
    const path = join(directory, 'analysis.pptx');
    await pptx.writeFile({ fileName: path });
    const expected = blank();
    expected.state.artifacts = [
      {
        ref: 'deck',
        mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        contains: ['Weekly Sales Evidence', 'Oct 06'],
        nativeChartCount: 1,
      },
    ];
    const snapshot = {
      ...state(),
      artifacts: [
        {
          ref: 'deck',
          mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          path,
        },
      ],
    };
    expect(
      await gradeDeterministically(expected, evidence([], state(), snapshot), bindings),
    ).toEqual({ pass: true, failures: [] });
    const wrongCount = structuredClone(expected);
    wrongCount.state.artifacts[0]!.nativeChartCount = 2;
    expect(
      (
        await gradeDeterministically(wrongCount, evidence([], state(), snapshot), bindings)
      ).failures.map((failure) => failure.path),
    ).toContain('state.artifacts.deck.nativeChartCount');
    const wrongText = structuredClone(expected);
    wrongText.state.artifacts[0]!.contains = ['Not present in the deck'];
    expect(
      (
        await gradeDeterministically(wrongText, evidence([], state(), snapshot), bindings)
      ).failures.map((failure) => failure.path),
    ).toContain('state.artifacts.deck.contains');
  });
});

function stockCandidates(candidates: Array<{ name: string }>): ToolObservation {
  return call('get_stock', {
    content: [{ type: 'text', text: JSON.stringify({ status: 'ambiguous', candidates }) }],
  });
}

function stockFound(name: string, inStock: string): ToolObservation {
  return call('get_stock', {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ status: 'found', product: { name, in_stock: inStock } }),
      },
    ],
  });
}
