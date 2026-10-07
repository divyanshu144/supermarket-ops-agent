import { randomBytes, createHash } from 'node:crypto';
import { and, eq, gt, lt, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { auditLog, pendingActions } from '../db/schema.js';

const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const PROCESSING_LEASE_MS = 30 * 1000;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface BillSnapshotLine {
  lineNo: number;
  productId: string;
  qtyBase: number;
  unitPricePaise: number;
  gstRateBps: number;
  hsnCode: string;
}

/** Fingerprint only bill identity and mutable commercial terms, never customer text. */
export function hashBillSnapshot(lines: BillSnapshotLine[]): string {
  return sha256(stableJson([...lines].sort((a, b) => a.lineNo - b.lineNo)));
}

export function hashActionArguments(arguments_: Record<string, unknown>): string {
  return sha256(stableJson(arguments_));
}

export interface PendingActionInput {
  storeId: bigint;
  ownerUserId: bigint;
  originatingUpdateId: bigint;
  tool: string;
  arguments: Record<string, unknown>;
  billFingerprint?: string;
  now?: Date;
}

export async function createPendingAction(input: PendingActionInput): Promise<{
  id: string;
  callbackId: string;
  expiresAt: Date;
}> {
  if (input.storeId <= 0n || input.ownerUserId <= 0n) {
    throw new Error('Pending actions require a private-chat owner and store.');
  }
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + CONFIRMATION_TTL_MS);
  const argumentHash = hashActionArguments(input.arguments);

  for (let attempt = 0; attempt < 3; attempt++) {
    const callbackId = randomBytes(9).toString('base64url');
    const [row] = await db
      .insert(pendingActions)
      .values({
        callbackId,
        storeId: input.storeId,
        ownerUserId: input.ownerUserId,
        originatingUpdateId: input.originatingUpdateId,
        tool: input.tool,
        arguments: input.arguments,
        argumentHash,
        billFingerprint: input.billFingerprint ?? null,
        expiresAt,
      })
      .onConflictDoNothing({ target: pendingActions.callbackId })
      .returning({ id: pendingActions.id, callbackId: pendingActions.callbackId });
    if (row) return { ...row, expiresAt };
  }
  throw new Error('Unable to allocate a confirmation callback id.');
}

export async function claimPendingAction(input: {
  callbackId: string;
  storeId: bigint;
  ownerUserId: bigint;
  updateId: bigint;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const reclaimBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
  const [row] = await db
    .update(pendingActions)
    .set({ status: 'processing', processingAt: now, confirmedUpdateId: input.updateId })
    .where(
      and(
        eq(pendingActions.callbackId, input.callbackId),
        eq(pendingActions.storeId, input.storeId),
        eq(pendingActions.ownerUserId, input.ownerUserId),
        ne(pendingActions.originatingUpdateId, input.updateId),
        gt(pendingActions.expiresAt, now),
        or(
          eq(pendingActions.status, 'pending'),
          and(
            eq(pendingActions.status, 'processing'),
            lt(pendingActions.processingAt, reclaimBefore),
          ),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

export async function completePendingAction(input: {
  id: string;
  storeId: bigint;
  updateId: bigint;
  tool: string;
  action: string;
  outcome: string;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(pendingActions)
      .set({ status: 'confirmed', outcome: input.outcome })
      .where(
        and(
          eq(pendingActions.id, input.id),
          eq(pendingActions.storeId, input.storeId),
          eq(pendingActions.confirmedUpdateId, input.updateId),
          eq(pendingActions.status, 'processing'),
        ),
      )
      .returning({ id: pendingActions.id });
    if (!row) return false;
    await tx.insert(auditLog).values({
      storeId: input.storeId,
      action: input.action,
      tool: input.tool,
      outcome: input.outcome,
      updateId: input.updateId,
    });
    return true;
  });
}

export async function rejectPendingAction(input: {
  id: string;
  storeId: bigint;
  updateId: bigint;
  tool: string;
  action: string;
  outcome: string;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(pendingActions)
      .set({ status: 'cancelled', outcome: input.outcome })
      .where(
        and(
          eq(pendingActions.id, input.id),
          eq(pendingActions.storeId, input.storeId),
          eq(pendingActions.confirmedUpdateId, input.updateId),
          eq(pendingActions.status, 'processing'),
        ),
      )
      .returning({ id: pendingActions.id });
    if (!row) return false;
    await tx.insert(auditLog).values({
      storeId: input.storeId,
      action: input.action,
      tool: input.tool,
      outcome: input.outcome,
      updateId: input.updateId,
    });
    return true;
  });
}

export async function cancelPendingAction(input: {
  callbackId: string;
  storeId: bigint;
  ownerUserId: bigint;
  updateId: bigint;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(pendingActions)
      .set({ status: 'cancelled', confirmedUpdateId: input.updateId, outcome: 'cancelled' })
      .where(
        and(
          eq(pendingActions.callbackId, input.callbackId),
          eq(pendingActions.storeId, input.storeId),
          eq(pendingActions.ownerUserId, input.ownerUserId),
          ne(pendingActions.originatingUpdateId, input.updateId),
          eq(pendingActions.status, 'pending'),
          gt(pendingActions.expiresAt, new Date()),
        ),
      )
      .returning({ tool: pendingActions.tool });
    if (!row) return false;
    await tx.insert(auditLog).values({
      storeId: input.storeId,
      action: 'cancel',
      tool: row.tool,
      outcome: 'cancelled',
      updateId: input.updateId,
    });
    return true;
  });
}

/** Removes expired or completed rows; retained pending actions are still usable until expiry. */
export async function deleteExpiredPendingActions(now = new Date()): Promise<number> {
  const rows = await db
    .delete(pendingActions)
    .where(
      or(
        lt(pendingActions.expiresAt, now),
        sql`${pendingActions.status} in ('confirmed', 'cancelled')`,
      ),
    )
    .returning({ id: pendingActions.id });
  return rows.length;
}
