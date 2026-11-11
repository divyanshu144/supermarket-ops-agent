import 'dotenv/config';
import { pool } from '../db/client.js';
import { loadEnv } from '../config/env.js';
import { backfillGraphHistory } from '../graph/backfill.js';
import { configureGraph, closeGraphDrivers, writerSession } from '../graph/driver.js';
import { ensureGraphSchema } from '../graph/schema.js';

const stateFile = process.env.GRAPH_BACKFILL_STATE_FILE;
if (!stateFile)
  throw new Error('GRAPH_BACKFILL_STATE_FILE must point to a durable checkpoint file');

configureGraph(loadEnv());
try {
  const schemaSession = writerSession();
  try {
    await ensureGraphSchema(schemaSession);
  } finally {
    await schemaSession.close();
  }
  const projected = await backfillGraphHistory(
    (text, values) => pool.query(text, values),
    stateFile,
  );
  process.stdout.write(`Projected ${projected} source records.\n`);
} finally {
  await closeGraphDrivers();
  await pool.end();
}
