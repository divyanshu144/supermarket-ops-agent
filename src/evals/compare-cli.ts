import { compareWithBaseline } from './compare.js';

const report = process.argv[2] ?? 'evals/results/latest.json';
const baseline = process.argv[3] ?? 'evals/baseline.json';
try {
  await compareWithBaseline(report, baseline);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Comparison refused.'}\n`);
  process.exitCode = 2;
}
