import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idempotencyKeys, khataAccounts, khataEntries } from '../db/schema.js';
import { formatPaise } from '../domain/money.js';

/**
 * Khata is the kirana's informal credit book, and its two directions are deliberately not
 * symmetric.
 *
 * CHARGING an unrecognised name opens an account, because that is exactly how a shopkeeper
 * works — a neighbour asks to put it on credit and the book gets a new page. SETTLING an
 * unrecognised name refuses, because money arriving against a customer who does not exist is
 * a mistake every time, and silently opening an account with a negative balance would hide it.
 */

export interface KhataAccountView {
  id: string;
  customerName: string;
  phone: string | null;
  balancePaise: number;
  balance: string;
}

export type BalanceResult =
  | { status: 'found'; account: KhataAccountView }
  | { status: 'ambiguous'; candidates: Array<{ name: string; balance: string }> }
  | { status: 'not_found'; query: string };

function view(row: typeof khataAccounts.$inferSelect): KhataAccountView {
  return {
    id: row.id,
    customerName: row.customerName,
    phone: row.phone,
    balancePaise: row.balancePaise,
    balance: formatPaise(row.balancePaise),
  };
}

export async function findAccount(storeId: bigint, query: string): Promise<BalanceResult> {
  const rows = await db
    .select()
    .from(khataAccounts)
    .where(
      and(
        eq(khataAccounts.storeId, storeId),
        ilike(khataAccounts.customerName, `%${query.trim()}%`),
      ),
    )
    .limit(10);

  if (rows.length === 0) return { status: 'not_found', query };
  if (rows.length === 1) return { status: 'found', account: view(rows[0]!) };
  return {
    status: 'ambiguous',
    candidates: rows.map((r) => ({ name: r.customerName, balance: formatPaise(r.balancePaise) })),
  };
}

export type ChargeResult = {
  status: 'charged';
  customerName: string;
  amount: string;
  newBalance: string;
  accountOpened: boolean;
};

/** Opens the account if the name is new — see the note at the top of this file. */
export async function chargeAccount(
  storeId: bigint,
  input: { customerName: string; amountPaise: number; note?: string },
): Promise<ChargeResult> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(khataAccounts)
      .where(
        and(
          eq(khataAccounts.storeId, storeId),
          sql`lower(${khataAccounts.customerName}) = lower(${input.customerName})`,
        ),
      )
      .for('update')
      .limit(1);

    let accountId: string;
    let opened = false;

    if (existing.length === 0) {
      const [created] = await tx
        .insert(khataAccounts)
        .values({ storeId, customerName: input.customerName, balancePaise: 0 })
        .returning();
      accountId = created!.id;
      opened = true;
    } else {
      accountId = existing[0]!.id;
    }

    await tx.insert(khataEntries).values({
      accountId,
      kind: 'charge',
      amountPaise: input.amountPaise,
      note: input.note ?? null,
    });

    const [updated] = await tx
      .update(khataAccounts)
      .set({ balancePaise: sql`${khataAccounts.balancePaise} + ${input.amountPaise}` })
      .where(eq(khataAccounts.id, accountId))
      .returning();

    return {
      status: 'charged' as const,
      customerName: updated!.customerName,
      amount: formatPaise(input.amountPaise),
      newBalance: formatPaise(updated!.balancePaise),
      accountOpened: opened,
    };
  });
}

export type SettleResult =
  | { status: 'settled'; customerName: string; amount: string; newBalance: string }
  | { status: 'unknown_customer'; query: string }
  | { status: 'ambiguous'; candidates: Array<{ name: string; balance: string }> }
  | { status: 'exceeds_balance'; customerName: string; balance: string; offered: string };

/** Refuses an unknown customer, and refuses to overpay without an explicit confirmation. */
export async function settleAccount(
  storeId: bigint,
  input: {
    customerQuery: string;
    amountPaise: number;
    note?: string;
    allowOverpay?: boolean;
    idempotencyKey?: string;
  },
): Promise<SettleResult> {
  const found = await findAccount(storeId, input.customerQuery);
  if (found.status === 'not_found') {
    return { status: 'unknown_customer', query: input.customerQuery };
  }
  if (found.status === 'ambiguous') return found;

  return db.transaction(async (tx) => {
    if (input.idempotencyKey) {
      const claimed = await tx
        .insert(idempotencyKeys)
        .values({
          storeId,
          key: input.idempotencyKey,
          operation: 'settle_khata',
          result: {},
        })
        .onConflictDoNothing()
        .returning({ key: idempotencyKeys.key });
      if (claimed.length === 0) {
        const [existing] = await tx
          .select({ result: idempotencyKeys.result })
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.storeId, storeId),
              eq(idempotencyKeys.key, input.idempotencyKey),
            ),
          );
        return existing!.result as SettleResult;
      }
    }

    const [locked] = await tx
      .select()
      .from(khataAccounts)
      .where(eq(khataAccounts.id, found.account.id))
      .for('update')
      .limit(1);

    if (!input.allowOverpay && input.amountPaise > locked!.balancePaise) {
      return {
        status: 'exceeds_balance' as const,
        customerName: locked!.customerName,
        balance: formatPaise(locked!.balancePaise),
        offered: formatPaise(input.amountPaise),
      };
    }

    await tx.insert(khataEntries).values({
      accountId: locked!.id,
      kind: 'payment',
      amountPaise: input.amountPaise,
      note: input.note ?? null,
    });

    const [updated] = await tx
      .update(khataAccounts)
      .set({ balancePaise: sql`${khataAccounts.balancePaise} - ${input.amountPaise}` })
      .where(eq(khataAccounts.id, locked!.id))
      .returning();

    const result: SettleResult = {
      status: 'settled' as const,
      customerName: updated!.customerName,
      amount: formatPaise(input.amountPaise),
      newBalance: formatPaise(updated!.balancePaise),
    };
    if (input.idempotencyKey) {
      await tx
        .update(idempotencyKeys)
        .set({ result })
        .where(
          and(eq(idempotencyKeys.storeId, storeId), eq(idempotencyKeys.key, input.idempotencyKey)),
        );
    }
    return result;
  });
}

export interface StatementLine {
  kind: 'charge' | 'payment' | 'adjustment';
  amount: string;
  note: string | null;
  at: string;
}

export type StatementResult =
  | { status: 'found'; customerName: string; balance: string; entries: StatementLine[] }
  | { status: 'unknown_customer'; query: string }
  | { status: 'ambiguous'; candidates: Array<{ name: string; balance: string }> };

export async function accountStatement(
  storeId: bigint,
  input: { customerQuery: string; limit?: number },
): Promise<StatementResult> {
  const found = await findAccount(storeId, input.customerQuery);
  if (found.status === 'not_found') {
    return { status: 'unknown_customer', query: input.customerQuery };
  }
  if (found.status === 'ambiguous') return found;

  const rows = await db
    .select()
    .from(khataEntries)
    .where(eq(khataEntries.accountId, found.account.id))
    .orderBy(desc(khataEntries.createdAt))
    .limit(input.limit ?? 15);

  return {
    status: 'found',
    customerName: found.account.customerName,
    balance: found.account.balance,
    entries: rows.map((r) => ({
      kind: r.kind,
      amount: formatPaise(r.amountPaise),
      note: r.note,
      at: r.createdAt.toISOString(),
    })),
  };
}

export async function listAccounts(storeId: bigint): Promise<KhataAccountView[]> {
  const rows = await db
    .select()
    .from(khataAccounts)
    .where(eq(khataAccounts.storeId, storeId))
    .orderBy(desc(khataAccounts.balancePaise));
  return rows.map(view);
}
