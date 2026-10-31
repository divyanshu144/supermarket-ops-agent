import 'dotenv/config';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { createSandbox, ownedSandboxProof } from './database.js';

const mode = process.argv[2];
if (!['test', 'attacks', 'cache'].includes(mode ?? ''))
  throw new Error('Expected test, attacks or cache');
const run = (cmd: string, args: string[], env = process.env) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    );
  });
await run('docker', ['compose', '-f', 'evals/engineering/compose.yml', 'up', '-d', '--wait']);
const sandbox = await createSandbox({
  adminUrl: 'postgres://eval_admin:disposable_eval_only@127.0.0.1:55441/eval_admin',
  normalUrl: process.env.DATABASE_URL ?? 'postgres://unused:unused@127.0.0.1:5432/unused',
  manifestDirectory: 'artifacts/engineering/manifests',
});
try {
  await mkdir('artifacts/engineering', { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    NODE_ENV: 'test',
    DATABASE_URL: sandbox.workerUrl,
    TELEGRAM_BOT_TOKEN: 'disabled-evaluation',
    LOG_MESSAGE_TEXT: 'false',
    ANTHROPIC_API_KEY: mode === 'test' ? 'disabled-evaluation' : process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: mode === 'cache' ? process.env.OPENAI_API_KEY : undefined,
    AGENT_MODEL: process.env.AGENT_MODEL ?? 'claude-opus-5',
    AGENT_EFFORT: process.env.AGENT_EFFORT ?? 'medium',
    AGENT_MAX_BUDGET_USD: '0.5',
    AGENT_MAX_TURNS: '10',
    AGENT_TURN_TIMEOUT_MS: '90000',
    EVAL_SANDBOX_PROOF: JSON.stringify(ownedSandboxProof(sandbox)),
    DOTENV_CONFIG_PATH: '/dev/null',
  };
  const require = createRequire(import.meta.url);
  const args =
    mode === 'test'
      ? [require.resolve('vitest/vitest.mjs'), 'run', ...process.argv.slice(3)]
      : [
          require.resolve('tsx/cli'),
          `src/evals/${mode === 'attacks' ? 'injection' : 'cache-benchmark'}.ts`,
          ...process.argv.slice(3),
        ];
  await run(process.execPath, args, env);
} finally {
  await sandbox.cleanup();
}
