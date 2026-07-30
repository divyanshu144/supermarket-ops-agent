import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Where generated files land before the Telegram adapter picks them up.
 *
 * Tools never talk to Telegram. They write a file and return a handle; the adapter delivers
 * whatever was produced during the turn. That keeps the agent layer ignorant of the transport
 * and means an artifact can be generated in a test with no bot running at all.
 */
export const ARTIFACT_DIR = process.env.ARTIFACT_DIR ?? join(process.cwd(), 'artifacts');

export interface ArtifactHandle {
  artifactId: string;
  path: string;
  filename: string;
  mime: string;
}

export async function artifactPath(filename: string): Promise<ArtifactHandle> {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const artifactId = randomUUID();
  return {
    artifactId,
    path: join(ARTIFACT_DIR, `${artifactId}-${filename}`),
    filename,
    mime: filename.endsWith('.pdf')
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
}
