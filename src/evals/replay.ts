import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ownedSandboxProof, ownedSandboxTarget, type Sandbox } from './database.js';
import { replayFailureMessage, safeReplayFailure } from './replay-errors.js';
import { ReplayRecordingSchema, type ReplayResult } from './replay-core.js';

export { ReplayRecordingSchema } from './replay-core.js';
export type { ReplayRecording, ReplayResult } from './replay-core.js';

const MAX_IPC_BYTES = 8 * 1024 * 1024;
const WORKER_TIMEOUT_MS = 120_000;
const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');
const workerFile = fileURLToPath(new URL('./replay.worker.ts', import.meta.url));

interface WorkerReply {
  ok: boolean;
  result?: ReplayResult;
  failure?: ReturnType<typeof safeReplayFailure>;
}

/** Runs real registered handlers only in a fresh process bound to a createSandbox() resource. */
export async function replayRecording(input: unknown, sandbox: Sandbox): Promise<ReplayResult> {
  const recording = ReplayRecordingSchema.parse(input);
  const expectedTarget = ownedSandboxTarget(sandbox);
  const ownershipProof = ownedSandboxProof(sandbox);
  const child = spawn(process.execPath, [tsxCli, workerFile], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      NODE_ENV: 'test',
      DATABASE_URL: sandbox.workerUrl,
      // The production config requires values, but replay has no model or transport path.
      TELEGRAM_BOT_TOKEN: 'replay-disabled',
      ANTHROPIC_API_KEY: 'replay-disabled',
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  const request = JSON.stringify({ recording, expectedTarget, ownershipProof });
  if (Buffer.byteLength(request) > MAX_IPC_BYTES) {
    child.kill('SIGKILL');
    throw new Error('Replay request exceeds the IPC limit.');
  }
  child.stdin.end(request);

  const reply = await new Promise<WorkerReply>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Replay worker timed out; details are redacted.'));
    }, WORKER_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > MAX_IPC_BYTES) {
        child.kill('SIGKILL');
        clearTimeout(timer);
        reject(new Error('Replay worker output exceeded the IPC limit.'));
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(replayFailureMessage(safeReplayFailure(error))));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error('Replay worker failed; details are redacted.'));
        return;
      }
      try {
        resolve(JSON.parse(output) as WorkerReply);
      } catch (error) {
        reject(new Error(replayFailureMessage(safeReplayFailure(error))));
      }
    });
  });

  if (!reply.ok || !reply.result)
    throw new Error(
      replayFailureMessage(reply.failure ?? { name: 'ReplayWorkerError', code: null }),
    );
  return reply.result;
}
