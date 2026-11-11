import 'dotenv/config';
import { pool } from '../db/client.js';
import { loadEnv } from '../config/env.js';
import { closeGraphDrivers, configureGraph } from '../graph/driver.js';
import { reconcileGraphStore, reconciliationHasMismatch } from '../graph/reconcile.js';

const storeArg = process.argv[2];
if (!storeArg || !/^\d+$/.test(storeArg)) {
  throw new Error('Usage: pnpm graph:reconcile <storeId>');
}

configureGraph(loadEnv());
try {
  const report = await reconcileGraphStore(BigInt(storeArg));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (reconciliationHasMismatch(report)) process.exitCode = 1;
} finally {
  await closeGraphDrivers();
  await pool.end();
}
