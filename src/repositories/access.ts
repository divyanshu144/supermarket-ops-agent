import { createHash, randomInt } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { inviteCodes, stores } from '../db/schema.js';
import { provisionStore } from './stores.js';

// Lowercase, no 0/o/1/i/l: a code gets read off one phone and typed into another.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LENGTH = 12;

function normalise(code: string): string {
  return code.trim().toLowerCase();
}

function hashCode(code: string): string {
  return createHash('sha256').update(normalise(code)).digest('hex');
}

function generateCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** A chat is allowed to use the bot exactly when it owns a store. */
export async function hasStore(chatId: bigint): Promise<boolean> {
  const rows = await db
    .select({ id: stores.id })
    .from(stores)
    .where(eq(stores.id, chatId))
    .limit(1);
  return rows.length > 0;
}

/** Returns the plaintext code once. Only its hash is persisted. */
export async function createInvite(): Promise<{ id: string; code: string }> {
  const code = generateCode();
  const [row] = await db
    .insert(inviteCodes)
    .values({ codeHash: hashCode(code) })
    .returning({ id: inviteCodes.id });
  return { id: row!.id, code };
}

export type RedeemResult = 'redeemed' | 'invalid';

/**
 * Redeems a code and provisions the caller's store.
 *
 * The claim is one conditional UPDATE, so two simultaneous redemptions cannot both succeed —
 * not a read-then-write. If provisioning then fails before the chat has a store, the code is released: a database blip
 * must not cost the owner their only invite. If the store row already exists, the code stays used.
 */
export async function redeemInvite(code: string, chatId: bigint): Promise<RedeemResult> {
  const claimed = await db
    .update(inviteCodes)
    .set({ usedByChat: chatId, usedAt: sql`now()` })
    .where(
      and(
        eq(inviteCodes.codeHash, hashCode(code)),
        isNull(inviteCodes.usedAt),
        isNull(inviteCodes.revokedAt),
      ),
    )
    .returning({ id: inviteCodes.id });

  if (claimed.length === 0) return 'invalid';

  try {
    await provisionStore(chatId);
  } catch (error) {
    // Release the code only if the chat still has NO store. provisionStore can fail after the
    // store row committed (seeding); the chat then already owns a store, and releasing the code
    // would let another chat redeem it too: one invite, two stores. A secondary failure here
    // must not mask the original error.
    try {
      if (!(await hasStore(chatId))) {
        await db
          .update(inviteCodes)
          .set({ usedByChat: null, usedAt: null })
          .where(eq(inviteCodes.id, claimed[0]!.id));
      }
    } catch {
      // swallowed: the original error is what the caller needs
    }
    throw error;
  }
  return 'redeemed';
}

/**
 * Revokes an unredeemed code. A code that has already created a store is left alone: revoking
 * it must not silently orphan a shop that is mid-use. Returns whether anything was revoked.
 */
export async function revokeInvite(id: string): Promise<boolean> {
  const rows = await db
    .update(inviteCodes)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(inviteCodes.id, id), isNull(inviteCodes.usedAt), isNull(inviteCodes.revokedAt)))
    .returning({ id: inviteCodes.id });
  return rows.length > 0;
}

export interface InviteRow {
  id: string;
  createdAt: Date;
  usedByChat: bigint | null;
  usedAt: Date | null;
  revokedAt: Date | null;
}

export async function listInvites(): Promise<InviteRow[]> {
  return db
    .select({
      id: inviteCodes.id,
      createdAt: inviteCodes.createdAt,
      usedByChat: inviteCodes.usedByChat,
      usedAt: inviteCodes.usedAt,
      revokedAt: inviteCodes.revokedAt,
    })
    .from(inviteCodes)
    .orderBy(desc(inviteCodes.createdAt));
}
