import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ToolObservation } from '../tools/observe.js';
import type { DeterministicExpectation, Scenario } from './scenario.js';
import type { FixtureBindings, ScenarioSnapshot } from './seed.js';

export interface EvalArtifactEvidence {
  ref: string;
  mediaType: string;
  path: string;
}

const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_PDF_PAGES = 100;

export interface StepEvidence {
  before: ScenarioSnapshot;
  after: ScenarioSnapshot;
  tools: ToolObservation[];
  reply: string;
  askedClarifyingQuestion: boolean;
  artifactEvidence?: EvalArtifactEvidence[];
  externalChange?: { kind: 'stock'; productRef: string } | { kind: 'khata'; customerRef: string };
  analyticsWindow?: { requestedDate: string; startedAt: string; finishedAt: string };
}

export interface AssertionFailure {
  path: string;
  expected: unknown;
  actual: unknown;
}
export interface AssertionResult {
  pass: boolean;
  failures: AssertionFailure[];
}

const deepEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function equal(failures: AssertionFailure[], path: string, actual: unknown, expected: unknown) {
  if (!deepEqual(actual, expected)) failures.push({ path, expected, actual });
}
function getStatus(value: unknown): string | undefined {
  if (typeof value === 'string') {
    try {
      return getStatus(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) return value.map(getStatus).find(Boolean);
  const object = value as Record<string, unknown>;
  if (typeof object.status === 'string') return object.status;
  return Object.values(object).map(getStatus).find(Boolean);
}

function gradeTools(
  expectation: DeterministicExpectation,
  evidence: StepEvidence,
  failures: AssertionFailure[],
) {
  const calls = evidence.tools;
  for (const name of expectation.tools.forbidden) {
    if (calls.some((call) => call.toolName === name))
      failures.push({
        path: 'tools.forbidden',
        expected: `not called: ${name}`,
        actual: calls.map((c) => c.toolName),
      });
  }
  let cursor = 0;
  for (const rule of expectation.tools.ordered) {
    const matches = calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.toolName === rule.name);
    if (rule.count !== undefined)
      equal(failures, `tools.count.${rule.name}`, matches.length, rule.count);
    const next = matches.find(({ index }) => index >= cursor);
    if (!next)
      failures.push({
        path: 'tools.ordered',
        expected: `ordered call ${rule.name}`,
        actual: calls.map((c) => c.toolName),
      });
    else {
      cursor = next.index + 1;
      if (rule.resultStatus)
        equal(
          failures,
          `tools.${rule.name}.resultStatus`,
          getStatus(next.call.result),
          rule.resultStatus,
        );
      if (rule.refusalCode)
        equal(failures, `tools.${rule.name}.refusalCode`, next.call.refusalCode, rule.refusalCode);
    }
  }
  for (const code of expectation.refusalCodes) {
    if (!calls.some((call) => call.refusalCode === code || getStatus(call.result) === code))
      failures.push({
        path: 'refusalCodes',
        expected: code,
        actual: calls.map((call) => call.refusalCode ?? getStatus(call.result)),
      });
  }
}

async function gradeState(
  expectation: DeterministicExpectation,
  snapshot: ScenarioSnapshot,
  bindings: FixtureBindings,
  failures: AssertionFailure[],
) {
  const state = expectation.state;
  for (const expected of state.stock) {
    const productId = bindings.productIds[expected.productRef];
    const product = snapshot.products.find((row) => row.id === productId);
    equal(
      failures,
      `state.stock.${expected.productRef}`,
      product?.quantityBase,
      expected.quantityBase,
    );
  }
  for (const expected of state.movements) {
    const productId = bindings.productIds[expected.productRef];
    const count = snapshot.movements.filter(
      (movement) =>
        movement.productId === productId &&
        movement.kind === expected.kind &&
        movement.qtyBaseDelta === expected.qtyBaseDelta,
    ).length;
    equal(
      failures,
      `state.movements.${expected.productRef}.${expected.kind}.${expected.qtyBaseDelta}`,
      count,
      expected.count ?? 1,
    );
  }
  for (const expected of state.bills) {
    const billId = bindings.billIds[expected.ref];
    const bill = snapshot.bills.find((row) => row.id === billId) as
      Record<string, unknown> | undefined;
    if (!bill) {
      failures.push({
        path: `state.bills.${expected.ref}`,
        expected: 'bound bill exists',
        actual: billId,
      });
      continue;
    }
    for (const key of [
      'status',
      'payment_mode',
      'subtotal_paise',
      'cgst_paise',
      'sgst_paise',
      'round_off_paise',
      'total_paise',
    ] as const) {
      const expectKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      const actual =
        bill[key] === null
          ? null
          : ['status', 'payment_mode'].includes(key)
            ? bill[key]
            : Number(bill[key]);
      equal(
        failures,
        `state.bills.${expected.ref}.${key}`,
        actual,
        expected[expectKey as keyof typeof expected],
      );
    }
    const actualLines = snapshot.billItems
      .filter((row) => row.bill_id === billId)
      .map((row) => ({
        productRef: Object.entries(bindings.productIds).find(
          ([, id]) => id === row.product_id,
        )?.[0],
        lineNo: Number(row.line_no),
        qtyBase: Number(row.qty_base),
        unitPricePaise: Number(row.unit_price_paise),
        unit: String(row.unit),
        gstRateBps: Number(row.gst_rate_bps),
        ...independentTax(
          Number(row.qty_base),
          String(row.unit),
          Number(row.unit_price_paise),
          Number(row.gst_rate_bps),
        ),
      }));
    for (const line of expected.lines) {
      const actual = actualLines.find((item) => item.lineNo === line.lineNo);
      equal(failures, `state.bills.${expected.ref}.lines.${line.lineNo}`, actual, line);
      equal(
        failures,
        `state.bills.${expected.ref}.lines.${line.lineNo}.productRef`,
        actual?.productRef,
        line.productRef,
      );
    }
    equal(
      failures,
      `state.bills.${expected.ref}.lineCount`,
      actualLines.length,
      expected.lines.length,
    );
  }
  for (const expected of state.accounts) {
    const customerId = bindings.customerIds[expected.customerRef];
    const account = snapshot.accounts.find((row) => row.id === customerId);
    equal(
      failures,
      `state.accounts.${expected.customerRef}.balancePaise`,
      account?.balancePaise,
      expected.balancePaise,
    );
    if (expected.ledger) {
      const actual = snapshot.ledger
        .filter((entry) => entry.accountId === customerId)
        .map(({ kind, amountPaise }) => ({ kind, amountPaise }));
      equal(failures, `state.accounts.${expected.customerRef}.ledger`, actual, expected.ledger);
    }
  }
  for (const preference of state.preferences) {
    const actual = snapshot.preferences.find((row) => row.key === preference.key)?.value;
    equal(failures, `state.preferences.${preference.key}`, actual, preference.value);
  }
  for (const artifact of state.artifacts) {
    const evidence = snapshot.artifacts.find((item) => item.ref === artifact.ref);
    if (!evidence) {
      failures.push({
        path: `state.artifacts.${artifact.ref}`,
        expected: 'artifact evidence',
        actual: null,
      });
      continue;
    }
    equal(
      failures,
      `state.artifacts.${artifact.ref}.mediaType`,
      evidence.mediaType,
      artifact.mediaType,
    );
    let file: Buffer;
    try {
      file = await readFile(evidence.path);
    } catch (error) {
      failures.push({
        path: `state.artifacts.${artifact.ref}.path`,
        expected: 'readable generated file',
        actual: error instanceof Error ? error.name : typeof error,
      });
      continue;
    }
    if (file.length > MAX_ARTIFACT_BYTES) {
      failures.push({
        path: `state.artifacts.${artifact.ref}.size`,
        expected: `<= ${MAX_ARTIFACT_BYTES}`,
        actual: file.length,
      });
      continue;
    }
    const bytes = file.subarray(0, 8).toString('latin1');
    const signature =
      artifact.mediaType === 'application/pdf'
        ? bytes.startsWith('%PDF-')
        : bytes.startsWith('PK\u0003\u0004');
    if (!signature)
      failures.push({
        path: `state.artifacts.${artifact.ref}.signature`,
        expected: artifact.mediaType,
        actual: bytes.slice(0, 8),
      });
    if (
      artifact.mediaType ===
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    ) {
      try {
        const entries = unzipEntries(file);
        const chartCount = [...entries.keys()].filter((name) =>
          /^ppt\/charts\/chart\d+\.xml$/.test(name),
        ).length;
        if (artifact.nativeChartCount !== undefined)
          equal(
            failures,
            `state.artifacts.${artifact.ref}.nativeChartCount`,
            chartCount,
            artifact.nativeChartCount,
          );
        const text = [...entries.entries()]
          .filter(([name]) => /^ppt\/(slides\/slide\d+\.xml|charts\/chart\d+\.xml)$/.test(name))
          .map(([, xml]) => decodeXmlText(xml.toString('utf8')))
          .join('\n');
        for (const term of artifact.contains)
          if (!text.includes(term))
            failures.push({
              path: `state.artifacts.${artifact.ref}.contains`,
              expected: term,
              actual: text.slice(0, 512),
            });
      } catch {
        failures.push({
          path: `state.artifacts.${artifact.ref}.container`,
          expected: 'valid PPTX ZIP container',
          actual: 'invalid ZIP container',
        });
      }
    } else if (artifact.mediaType === 'application/pdf') {
      try {
        const text = await extractPdfText(file);
        for (const term of artifact.contains)
          if (!text.includes(term))
            failures.push({
              path: `state.artifacts.${artifact.ref}.contains`,
              expected: term,
              actual: text.slice(0, 512),
            });
      } catch (error) {
        failures.push({
          path: `state.artifacts.${artifact.ref}.text`,
          expected: 'extractable PDF text',
          actual: error instanceof Error ? error.name : typeof error,
        });
      }
    }
  }
}

export async function extractPdfText(file: Buffer): Promise<string> {
  const task = getDocument({
    data: new Uint8Array(file),
    standardFontDataUrl: fileURLToPath(
      new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url),
    ),
  });
  let document: Awaited<typeof task.promise> | undefined;
  try {
    document = await task.promise;
    if (document.numPages > MAX_PDF_PAGES) throw new Error('PDF page limit exceeded');
    const pages: string[] = [];
    for (let pageNo = 1; pageNo <= document.numPages; pageNo++) {
      const page = await document.getPage(pageNo);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
      page.cleanup();
    }
    return pages.join('\n').replace(/\s+/g, ' ').trim();
  } finally {
    await task.destroy();
  }
}

function decodeXmlText(xml: string): string {
  return xml
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, value: string) => String.fromCodePoint(Number(value)))
    .replace(/&#x([\da-f]+);/gi, (_, value: string) => String.fromCodePoint(parseInt(value, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

// GST oracle uses integer arithmetic independent of src/domain/gst.ts. Inputs and expected
// paise remain explicit in fixture data; this only derives observed line tax for comparison.
function roundHalfUp(numerator: bigint, denominator: bigint): number {
  return Number((numerator * 2n + denominator) / (2n * denominator));
}

function independentTax(qtyBase: number, unit: string, unitPricePaise: number, rateBps: number) {
  const divisor: Record<string, bigint> = {
    kg: 1000n,
    g: 1n,
    litre: 1000n,
    ml: 1n,
    packet: 1n,
    dozen: 12n,
    piece: 1n,
  };
  const lineTotalPaise = roundHalfUp(BigInt(unitPricePaise) * BigInt(qtyBase), divisor[unit]!);
  const gross = BigInt(lineTotalPaise);
  const taxablePaise = roundHalfUp(gross * 10000n, 10000n + BigInt(rateBps));
  const taxPaise = lineTotalPaise - taxablePaise;
  const cgstPaise = Math.floor(taxPaise / 2);
  return { lineTotalPaise, taxablePaise, cgstPaise, sgstPaise: taxPaise - cgstPaise };
}

function unzipEntries(buffer: Buffer): Map<string, Buffer> {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('Invalid ZIP end record');
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP directory');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    const data =
      method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : Buffer.alloc(0);
    entries.set(name, data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function gradeStructure(
  expectation: DeterministicExpectation,
  evidence: StepEvidence,
  bindings: FixtureBindings,
  failures: AssertionFailure[],
) {
  equal(failures, 'sentinel.isolation', evidence.after.sentinel, evidence.before.sentinel);
  if (expectation.clarification?.mustAsk) {
    equal(failures, 'clarification.asked', evidence.askedClarifyingQuestion, true);
    if (!evidence.reply.trim().endsWith('?'))
      failures.push({
        path: 'clarification.shape',
        expected: 'owner-facing question ending in ?',
        actual: evidence.reply,
      });
    if (
      expectation.clarification.candidatesRequired &&
      !evidence.tools.some(hasActualStockCandidates)
    )
      failures.push({
        path: 'clarification.candidates',
        expected: 'candidate lookup evidence',
        actual: evidence.tools.map((call) => call.result),
      });
    if (expectation.clarification.beforeAnyMutation && !deepEqual(evidence.before, evidence.after))
      failures.push({
        path: 'clarification.beforeMutation',
        expected: 'state unchanged while clarifying',
        actual: 'state changed',
      });
    if (
      evidence.askedClarifyingQuestion &&
      /\?\s*$/.test(evidence.reply) &&
      expectation.clarification.beforeAnyMutation &&
      !deepEqual(evidence.before, evidence.after)
    )
      failures.push({
        path: 'clarification.noGuess',
        expected: 'no guessed action before question',
        actual: evidence.reply,
      });
  }
  if (expectation.noBusinessStateChange) {
    for (const key of [
      'products',
      'movements',
      'bills',
      'billItems',
      'accounts',
      'ledger',
      'preferences',
    ] as const)
      equal(failures, `noBusinessStateChange.${key}`, evidence.after[key], evidence.before[key]);
  }
  if (evidence.externalChange)
    gradeExternalChange(evidence.externalChange, evidence, bindings, failures);
  if (evidence.analyticsWindow) {
    const istDay = (value: string) =>
      new Date(new Date(value).getTime() + 330 * 60_000).toISOString().slice(0, 10);
    const startDay = istDay(evidence.analyticsWindow.startedAt);
    const finishDay = istDay(evidence.analyticsWindow.finishedAt);
    if (startDay !== finishDay || startDay !== evidence.analyticsWindow.requestedDate)
      failures.push({
        path: 'analytics.window',
        expected: `single IST date ${evidence.analyticsWindow.requestedDate}`,
        actual: { startDay, finishDay },
      });
  }
}

function gradeExternalChange(
  change: NonNullable<StepEvidence['externalChange']>,
  evidence: StepEvidence,
  bindings: FixtureBindings,
  failures: AssertionFailure[],
) {
  if (change.kind === 'stock') {
    const id = bindings.productIds[change.productRef];
    const current = evidence.after.products.find((row) => row.id === id);
    const match = evidence.tools.some((call) => {
      if (call.toolName !== 'get_stock') return false;
      const result = parseToolJson(call.result);
      const product = result?.product as { name?: unknown; in_stock?: unknown } | undefined;
      return (
        !!current &&
        !!product &&
        result?.status === 'found' &&
        product.name === current.name &&
        parseQuantityBase(product.in_stock, current.unit) === current.quantityBase
      );
    });
    if (!match)
      failures.push({
        path: 'grounding.externalChange.stock',
        expected: `get_stock returns ${current?.name} at ${current?.quantityBase} base units`,
        actual: evidence.tools.map((call) => call.toolName),
      });
  } else {
    const id = bindings.customerIds[change.customerRef];
    const account = evidence.after.accounts.find((row) => row.id === id);
    const match = evidence.tools.some((call) => {
      if (call.toolName !== 'get_khata_balance') return false;
      const result = parseToolJson(call.result);
      return (
        result?.status === 'found' &&
        result.name === account?.customerName &&
        parsePaise(result.balance) === account?.balancePaise
      );
    });
    if (!match)
      failures.push({
        path: 'grounding.externalChange.khata',
        expected: `get_khata_balance returns ${account?.customerName} at ${account?.balancePaise} paise`,
        actual: evidence.tools.map((call) => call.toolName),
      });
  }
}

function parseToolJson(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (
      !block ||
      typeof block !== 'object' ||
      typeof (block as { text?: unknown }).text !== 'string'
    )
      continue;
    try {
      const parsed: unknown = JSON.parse((block as { text: string }).text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch {
      /* malformed results are not grounding evidence */
    }
  }
  return undefined;
}

function parsePaise(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.replace(/[₹,\s]/g, '').match(/^(-?)(\d+)(?:\.(\d{2}))?$/);
  if (!match) return undefined;
  const amount = Number(match[2]) * 100 + Number(match[3] ?? '0');
  return match[1] ? -amount : amount;
}

function parseQuantityBase(value: unknown, unit: string): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.match(/^(-?\d+(?:\.\d+)?)\s+(kg|g|litre|ml|packet|dozen|piece)$/);
  if (!match || match[2] !== unit) return undefined;
  const multiplier: Record<string, number> = {
    kg: 1000,
    g: 1,
    litre: 1000,
    ml: 1,
    packet: 1,
    dozen: 12,
    piece: 1,
  };
  const exact = Number(match[1]) * multiplier[unit]!;
  return Number.isSafeInteger(exact) ? exact : undefined;
}

function hasActualStockCandidates(call: ToolObservation): boolean {
  if (call.toolName !== 'get_stock' || !call.result || typeof call.result !== 'object')
    return false;
  const content = (call.result as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'text')
      continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text !== 'string') continue;
    try {
      const result: unknown = JSON.parse(text);
      if (!result || typeof result !== 'object') continue;
      const record = result as { status?: unknown; candidates?: unknown };
      if (
        record.status === 'ambiguous' &&
        Array.isArray(record.candidates) &&
        record.candidates.length > 0 &&
        record.candidates.every(
          (item) =>
            !!item &&
            typeof item === 'object' &&
            typeof (item as { name?: unknown }).name === 'string' &&
            (item as { name: string }).name.trim().length > 0,
        )
      )
        return true;
    } catch {
      /* malformed tool output is not candidate evidence */
    }
  }
  return false;
}

export async function gradeDeterministically(
  expectation: DeterministicExpectation,
  evidence: StepEvidence,
  bindings: FixtureBindings,
): Promise<AssertionResult> {
  const failures: AssertionFailure[] = [];
  gradeTools(expectation, evidence, failures);
  await gradeState(expectation, evidence.after, bindings, failures);
  gradeStructure(expectation, evidence, bindings, failures);
  return { pass: failures.length === 0, failures };
}

export async function gradeScenarioStep(
  scenario: Scenario,
  stepId: string,
  evidence: StepEvidence,
  bindings: FixtureBindings,
): Promise<AssertionResult> {
  const expectation = scenario.expectations.byStep.find((entry) => entry.stepId === stepId);
  if (!expectation) throw new Error(`No deterministic expectation for step ${stepId}`);
  return gradeDeterministically(expectation.assert, evidence, bindings);
}
