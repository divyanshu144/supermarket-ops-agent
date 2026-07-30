import 'dotenv/config';
import { loadEnv } from './config/env.js';
import { bot } from './telegram/bot.js';
import { pool } from './db/client.js';

// Fail fast before opening any connection or long-poll.
loadEnv();

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received, stopping…`);
  await bot.stop();
  await pool.end();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

console.log('Starting kirana agent (long-polling)…');
await bot.start({
  onStart: (info) => console.log(`Listening as @${info.username}`),
});
