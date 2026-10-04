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

/** `String.prototype.toWellFormed` is ES2024; the project's TS lib target is ES2023. */
interface WellFormable {
  toWellFormed(): string;
}

function clean(text: string): string {
  return (text.replaceAll('\u0000', '') as string & WellFormable).toWellFormed();
}

/**
 * Makes a value safe for Postgres `jsonb`, which rejects U+0000 and lone UTF-16 surrogates
 * (e.g. an emoji truncated in tool output). Either would make every SDK retry fail and the SDK
 * would drop the batch. NUL is removed; a lone surrogate becomes U+FFFD; valid surrogate pairs
 * are untouched. Applies to string values and object keys. Walks the structure rather than the
 * serialised text, so a literal backslash + "u0000" survives.
 */
export function stripNul<T>(value: T): T {
  return strip(value) as T;
}

function strip(value: unknown): unknown {
  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) return value.map(strip);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [clean(k), strip(v)]));
  }
  return value;
}

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
    for (const raw of entries) {
      const entry = stripNul(raw);
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

/**
 * Entries in append order, or null when nothing was ever written for the key.
 *
 * Matches on (session_id, subpath) only; `project_key` is informational. The SDK derives it from
 * the container's cwd, which we cannot set, so if cwd ever changed between deploys a
 * project-scoped load would return null for a session `sessionHasEntries` (session_id only) says
 * exists. Check, load and delete share one notion of identity; session ids are UUIDs.
 */
export async function loadEntries(key: EntryKey): Promise<Record<string, unknown>[] | null> {
  const rows = await db
    .select({ entry: sessionEntries.entry })
    .from(sessionEntries)
    .where(
      and(eq(sessionEntries.sessionId, key.sessionId), eq(sessionEntries.subpath, subpathOf(key))),
    )
    .orderBy(asc(sessionEntries.id));
  return rows.length === 0 ? null : rows.map((r) => r.entry);
}

/**
 * No `subpath` deletes the whole session, every subpath included (the SDK's `delete` contract).
 * Matches on session_id (+ subpath), ignoring `project_key`, for the same reason as `loadEntries`.
 */
export async function deleteEntries(key: EntryKey): Promise<void> {
  const scope = [eq(sessionEntries.sessionId, key.sessionId)];
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
