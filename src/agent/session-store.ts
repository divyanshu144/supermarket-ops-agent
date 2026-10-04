import type { SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import {
  appendEntries,
  deleteEntries,
  loadEntries,
  sessionHasEntries,
} from '../repositories/session-entries.js';

/**
 * Postgres-backed transcript mirror for the Agent SDK's `sessionStore` option.
 *
 * The SDK writes the transcript to local disk first and forwards each batch here; on `resume` it
 * calls `load` before spawning, so a conversation survives a redeploy that wipes the container's
 * disk. `SessionStore` is `@alpha` in the SDK — this adapter is the only place that touches it.
 *
 * `listSessions`, `listSessionSummaries` and `listSubkeys` are deliberately not implemented: we
 * resume by the session id we already store per shop, and we do not use subagent transcripts.
 */
export const postgresSessionStore: SessionStore = {
  async append(key, entries) {
    await appendEntries(key, entries);
  },
  async load(key) {
    return (await loadEntries(key)) as SessionStoreEntry[] | null;
  },
  async delete(key) {
    await deleteEntries(key);
  },
};

/**
 * Whether a stored session id has a mirrored transcript. A session id the store has never seen —
 * every session created before the mirror existed — cannot be resumed on a fresh container.
 */
export async function sessionExists(sessionId: string): Promise<boolean> {
  return sessionHasEntries(sessionId);
}
