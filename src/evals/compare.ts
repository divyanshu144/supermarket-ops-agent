import { readFile } from 'node:fs/promises';

/** Cost semantics have not been verified. Until then no report can be baseline-eligible. */
export async function compareWithBaseline(
  _reportPath: string,
  _baselinePath: string,
): Promise<never> {
  throw new Error(
    'Comparison refused: SDK cost semantics are unverified; no baseline can be accepted.',
  );
}

/** Kept private until a cost-semantics decision is recorded and reviewed. */
export async function readComparisonInputs(reportPath: string, baselinePath: string) {
  return Promise.all([
    readFile(reportPath, 'utf8').then((text) => JSON.parse(text) as unknown),
    readFile(baselinePath, 'utf8').then((text) => JSON.parse(text) as unknown),
  ]);
}
