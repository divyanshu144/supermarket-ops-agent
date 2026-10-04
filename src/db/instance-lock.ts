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
  options: { pollMs?: number; timeoutMs?: number } = {},
): Promise<() => Promise<void>> {
  const { pollMs = 1000, timeoutMs = 180_000 } = options;
  const client = await pool.connect();
  client.on('error', () => {
    console.error(JSON.stringify({ scope: 'instance-lock', warning: 'lock connection error' }));
  });
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
  console.log('Instance lock acquired.');
  return async () => {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [INSTANCE_LOCK_KEY.toString()]);
    } finally {
      client.release();
    }
  };
}
