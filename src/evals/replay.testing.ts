import type { DatabaseTarget } from './database.js';
import {
  executeReplayWithTools,
  type ReplayDatabaseTargets,
  type ReplayResult,
  type ReplayTool,
} from './replay-core.js';

/** Test-only path. It has no import of the production registry or database pool. */
export function replayWithInjectedToolsForTest(
  recording: unknown,
  tools: readonly ReplayTool[],
  target: DatabaseTarget = {
    host: 'eval.invalid',
    port: 5432,
    database: 'eval_test',
    user: 'eval_test',
  },
  verifyTarget: () => Promise<ReplayDatabaseTargets> = async () => ({
    process: target,
    pool: target,
  }),
  verifyOwnership: () => Promise<void> = async () => undefined,
): Promise<ReplayResult> {
  return executeReplayWithTools(recording, tools, target, verifyTarget, verifyOwnership);
}
