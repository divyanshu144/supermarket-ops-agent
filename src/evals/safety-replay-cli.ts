import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runSafetyReplay, SafetyReplayDatasetSchema } from './safety-replay.js';
import type { SafetyReplayTag } from './safety-replay.js';

const allowedTags: SafetyReplayTag[] = [
  'safety',
  'catalogue_injection',
  'cross_store',
  'stock_destruction',
  'customer_pii',
  'owner_confirmation',
  'spend_abuse',
  'inventory',
];

function selectedTag(args: string[]): SafetyReplayTag {
  const tagIndex = args.indexOf('--tag');
  if (tagIndex === -1) {
    if (args.length !== 0) throw new Error('Usage: pnpm eval:safety [--tag <tag>]');
    return 'safety';
  }
  if (args.length !== 2 || !args[tagIndex + 1])
    throw new Error('Usage: pnpm eval:safety [--tag <tag>]');
  const tag = args[tagIndex + 1] as SafetyReplayTag;
  if (!allowedTags.includes(tag)) throw new Error('Unknown safety replay tag.');
  return tag;
}

async function main() {
  const tag = selectedTag(process.argv.slice(2));
  const path = resolve('evals/safety/replay.json');
  const dataset = SafetyReplayDatasetSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const report = runSafetyReplay(dataset, tag);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.pass) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Safety replay failed.'}\n`);
  process.exitCode = 1;
});
