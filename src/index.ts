import 'dotenv/config';
import { loadEnv } from './config/env.js';
import { bot } from './telegram/bot.js';
import { runMigrations } from './db/migrate.js';
import { expireInFlightClaims } from './repositories/updates.js';
import { beginDrain } from './telegram/drain.js';

// Fail fast before opening any connection or long-poll.
const env = loadEnv();

// A managed Postgres arrives empty. Migrate before accepting a single update, or the first
// message fails on a missing table.
console.log('Applying migrations…');
await runMigrations();
console.log('Migrations up to date.');

// One replica: any claim still 'claimed' at boot belongs to a process that died mid-turn. Expire
// them so Telegram's redelivery of those updates is reclaimed instead of dropped as "in flight".
const expired = await expireInFlightClaims();
if (expired > 0) console.log(`Expired ${expired} in-flight claim(s) from the previous process.`);

let shuttingDown = false;

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
