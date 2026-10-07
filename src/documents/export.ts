import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ARTIFACT_DIR } from './artifacts.js';
import {
  collectStoreExport,
  type StoreExportData,
  type StoreExportResult,
} from '../repositories/privacy.js';

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

export type StoreExportArtifactResult =
  | Exclude<StoreExportResult, { status: 'ready' }>
  | { status: 'generated'; path: string; filename: 'store-export.json' };

export async function exportStoreArtifact(
  storeId: bigint,
  ownerUserId: bigint,
  artifactDir = ARTIFACT_DIR,
): Promise<StoreExportArtifactResult> {
  const result = await collectStoreExport(storeId, ownerUserId);
  if (result.status !== 'ready') return result;
  return writeExport(result.data, artifactDir);
}

async function writeExport(
  data: StoreExportData,
  artifactDir: string,
): Promise<{
  status: 'generated';
  path: string;
  filename: 'store-export.json';
}> {
  await mkdir(artifactDir, { recursive: true });
  const path = join(artifactDir, `${randomUUID()}-store-export.json`);
  try {
    await writeFile(path, JSON.stringify(data, jsonReplacer, 2), { flag: 'wx', mode: 0o600 });
    return { status: 'generated', path, filename: 'store-export.json' };
  } catch (error) {
    await rm(path, { force: true }).catch(() => {});
    throw error;
  }
}
