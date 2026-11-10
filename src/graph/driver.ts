import neo4j, { type Driver, type Session } from 'neo4j-driver';
import type { Env } from '../config/env.js';

export type GraphErrorCategory = 'unavailable' | 'authentication' | 'timeout' | 'query' | 'unknown';

export interface GraphStatus {
  available: boolean;
  lastErrorCategory: GraphErrorCategory | null;
  failureCount: number;
}

const status: GraphStatus = { available: false, lastErrorCategory: null, failureCount: 0 };
let writer: Driver | null = null;
let reader: Driver | null = null;
let databaseName = 'neo4j';

export function configuredWriter(): Driver {
  if (!writer) throw new Error('Graph writer is not configured');
  return writer;
}

export function graphErrorCategory(error: unknown): GraphErrorCategory {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (/auth|unauthorized|credentials/i.test(code)) return 'authentication';
  if (/timeout|timed.?out/i.test(code)) return 'timeout';
  if (/syntax|statement|clienterror/i.test(code)) return 'query';
  if (/serviceunavailable|sessionexpired|connect|routing/i.test(code)) return 'unavailable';
  return 'unknown';
}

export function recordGraphFailure(error: unknown): GraphErrorCategory {
  const category = graphErrorCategory(error);
  status.available = false;
  status.lastErrorCategory = category;
  status.failureCount += 1;
  return category;
}

export function markGraphAvailable(): void {
  status.available = true;
  status.lastErrorCategory = null;
}

export function getGraphStatus(): GraphStatus {
  return { ...status };
}

export function configureGraph(
  env: Pick<
    Env,
    | 'NEO4J_URI'
    | 'NEO4J_USERNAME'
    | 'NEO4J_PASSWORD'
    | 'NEO4J_READER_USERNAME'
    | 'NEO4J_READER_PASSWORD'
    | 'NEO4J_DATABASE'
  >,
): void {
  databaseName = env.NEO4J_DATABASE;
  const options = { maxTransactionRetryTime: 1000, connectionAcquisitionTimeout: 3000 };
  writer = neo4j.driver(
    env.NEO4J_URI,
    neo4j.auth.basic(env.NEO4J_USERNAME, env.NEO4J_PASSWORD),
    options,
  );
  reader = neo4j.driver(
    env.NEO4J_URI,
    neo4j.auth.basic(
      env.NEO4J_READER_USERNAME ?? env.NEO4J_USERNAME,
      env.NEO4J_READER_PASSWORD ?? env.NEO4J_PASSWORD,
    ),
    options,
  );
}

export function writerSession(): Session {
  if (!writer) throw new Error('Graph writer is not configured');
  return writer.session({ database: databaseName, defaultAccessMode: neo4j.session.WRITE });
}

export function readerSession(): Session {
  if (!reader) throw new Error('Graph reader is not configured');
  return reader.session(readerSessionOptions());
}

export function readerSessionOptions() {
  return { database: databaseName, defaultAccessMode: neo4j.session.READ } as const;
}

export async function closeGraphDrivers(): Promise<void> {
  const clients = [writer, reader].filter((driver): driver is Driver => driver !== null);
  writer = null;
  reader = null;
  await Promise.all(clients.map((driver) => driver.close()));
  status.available = false;
}

export function graphDatabaseName(): string {
  return databaseName;
}
