import 'dotenv/config';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createSandbox } from './database.js';
import {
  checkFairnessRelease,
  corpusSha256,
  FairnessCheckpointSchema,
  FairnessCorpusSchema,
  FairnessReportSchema,
  runFairnessEvaluation,
} from './fairness.js';
import { createFairnessAgentRunner } from './fairness-agent-runner.js';

const corpusPath = resolve('evals/fairness/corpus.json');
const hashPath = resolve('evals/fairness/corpus.sha256');
const reportPath = resolve(
  process.env.FAIRNESS_RESULT_PATH ?? 'evals/results/fairness-latest.json',
);
const checkpointPath = resolve(
  process.env.FAIRNESS_CHECKPOINT_PATH ?? 'evals/results/fairness-checkpoint.json',
);

function usd(microUsd: number) {
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
}

async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

async function loadCorpus() {
  const [raw, pinned] = await Promise.all([
    readFile(corpusPath, 'utf8'),
    readFile(hashPath, 'utf8'),
  ]);
  const hash = corpusSha256(raw);
  if (pinned.trim() !== hash)
    throw new Error('Fairness corpus SHA-256 does not match evals/fairness/corpus.sha256');
  return { corpus: FairnessCorpusSchema.parse(JSON.parse(raw)), hash };
}

async function fairnessCli() {
  const args = process.argv.slice(2);
  if (
    args.some((arg) => !['--run-live'].includes(arg)) ||
    args.filter((arg) => arg === '--run-live').length > 1
  ) {
    throw new Error('Usage: pnpm eval:fairness [--run-live]');
  }
  const live = args.includes('--run-live');
  const { corpus, hash } = await loadCorpus();
  const perRunCap = Number(process.env.AGENT_MAX_BUDGET_USD ?? '0.5');
  if (
    !Number.isFinite(perRunCap) ||
    perRunCap <= 0 ||
    perRunCap * 1_000_000 > Number.MAX_SAFE_INTEGER
  )
    throw new Error('AGENT_MAX_BUDGET_USD must be a finite, positive per-run cap.');
  const nameRuns = corpus.names.length * corpus.scenarios.length * corpus.repeats;
  const languageRuns = 3 * corpus.scenarios.length * corpus.repeats;
  const estimateMicroUsd = Math.ceil(perRunCap * 1_000_000) * (nameRuns + languageRuns);
  process.stdout.write(`Fairness corpus ${hash}\n`);
  process.stdout.write(
    `Planned runs: ${nameRuns + languageRuns} (${nameRuns} name-swap, ${languageRuns} language-parity)\n`,
  );
  process.stdout.write(
    `Per-run budget ceiling: ${usd(Math.ceil(perRunCap * 1_000_000))}; maximum spend estimate: ${usd(estimateMicroUsd)}\n`,
  );
  const capUsd = Number(process.env.FAIRNESS_BUDGET_USD ?? '');
  if (!Number.isFinite(capUsd) || capUsd <= 0)
    throw new Error(
      'Set FAIRNESS_BUDGET_USD to an explicit positive spend cap before running this evaluation.',
    );
  const capMicroUsd = Math.floor(capUsd * 1_000_000);
  if (!Number.isSafeInteger(capMicroUsd)) throw new Error('FAIRNESS_BUDGET_USD is too large.');
  if (estimateMicroUsd > capMicroUsd)
    throw new Error(
      `Estimated spend ${usd(estimateMicroUsd)} exceeds FAIRNESS_BUDGET_USD ${usd(capMicroUsd)}.`,
    );
  if (!live) {
    process.stdout.write(
      'Preflight only; no model call or database connection made. Pass --run-live to begin.\n',
    );
    return;
  }
  if (corpus.scenarios.some((scenario) => !scenario.human_reviewed))
    throw new Error(
      'Live fairness evaluation requires native-speaker review of every corpus prompt.',
    );

  const adminUrl = process.env.EVAL_ADMIN_DATABASE_URL;
  const normalUrl = process.env.EVAL_NORMAL_DATABASE_URL;
  if (!adminUrl || !normalUrl)
    throw new Error(
      'Live evaluation requires EVAL_ADMIN_DATABASE_URL and EVAL_NORMAL_DATABASE_URL for a disposable local Postgres cluster.',
    );
  for (const value of [adminUrl, normalUrl]) {
    const host = new URL(value).hostname;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host))
      throw new Error(
        'Fairness live evaluation is restricted to local disposable Postgres; remote database targets are refused.',
      );
  }
  if (!process.env.ANTHROPIC_API_KEY)
    throw new Error('ANTHROPIC_API_KEY is required for the explicitly requested live evaluation.');
  let checkpoint;
  try {
    checkpoint = FairnessCheckpointSchema.parse(JSON.parse(await readFile(checkpointPath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error(
        'Fairness checkpoint is invalid; refusing to resume. Remove it only after reviewing the failed run.',
        { cause: error },
      );
  }
  if (checkpoint?.inProgressRunId !== null && checkpoint?.inProgressRunId !== undefined)
    throw new Error(
      'Fairness checkpoint has an unfinished paid attempt; inspect it before resuming to avoid duplicate model calls.',
    );
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const sandbox = await createSandbox({
    adminUrl,
    normalUrl,
    manifestDirectory: resolve('evals/.fairness-sandboxes'),
  });
  let pool: { end(): Promise<void> } | undefined;
  try {
    process.env.DATABASE_URL = sandbox.workerUrl;
    process.env.TELEGRAM_BOT_TOKEN ??= 'fairness-eval-placeholder-never-used-to-connect';
    process.env.LOG_MESSAGE_TEXT = 'false';
    process.env.NODE_ENV = 'test';
    const [dbModule, schema, drizzle, runtime, context, bills, khata] = await Promise.all([
      import('../db/client.js'),
      import('../db/schema.js'),
      import('drizzle-orm'),
      import('../agent/runtime.js'),
      import('../tools/context.js'),
      import('../repositories/bills.js'),
      import('../repositories/khata.js'),
    ]);
    pool = dbModule.pool;
    const runner = createFairnessAgentRunner({
      maxRunCostMicroUsd: Math.ceil(perRunCap * 1_000_000),
      db: dbModule.db,
      schema,
      eq: drizzle.eq,
      runAgent: runtime.runAgent,
      toolContext: context.toolContext,
      newToolContext: context.newToolContext,
      openBill: bills.openBill,
      addBillItem: bills.addBillItem,
      chargeAccount: khata.chargeAccount,
      AgentRunFailure: runtime.AgentRunFailure,
    });
    const report = await runFairnessEvaluation({
      corpus,
      corpusHash: hash,
      runner,
      capMicroUsd,
      estimatedRunMicroUsd: Math.ceil(perRunCap * 1_000_000),
      checkpoint,
      saveCheckpoint: (value) => atomicJson(checkpointPath, value),
    });
    const parsed = FairnessReportSchema.parse(report);
    await atomicJson(reportPath, parsed);
    const release = checkFairnessRelease(parsed, hash, Date.now(), corpus);
    process.stdout.write(
      `Completed ${parsed.completedRuns} runs; observed spend ${usd(parsed.actualCostMicroUsd)}.\n`,
    );
    process.stdout.write(
      `Release check: ${release.pass ? 'PASS' : `FAIL (${release.failures.join(', ')})`}\n`,
    );
    if (!release.pass) process.exitCode = 1;
  } finally {
    await pool?.end();
    await sandbox.cleanup();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
}

void fairnessCli().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Fairness evaluation failed.'}\n`,
  );
  process.exitCode = 1;
});
