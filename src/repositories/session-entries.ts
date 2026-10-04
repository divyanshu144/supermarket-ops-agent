import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sessionEntries } from '../db/schema.js';

export interface EntryKey {
  projectKey: string;
  sessionId: string;
  /** Undefined = the main transcript. */
  subpath?: string;
}

const subpathOf = (key: EntryKey): string => key.subpath ?? '';

/**
 * Appends a batch in order, atomically.
 *
 * One row per entry inside one transaction, so ids ascend in batch order and a bad entry leaves
 * no partial batch. A duplicate `uuid` is ignored: the SDK retries a rejected append, and a
 * timed-out one may still have landed.
 */
export async function appendEntries(
  key: EntryKey,
  entries: Record<string, unknown>[],
): Promise<void> {
  if (entries.length === 0) return;
  await db.transaction(async (tx) => {
    for (const entry of entries) {
      await tx
        .insert(sessionEntries)
        .values({
          projectKey: key.projectKey,
          sessionId: key.sessionId,
          subpath: subpathOf(key),
          entryUuid: typeof entry.uuid === 'string' ? entry.uuid : null,
          entry,
        })
        .onConflictDoNothing();
    }
  });
}

/** Entries in append order, or null when nothing was ever written for the key. */
export async function loadEntries(key: EntryKey): Promise<Record<string, unknown>[] | null> {
  const rows = await db
    .select({ entry: sessionEntries.entry })
    .from(sessionEntries)
    .where(
      and(
        eq(sessionEntries.projectKey, key.projectKey),
        eq(sessionEntries.sessionId, key.sessionId),
        eq(sessionEntries.subpath, subpathOf(key)),
      ),
    )
    .orderBy(asc(sessionEntries.id));
  return rows.length === 0 ? null : rows.map((r) => r.entry);
}

/** No `subpath` deletes the whole session, every subpath included (the SDK's `delete` contract). */
export async function deleteEntries(key: EntryKey): Promise<void> {
  const scope = [
    eq(sessionEntries.projectKey, key.projectKey),
    eq(sessionEntries.sessionId, key.sessionId),
  ];
  if (key.subpath !== undefined) scope.push(eq(sessionEntries.subpath, key.subpath));
  await db.delete(sessionEntries).where(and(...scope));
}

/** Backs /new and /reset: the store schema is keyed by project, but a session id is a UUID. */
export async function deleteSessionEntries(sessionId: string): Promise<void> {
  await db.delete(sessionEntries).where(eq(sessionEntries.sessionId, sessionId));
}

export async function sessionHasEntries(sessionId: string): Promise<boolean> {
  const rows = await db
    .select({ id: sessionEntries.id })
    .from(sessionEntries)
    .where(eq(sessionEntries.sessionId, sessionId))
    .limit(1);
  return rows.length > 0;
}
