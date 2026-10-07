import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { loadEnv } from '../config/env.js';
import * as schema from './schema.js';

const env = loadEnv();
export const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
export const db = drizzle(pool, { schema });

export interface DbConnectionTarget {
  host: string;
  port: number;
  database: string;
  user: string;
}

/** Exposes only the target fields needed for eval isolation checks; never returns credentials. */
export function getPoolTarget(): DbConnectionTarget {
  try {
    const connectionString = pool.options.connectionString;
    if (typeof connectionString !== 'string') throw new Error();
    const target = new URL(connectionString);
    const database = decodeURIComponent(target.pathname.slice(1));
    const user = decodeURIComponent(target.username);
    if (!database || !user || target.search) throw new Error();
    return {
      host: target.hostname.toLowerCase(),
      port: Number(target.port || 5432),
      database,
      user,
    };
  } catch {
    throw new Error('Unable to inspect database pool target');
  }
}
