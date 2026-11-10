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
    args.some((arg) => !['--run-live', '--pilot-english'].includes(arg)) ||
    args.filter((arg) => arg === '--run-live').length > 1 ||
    args.filter((arg) => arg === '--pilot-english').length > 1
  ) {
    throw new Error('Usage: pnpm eval:fairness [--pilot-english] [--run-live]');
  }
  const live = args.includes('--run-live');
  const pilot = args.includes('--pilot-english');
  const { corpus, hash } = await loadCorpus();
  const sampleNames = pilot
    ? [
        corpus.names[0]!,
        corpus.names[Math.floor((corpus.names.length - 1) / 2)]!,
        corpus.names.at(-1)!,
      ]
    : corpus.names;
  const evaluationCorpus = pilot ? { ...corpus, names: sampleNames } : corpus;
  const languages = pilot ? (['en'] as const) : (['en', 'hi', 'hinglish'] as const);
  const configuredPerRunCap = Number(process.env.AGENT_MAX_BUDGET_USD ?? (pilot ? '0.075' : '0.5'));
  const perRunCap = pilot ? Math.min(configuredPerRunCap, 0.075) : configuredPerRunCap;
  if (
    !Number.isFinite(perRunCap) ||
    perRunCap <= 0 ||
    perRunCap * 1_000_000 > Number.MAX_SAFE_INTEGER
  )
    throw new Error('AGENT_MAX_BUDGET_USD must be a finite, positive per-run cap.');
  const nameRuns =
    evaluationCorpus.names.length * evaluationCorpus.scenarios.length * evaluationCorpus.repeats;
  const languageRuns =
    languages.length * evaluationCorpus.scenarios.length * evaluationCorpus.repeats;
  const estimateMicroUsd = Math.ceil(perRunCap * 1_000_000) * (nameRuns + languageRuns);
  process.stdout.write(`Fairness corpus ${hash}\n`);
  if (pilot)
    process.stdout.write(
      `Mode: exploratory English-only pilot; names: ${sampleNames.map((name) => name.id).join(', ')}; three repeats; no Hindi/Hinglish prompts.\n`,
    );
  process.stdout.write(
    `Planned runs: ${nameRuns + languageRuns} (${nameRuns} name-swap, ${languageRuns} language-parity)\n`,
  );
  process.stdout.write(
    `Per-run budget ceiling: $${perRunCap.toFixed(3)}; maximum spend estimate: ${usd(estimateMicroUsd)}\n`,
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
  if (!pilot && corpus.scenarios.some((scenario) => !scenario.human_reviewed))
    throw new Error(
      'Live fairness evaluation requires native-speaker review of every corpus prompt.',
    );

  const reportPath = resolve(
    process.env.FAIRNESS_RESULT_PATH ??
      (pilot ? 'evals/results/fairness-english-pilot.json' : 'evals/results/fairness-latest.json'),
  );
  const checkpointPath = resolve(
    process.env.FAIRNESS_CHECKPOINT_PATH ??
      (pilot
        ? 'evals/results/fairness-english-pilot-checkpoint.json'
        : 'evals/results/fairness-checkpoint.json'),
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
    process.env.TELEGRAM_BOT_TOKEN = 'fairness-eval-placeholder-never-used-to-connect';
    process.env.LOG_MESSAGE_TEXT = 'false';
    process.env.NODE_ENV = 'test';
    process.env.AGENT_MAX_BUDGET_USD = String(perRunCap);
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
      corpus: evaluationCorpus,
      corpusHash: hash,
      runner,
      capMicroUsd,
      estimatedRunMicroUsd: Math.ceil(perRunCap * 1_000_000),
      evaluationKind: pilot ? 'english-only-pilot' : 'full',
      languages: [...languages],
      checkpoint,
      saveCheckpoint: (value) => atomicJson(checkpointPath, value),
    });
    const parsed = FairnessReportSchema.parse(report);
    await atomicJson(reportPath, parsed);
    const release = pilot
      ? { pass: false, failures: ['not-full-evaluation'] }
      : checkFairnessRelease(parsed, hash, Date.now(), corpus);
    process.stdout.write(
      `Completed ${parsed.completedRuns} runs; observed spend ${usd(parsed.actualCostMicroUsd)}.\n`,
    );
    if (pilot)
      process.stdout.write('Release check: not eligible (exploratory English-only pilot).\n');
    else {
      process.stdout.write(
        `Release check: ${release.pass ? 'PASS' : `FAIL (${release.failures.join(', ')})`}\n`,
      );
      if (!release.pass) process.exitCode = 1;
    }
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
