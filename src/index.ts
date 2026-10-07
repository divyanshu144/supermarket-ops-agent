import 'dotenv/config';
import { loadEnv } from './config/env.js';
import { bot } from './telegram/bot.js';
import { acquireInstanceLock } from './db/instance-lock.js';
import { runMigrations } from './db/migrate.js';
import { expireInFlightClaims } from './repositories/updates.js';
import { beginDrain } from './telegram/drain.js';
import { startRetentionScheduler } from './retention/worker.js';

// Fail fast before opening any connection or long-poll.
const env = loadEnv();

// A managed Postgres arrives empty. Migrate before accepting a single update, or the first
// message fails on a missing table.
console.log('Applying migrations…');
await runMigrations();
console.log('Migrations up to date.');

// A deploy can start this process while the previous one is still draining a turn. Wait for it to
// exit (its connection closes, freeing the lock) before touching claims or polling.
let shuttingDown = false;

await acquireInstanceLock({
  // The lock connection died: the lock is gone and a new instance may already be starting. Stop
  // taking new work, let the turn in flight finish, then exit non-zero so Railway's restart
  // policy brings us back to re-acquire the lock. Not when a normal shutdown is already running.
  onLost: () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(
      JSON.stringify({ scope: 'instance-lock', warning: 'lock lost; draining and exiting' }),
    );
    void beginDrain(env.SHUTDOWN_GRACE_MS).then(() => process.exit(1));
  },
});

// The instance lock guarantees the previous process has exited, so every claim still 'claimed'
// now belongs to a dead process. Expire them so Telegram's redelivery of those updates is
// reclaimed instead of dropped as "in flight".
const expired = await expireInFlightClaims();
if (expired > 0) console.log(`Expired ${expired} in-flight claim(s) from the previous process.`);

// The single-instance lock and claim recovery are complete. Run app-owned retention in the
// background so cleanup never delays Telegram polling or makes lock waiting look unhealthy.
startRetentionScheduler(env.APP_DATA_RETENTION_DAYS);

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, finishing the turn in flight…`);
  const outcome = await beginDrain(env.SHUTDOWN_GRACE_MS);
  console.log(
    outcome === 'drained'
      ? 'Idle, exiting.'
      : 'Grace period elapsed with a turn still running; exiting. Telegram will redeliver it.',
  );
  // Deliberately NOT bot.stop(): it confirms the update being handled (offset = last tried + 1),
  // so a turn we cut off here would be lost instead of redelivered. See telegram/drain.ts.
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

console.log('Starting kirana agent (long-polling)…');
await bot.start({
  onStart: (info) => console.log(`Listening as @${info.username}`),
});
