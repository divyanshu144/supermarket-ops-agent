import {
  databaseTarget,
  sandboxOwnershipVerifier,
  type SandboxOwnershipProof,
} from './database.js';
import { safeReplayFailure } from './replay-errors.js';
import {
  assertReplayDatabaseTargets,
  executeReplayWithTools,
  type ReplayDatabaseTargets,
  type ReplayRecording,
  type ReplayTool,
} from './replay-core.js';
import type { DatabaseTarget } from './database.js';

interface WorkerRequest {
  recording: ReplayRecording;
  expectedTarget: DatabaseTarget;
  ownershipProof: SandboxOwnershipProof;
}

// Tool handlers and libraries must not contaminate the single JSON response channel.
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.warn = (...args: unknown[]) => console.error(...args);

async function main() {
  let pool: (typeof import('../db/client.js'))['pool'] | undefined;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WorkerRequest;
    const verifyOwnership = sandboxOwnershipVerifier(request.ownershipProof);
    await verifyOwnership();
    const activeUrl = process.env.DATABASE_URL;
    if (!activeUrl) throw new Error('Missing replay database URL');
    assertReplayDatabaseTargets(
      { process: databaseTarget(activeUrl), pool: request.expectedTarget },
      request.expectedTarget,
    );

    const database = await import('../db/client.js');
    pool = database.pool;
    pool.on('error', () => undefined);
    assertReplayDatabaseTargets(
      { process: databaseTarget(activeUrl), pool: database.getPoolTarget() },
      request.expectedTarget,
    );

    const { STORE_TOOLS } = await import('../tools/index.js');
    const result = await executeReplayWithTools(
      request.recording,
      STORE_TOOLS as unknown as readonly ReplayTool[],
      request.expectedTarget,
      async (): Promise<ReplayDatabaseTargets> => {
        const currentUrl = process.env.DATABASE_URL;
        if (!currentUrl) throw new Error('Missing replay database URL');
        const currentProcess = databaseTarget(currentUrl);
        const connectedPool = database.getPoolTarget();
        const actual = { process: currentProcess, pool: connectedPool };
        assertReplayDatabaseTargets(actual, request.expectedTarget);
        return actual;
      },
      verifyOwnership,
    );
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    const failure = safeReplayFailure(error);
    process.stdout.write(JSON.stringify({ ok: false, failure }));
    if (pool) await pool.end().catch(() => undefined);
    return;
  }
  if (pool) await pool.end();
}

void main();
