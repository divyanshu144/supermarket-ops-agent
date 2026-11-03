import pg from 'pg';
import { readUsageReport } from '../repositories/usage-report.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set DATABASE_URL to a read-only PostgreSQL database.');

const client = new pg.Client({ connectionString: databaseUrl });
try {
  await client.connect();
  const report = await readUsageReport(client);
  console.log(
    JSON.stringify(
      {
        source: 'local PostgreSQL (read-only query)',
        observedStoreCount: report.observedStoreCount,
        sample: `${report.observedStoreCount} store(s) represented by database rows`,
        storeIdentifiersPrinted: false,
        note: 'Daily rows aggregate by IST day. Tool errors count thrown tool handlers; cache hit rate excludes disabled/ineligible requests. Replay counts are available from this migration onward.',
        days: report.days,
      },
      null,
      2,
    ),
  );
} finally {
  await client.end().catch(() => undefined);
}
