import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, pool } from '../db/client.js';
import {
  generatedArtifacts,
  bills,
  processedUpdates,
  sessionEntries,
  sessions,
  stores,
} from '../db/schema.js';
import { markGeneratedArtifactsActive } from '../repositories/artifacts.js';
import { claimUpdate } from '../repositories/updates.js';
import { newToolContext, recordArtifact, toolContext } from '../tools/context.js';
import { runRetentionSweep } from './worker.js';

const STORE = 999000041n;
const RECENT_STORE = 999000042n;
const EDGE_STORE = 999000043n;
const NOW = new Date('2026-10-07T12:00:00.000Z');
const OLD = new Date('2026-09-06T11:59:59.000Z');
const RECENT = new Date('2026-09-07T12:00:01.000Z');
let artifactDir: string;

beforeEach(async () => {
  await db.delete(sessionEntries).where(eq(sessionEntries.projectKey, 'retention-test'));
  await db.delete(processedUpdates).where(eq(processedUpdates.chatId, STORE));
  await db.delete(stores).where(eq(stores.id, EDGE_STORE));
  await db.delete(stores).where(eq(stores.id, RECENT_STORE));
  await db.delete(stores).where(eq(stores.id, STORE));
  await db.insert(stores).values({ id: STORE, name: 'Retention test', gstin: '27AAAAA0000A1Z5' });
  await db
    .insert(stores)
    .values({ id: RECENT_STORE, name: 'Retention test 2', gstin: '27AAAAA0000A1Z5' });
  await db
    .insert(stores)
    .values({ id: EDGE_STORE, name: 'Retention test 3', gstin: '27AAAAA0000A1Z5' });
  artifactDir = await mkdtemp(join(tmpdir(), 'rai-retention-'));
});

afterAll(async () => {
  await db.delete(sessionEntries).where(eq(sessionEntries.projectKey, 'retention-test'));
  await db.delete(processedUpdates).where(eq(processedUpdates.chatId, STORE));
  await db.delete(stores).where(eq(stores.id, EDGE_STORE));
  await db.delete(stores).where(eq(stores.id, RECENT_STORE));
  await db.delete(stores).where(eq(stores.id, STORE));
  await pool.end();
});

async function addTranscript(sessionId: string, createdAt: Date): Promise<void> {
  await db.insert(sessionEntries).values({
    projectKey: 'retention-test',
    sessionId,
    entry: { message: 'private transcript sentinel' },
    createdAt,
  });
}

describe('runRetentionSweep', () => {
  it('deletes old sessions and transcripts by last activity, preserving recent sessions', async () => {
    await db.insert(sessions).values([
      { storeId: STORE, agentSessionId: 'old-session', updatedAt: OLD },
      { storeId: RECENT_STORE, agentSessionId: 'recent-session', updatedAt: RECENT },
      {
        storeId: EDGE_STORE,
        agentSessionId: 'edge-session',
        updatedAt: new Date(NOW.getTime() - 30 * 86_400_000),
      },
    ]);
    await addTranscript('old-session', OLD);
    await addTranscript('recent-session', RECENT);
    await addTranscript('edge-session', new Date(NOW.getTime() - 30 * 86_400_000));

    const result = await runRetentionSweep({ retentionDays: 30, now: NOW, artifactDir });

    expect(result.sessionsDeleted).toBe(1);
    expect(result.transcriptEntriesDeleted).toBe(1);
    expect((await db.select().from(sessions)).map((row) => row.agentSessionId)).toContain(
      'recent-session',
    );
    expect((await db.select().from(sessions)).map((row) => row.agentSessionId)).toContain(
      'edge-session',
    );
    expect((await db.select().from(sessionEntries)).map((row) => row.sessionId)).toEqual([
      'recent-session',
      'edge-session',
    ]);
  });

  it('preserves a stale session while its store has an in-flight Telegram claim', async () => {
    await db
      .insert(sessions)
      .values({ storeId: STORE, agentSessionId: 'in-flight-session', updatedAt: OLD });
    await addTranscript('in-flight-session', OLD);
    await db
      .insert(processedUpdates)
      .values({ updateId: 99000041n, chatId: STORE, status: 'claimed', claimedAt: NOW });

    const result = await runRetentionSweep({ retentionDays: 30, now: NOW, artifactDir });

    expect(result.sessionsDeleted).toBe(0);
    expect(result.transcriptEntriesDeleted).toBe(0);
    expect(
      (await db.select().from(sessions)).some((row) => row.agentSessionId === 'in-flight-session'),
    ).toBe(true);
  });

  it('serializes a pending update claim ahead of cleanup for the same store', async () => {
    await db.insert(sessions).values({
      storeId: STORE,
      agentSessionId: 'claim-race-session',
      updatedAt: OLD,
    });
    await addTranscript('claim-race-session', OLD);
    const lockOwner = await pool.connect();
    let sweep: Promise<Awaited<ReturnType<typeof runRetentionSweep>>> | undefined;
    let claim: Promise<Awaited<ReturnType<typeof claimUpdate>>> | undefined;

    await lockOwner.query('begin');
    try {
      const locked = await lockOwner.query('select id from stores where id = $1 for update', [
        STORE.toString(),
      ]);
      expect(locked.rows).toHaveLength(1);
      claim = claimUpdate(99000042n, STORE);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(
        await db.select().from(processedUpdates).where(eq(processedUpdates.chatId, STORE)),
      ).toEqual([]);

      sweep = runRetentionSweep({ retentionDays: 30, now: NOW, artifactDir });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect((await db.select().from(sessions)).map((row) => row.agentSessionId)).toContain(
        'claim-race-session',
      );
      await lockOwner.query('commit');

      expect(await claim).toBe('claimed');
      const result = await sweep;
      expect(result.sessionsDeleted).toBe(0);
      expect(result.transcriptEntriesDeleted).toBe(0);
    } finally {
      await lockOwner.query('rollback').catch(() => {});
      lockOwner.release();
      await claim?.catch(() => {});
      await sweep?.catch(() => {});
    }
  });

  it('removes stale orphan transcript rows and is idempotent', async () => {
    await addTranscript('orphan-session', OLD);
    const first = await runRetentionSweep({ retentionDays: 30, now: NOW, artifactDir });
    const second = await runRetentionSweep({ retentionDays: 30, now: NOW, artifactDir });

    expect(first.transcriptEntriesDeleted).toBe(1);
    expect(second.transcriptEntriesDeleted).toBe(0);
  });

  it('expires old artifacts and preserves recent artifacts and directories', async () => {
    const oldFile = join(artifactDir, 'old.pdf');
    const recentFile = join(artifactDir, 'recent.pdf');
    const folder = join(artifactDir, 'folder');
    await writeFile(oldFile, 'old');
    await writeFile(recentFile, 'recent');
    await mkdir(folder);
    await utimes(oldFile, OLD, OLD);
    await utimes(recentFile, RECENT, RECENT);

    const result = await runRetentionSweep({ retentionDays: 30, now: NOW, artifactDir });

    expect(result.artifactsDeleted).toBe(1);
    expect(await readdir(artifactDir)).toEqual(['folder', 'recent.pdf']);
  });

  it('expires indexed artifacts by store activity, not file modification time', async () => {
    const expiredPath = join(artifactDir, 'indexed-expired-deck.pptx');
    const activePath = join(artifactDir, 'indexed-active-deck.pptx');
    await writeFile(expiredPath, 'expired');
    await writeFile(activePath, 'active');
    await utimes(expiredPath, RECENT, RECENT);
    await utimes(activePath, OLD, OLD);
    await db.insert(generatedArtifacts).values([
      {
        artifactId: '81000000-0000-4000-8000-000000000001',
        storeId: STORE,
        fileName: 'indexed-expired-deck.pptx',
        lastActivityAt: OLD,
      },
      {
        artifactId: '81000000-0000-4000-8000-000000000002',
        storeId: RECENT_STORE,
        fileName: 'indexed-active-deck.pptx',
        lastActivityAt: RECENT,
      },
    ]);

    const result = await runRetentionSweep({ retentionDays: 30, now: NOW, artifactDir });

    expect(result.artifactsDeleted).toBe(1);
    expect(await readdir(artifactDir)).toEqual(['indexed-active-deck.pptx']);
  });

  it('preserves expired indexed artifacts while the store has an in-flight Telegram claim', async () => {
    const fileName = 'claimed-store-invoice.pdf';
    await writeFile(join(artifactDir, fileName), 'invoice');
    await db.insert(generatedArtifacts).values({
      artifactId: '81000000-0000-4000-8000-000000000008',
      storeId: STORE,
      fileName,
      lastActivityAt: OLD,
    });
    await db
      .insert(processedUpdates)
      .values({ updateId: 99000044n, chatId: STORE, status: 'claimed', claimedAt: NOW });

    const result = await runRetentionSweep({ retentionDays: 30, now: NOW, artifactDir });

    expect(result.artifactsDeleted).toBe(0);
    expect(await readdir(artifactDir)).toEqual([fileName]);
    expect(await db.select().from(generatedArtifacts)).toHaveLength(1);
  });

  it('refreshes only the authenticated store artifacts when the owner is active', async () => {
    await db.insert(generatedArtifacts).values([
      {
        artifactId: '81000000-0000-4000-8000-000000000003',
        storeId: STORE,
        fileName: 'store-a.pdf',
        lastActivityAt: OLD,
      },
      {
        artifactId: '81000000-0000-4000-8000-000000000004',
        storeId: RECENT_STORE,
        fileName: 'store-b.pdf',
        lastActivityAt: OLD,
      },
    ]);

    await markGeneratedArtifactsActive(STORE, NOW);

    const activity = await db
      .select({
        storeId: generatedArtifacts.storeId,
        lastActivityAt: generatedArtifacts.lastActivityAt,
      })
      .from(generatedArtifacts);
    expect(activity.find((row) => row.storeId === STORE)?.lastActivityAt).toEqual(NOW);
    expect(activity.find((row) => row.storeId === RECENT_STORE)?.lastActivityAt).toEqual(OLD);
  });

  it('registers generated files with their store and optional bill link before delivery', async () => {
    const artifactPath = join(artifactDir, 'tracked-invoice.pdf');
    await writeFile(artifactPath, 'pdf bytes');
    const artifact = {
      artifactId: '81000000-0000-4000-8000-000000000005',
      path: artifactPath,
      filename: 'invoice.pdf',
      mime: 'application/pdf',
    };
    const billId = '82000000-0000-4000-8000-000000000001';
    await db.insert(bills).values({ id: billId, storeId: STORE });
    const context = newToolContext(STORE, 99000043n);

    await toolContext.run(context, () => recordArtifact(artifact, { billId }));

    const [registered] = await db
      .select()
      .from(generatedArtifacts)
      .where(eq(generatedArtifacts.artifactId, artifact.artifactId));
    expect(registered).toMatchObject({
      storeId: STORE,
      fileName: 'tracked-invoice.pdf',
      billId,
    });
    expect(context.artifacts).toEqual([artifact]);
  });

  it('logs counts only, never transcript content or artifact names', async () => {
    await addTranscript('private-session', OLD);
    const privateArtifactPath = join(artifactDir, 'private-file-sentinel.pdf');
    await writeFile(privateArtifactPath, 'private file bytes');
    await db.insert(generatedArtifacts).values({
      artifactId: '81000000-0000-4000-8000-000000000007',
      storeId: STORE,
      fileName: 'private-file-sentinel.pdf',
      lastActivityAt: OLD,
    });
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await runRetentionSweep({ retentionDays: 30, now: NOW, artifactDir });
      const output = log.mock.calls.flat().join(' ');
      expect(output).toContain('transcriptEntriesDeleted');
      expect(output).not.toContain('private transcript sentinel');
      expect(output).not.toContain('private-session');
      expect(output).not.toContain('private-file-sentinel.pdf');
    } finally {
      log.mockRestore();
      await rm(artifactDir, { recursive: true, force: true });
    }
  });
});
