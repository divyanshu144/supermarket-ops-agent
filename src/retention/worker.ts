import { and, eq, lt, max, notExists, sql } from 'drizzle-orm';
import { readdir, stat, unlink } from 'node:fs/promises';
import { ARTIFACT_DIR } from '../documents/artifacts.js';
import { db } from '../db/client.js';
import { processedUpdates, sessionEntries, sessions } from '../db/schema.js';

export interface RetentionSweepOptions {
  retentionDays: number;
  now?: Date;
  artifactDir?: string;
}

export interface RetentionSweepResult {
  sessionsDeleted: number;
  transcriptEntriesDeleted: number;
  artifactsDeleted: number;
}

function cutoffAt(now: Date, retentionDays: number): Date {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new Error('Invalid retention period');
  }
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

async function deleteExpiredArtifacts(directory: string, cutoff: Date): Promise<number> {
  let deleted = 0;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }

  for (const entry of entries) {
    // Only regular files created by the artifact adapter are in scope. Never follow symlinks.
    if (!entry.isFile()) continue;
    const path = `${directory}/${entry.name}`;
    const info = await stat(path);
    if (info.mtime < cutoff) {
      await unlink(path);
      deleted += 1;
    }
  }
  return deleted;
}

/**
 * Idempotently removes app-owned transcripts and generated artifacts after inactivity.
 * It serializes with claimUpdate by locking store rows in the same order before inspecting
 * claimed updates. It records counts only; row contents, session IDs and filenames never enter
 * the log.
 */
export async function runRetentionSweep(
  options: RetentionSweepOptions,
): Promise<RetentionSweepResult> {
  const now = options.now ?? new Date();
  const cutoff = cutoffAt(now, options.retentionDays);
  const result: RetentionSweepResult = {
    sessionsDeleted: 0,
    transcriptEntriesDeleted: 0,
    artifactsDeleted: 0,
  };

  await db.transaction(async (tx) => {
    // claimUpdate takes this same lock before creating a claim. Holding all store locks makes
    // the check-and-delete decision stable against an update arriving during this sweep.
    await tx.execute(sql`select id from stores order by id for update`);

    const activeClaims = await tx
      .select({ chatId: processedUpdates.chatId })
      .from(processedUpdates)
      .where(eq(processedUpdates.status, 'claimed'));
    const activeStores = new Set(activeClaims.map((claim) => claim.chatId.toString()));
    const currentSessions = await tx.select().from(sessions);

    for (const session of currentSessions) {
      if (activeStores.has(session.storeId.toString())) continue;
      const activity = await tx
        .select({ lastEntry: max(sessionEntries.createdAt) })
        .from(sessionEntries)
        .where(eq(sessionEntries.sessionId, session.agentSessionId));
      const lastActivity = activity[0]?.lastEntry;
      if (lastActivity && lastActivity > session.updatedAt) {
        if (lastActivity >= cutoff) continue;
      } else if (session.updatedAt >= cutoff) {
        continue;
      }

      const removed = await tx
        .delete(sessionEntries)
        .where(eq(sessionEntries.sessionId, session.agentSessionId))
        .returning({ id: sessionEntries.id });
      result.transcriptEntriesDeleted += removed.length;
      const removedSession = await tx
        .delete(sessions)
        .where(eq(sessions.storeId, session.storeId))
        .returning({ storeId: sessions.storeId });
      result.sessionsDeleted += removedSession.length;
    }

    // Rows with no session mapping are abandoned transcripts. Their owner cannot be inferred;
    // age is the only safe discriminator, and active current-session IDs remain protected above.
    const orphanGroups = await tx
      .select({ sessionId: sessionEntries.sessionId, lastActivity: max(sessionEntries.createdAt) })
      .from(sessionEntries)
      .groupBy(sessionEntries.sessionId)
      .having(
        and(
          lt(max(sessionEntries.createdAt), cutoff),
          notExists(
            tx
              .select({ storeId: sessions.storeId })
              .from(sessions)
              .where(eq(sessions.agentSessionId, sessionEntries.sessionId)),
          ),
        ),
      );
    for (const orphan of orphanGroups) {
      const removed = await tx
        .delete(sessionEntries)
        .where(eq(sessionEntries.sessionId, orphan.sessionId))
        .returning({ id: sessionEntries.id });
      result.transcriptEntriesDeleted += removed.length;
    }
  });

  result.artifactsDeleted = await deleteExpiredArtifacts(
    options.artifactDir ?? ARTIFACT_DIR,
    cutoff,
  );
  console.info(JSON.stringify({ scope: 'retention', ...result }));
  return result;
}

/** Starts a daily, non-blocking cleanup after the process owns the single-instance lock. */
export function startRetentionScheduler(retentionDays: number): NodeJS.Timeout {
  const run = () => {
    void runRetentionSweep({ retentionDays }).catch(() => {
      console.error(JSON.stringify({ scope: 'retention', warning: 'cleanup failed' }));
    });
  };
  run();
  const timer = setInterval(run, 24 * 60 * 60 * 1000);
  timer.unref();
  return timer;
}
