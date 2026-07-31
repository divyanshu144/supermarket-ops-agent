import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db } from './client.js';

/**
 * Applies pending migrations at boot.
 *
 * A freshly provisioned managed Postgres is empty, so without this the container starts,
 * connects, accepts a Telegram update and then fails on `relation "processed_updates" does not
 * exist` — which is exactly what happened on the first Railway deploy.
 *
 * Uses drizzle-orm's programmatic migrator rather than the drizzle-kit CLI: drizzle-kit is a
 * dev dependency and is deliberately absent from the production image.
 */
export async function runMigrations(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = join(here, 'migrations');

  await migrate(db, { migrationsFolder });
}
