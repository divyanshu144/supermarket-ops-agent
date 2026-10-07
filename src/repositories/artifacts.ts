import { basename } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { generatedArtifacts, stores } from '../db/schema.js';

export async function registerGeneratedArtifact(input: {
  artifactId: string;
  storeId: bigint;
  path: string;
  billId?: string;
}): Promise<void> {
  const fileName = basename(input.path);
  if (!fileName || fileName === '.' || fileName === '..') {
    throw new Error('Invalid generated artifact path');
  }
  await db.insert(generatedArtifacts).values({
    artifactId: input.artifactId,
    storeId: input.storeId,
    fileName,
    billId: input.billId ?? null,
  });
}

/** Updates one store's artifact inactivity clock under the same lock used by retention. */
export async function markGeneratedArtifactsActive(
  storeId: bigint,
  now = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.select({ id: stores.id }).from(stores).where(eq(stores.id, storeId)).for('update');
    await tx
      .update(generatedArtifacts)
      .set({ lastActivityAt: now })
      .where(eq(generatedArtifacts.storeId, storeId));
  });
}
