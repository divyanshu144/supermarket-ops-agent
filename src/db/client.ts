import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { loadEnv } from '../config/env.js';
import * as schema from './schema.js';

const env = loadEnv();
export const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
export const db = drizzle(pool, { schema });
