import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  checkFairnessRelease,
  corpusSha256,
  FairnessCorpusSchema,
  FairnessReportSchema,
} from './fairness.js';

async function main() {
  const corpusText = await readFile(resolve('evals/fairness/corpus.json'), 'utf8');
  const pinnedHash = (await readFile(resolve('evals/fairness/corpus.sha256'), 'utf8')).trim();
  FairnessCorpusSchema.parse(JSON.parse(corpusText));
  if (corpusSha256(corpusText) !== pinnedHash) throw new Error('Fairness corpus SHA-256 mismatch.');
  const path = resolve(process.env.FAIRNESS_RESULT_PATH ?? 'evals/results/fairness-latest.json');
  const report = FairnessReportSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const result = checkFairnessRelease(report, pinnedHash);
  process.stdout.write(`${result.pass ? 'PASS' : `FAIL: ${result.failures.join(', ')}`}\n`);
  if (!result.pass) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Fairness release check failed.'}\n`,
  );
  process.exitCode = 1;
});
