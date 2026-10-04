import { pool } from './client.js';

/** Arbitrary, but must be unique among advisory-lock users within this database. */
export const INSTANCE_LOCK_KEY = 7_364_000_001n;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Process-lifetime lock: a new instance waits here until the previous one has exited (its
 * connection closes, so Postgres frees the lock). The dedicated client is held until the
 * returned release function runs; process exit releases it in production.
 */
export async function acquireInstanceLock(
  options: { pollMs?: number; timeoutMs?: number; onLost?: () => void } = {},
): Promise<() => Promise<void>> {
  const { pollMs = 1000, timeoutMs = 180_000, onLost } = options;
  const client = await pool.connect();
  let acquired = false;
  let released = false;
  let lost = false;
  // The lock lives and dies with this connection. If it errors or closes after acquisition the
  // lock is gone, and a new instance could start alongside us; tell the caller, once. Fixed text
  // only: a connection error message can embed connection details.
  const lose = () => {
    if (!acquired || released || lost) return;
    lost = true;
    onLost?.();
  };
  client.on('error', () => {
    console.error(JSON.stringify({ scope: 'instance-lock', warning: 'lock connection error' }));
    lose();
  });
  client.on('end', () => {
    console.error(JSON.stringify({ scope: 'instance-lock', warning: 'lock connection closed' }));
    lose();
  });
  try {
    // Best-effort: without keepalives a vanished client host can leave the server backend (and so
    // the lock) alive for the OS keepalive time, blocking the next instance.
    await client.query('SET tcp_keepalives_idle = 30');
  } catch {
    /* not supported on this server or transport; the lock still works */
  }
  const deadline = Date.now() + timeoutMs;
  let waited = false;
  try {
    for (;;) {
      const res = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [INSTANCE_LOCK_KEY.toString()],
      );
      if (res.rows[0]?.locked) break;
      if (Date.now() >= deadline) {
        throw new Error('Could not acquire the instance lock: another instance is still running');
      }
      if (!waited) {
        waited = true;
        console.log('Waiting for the previous instance to exit…');
      }
      await sleep(pollMs);
    }
  } catch (err) {
    client.release();
    throw err;
  }
  acquired = true;
  console.log('Instance lock acquired.');
  return async () => {
    released = true;
    if (lost) {
      // Dead connection: nothing to unlock; destroy the client rather than return it to the pool.
      client.release(true);
      return;
    }
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [INSTANCE_LOCK_KEY.toString()]);
    } finally {
      client.release();
    }
  };
}
