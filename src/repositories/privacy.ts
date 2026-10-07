import { and, eq, inArray, isNotNull, notExists, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  auditLog,
  bills,
  billItems,
  generatedArtifacts,
  idempotencyKeys,
  khataAccounts,
  khataEntries,
  pendingActions,
  preferences,
  processedUpdates,
  products,
  sessionEntries,
  sessions,
  stockMovements,
  stores,
  usage,
} from '../db/schema.js';

export type StoreExportResult =
  | { status: 'forbidden' }
  | { status: 'unattributed_transcripts' }
  | { status: 'ready'; data: StoreExportData };

export interface StoreExportData {
  manifest: {
    format: 'supermarket-ops-agent-store-export';
    version: 1;
    generatedAt: string;
    recordCounts: Record<string, number>;
    omitted: string[];
  };
  store: typeof stores.$inferSelect;
  products: (typeof products.$inferSelect)[];
  bills: (typeof bills.$inferSelect)[];
  billItems: (typeof billItems.$inferSelect)[];
  khataAccounts: (typeof khataAccounts.$inferSelect)[];
  khataEntries: (typeof khataEntries.$inferSelect)[];
  stockMovements: (typeof stockMovements.$inferSelect)[];
  generatedArtifacts: (typeof generatedArtifacts.$inferSelect)[];
  preferences: (typeof preferences.$inferSelect)[];
  sessions: (typeof sessions.$inferSelect)[];
  transcripts: (typeof sessionEntries.$inferSelect)[];
  usage: (typeof usage.$inferSelect)[];
  idempotencyKeys: (typeof idempotencyKeys.$inferSelect)[];
  pendingActions: Array<{
    id: string;
    storeId: bigint;
    ownerUserId: bigint;
    originatingUpdateId: bigint;
    tool: string;
    arguments: Record<string, unknown>;
    billFingerprint: string | null;
    status: (typeof pendingActions.$inferSelect)['status'];
    createdAt: Date;
    expiresAt: Date;
    processingAt: Date | null;
    confirmedUpdateId: bigint | null;
    outcome: string | null;
  }>;
  auditLog: (typeof auditLog.$inferSelect)[];
  processedUpdates: (typeof processedUpdates.$inferSelect)[];
}

/**
 * Builds a consistent, owner-only snapshot. Transcript rows without a session-to-store mapping
 * make the export fail closed because their tenant cannot be determined safely.
 */
export async function collectStoreExport(
  storeId: bigint,
  ownerUserId: bigint,
): Promise<StoreExportResult> {
  if (storeId <= 0n || ownerUserId <= 0n) return { status: 'forbidden' };

  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read read only`);
    const [store] = await tx.select().from(stores).where(eq(stores.id, storeId)).limit(1);
    if (!store || store.ownerUserId === null || store.ownerUserId !== ownerUserId) {
      return { status: 'forbidden' };
    }

    const orphan = await tx
      .select({ id: sessionEntries.id })
      .from(sessionEntries)
      .where(
        notExists(
          tx
            .select({ storeId: sessions.storeId })
            .from(sessions)
            .where(eq(sessions.agentSessionId, sessionEntries.sessionId)),
        ),
      )
      .limit(1);
    if (orphan.length > 0) return { status: 'unattributed_transcripts' };

    const storeSessions = await tx.select().from(sessions).where(eq(sessions.storeId, storeId));
    const sessionIds = storeSessions.map((session) => session.agentSessionId);
    if (sessionIds.length > 0) {
      const mappedSessions = await tx
        .select({ storeId: sessions.storeId, agentSessionId: sessions.agentSessionId })
        .from(sessions)
        .where(inArray(sessions.agentSessionId, sessionIds));
      if (mappedSessions.some((session) => session.storeId !== storeId)) {
        return { status: 'unattributed_transcripts' };
      }
    }
    const transcripts =
      sessionIds.length === 0
        ? []
        : await tx
            .select()
            .from(sessionEntries)
            .where(inArray(sessionEntries.sessionId, sessionIds))
            .orderBy(sessionEntries.id);
    const storeBills = await tx.select().from(bills).where(eq(bills.storeId, storeId));
    const billIds = storeBills.map((bill) => bill.id);
    const items =
      billIds.length === 0
        ? []
        : await tx.select().from(billItems).where(inArray(billItems.billId, billIds));
    const accounts = await tx
      .select()
      .from(khataAccounts)
      .where(eq(khataAccounts.storeId, storeId));
    const accountIds = accounts.map((account) => account.id);
    const entries =
      accountIds.length === 0
        ? []
        : await tx.select().from(khataEntries).where(inArray(khataEntries.accountId, accountIds));
    const storeProducts = await tx.select().from(products).where(eq(products.storeId, storeId));
    const artifacts = await tx
      .select()
      .from(generatedArtifacts)
      .where(eq(generatedArtifacts.storeId, storeId));
    const movements = await tx
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.storeId, storeId));
    const storePreferences = await tx
      .select()
      .from(preferences)
      .where(eq(preferences.storeId, storeId));
    const storeUsage = await tx.select().from(usage).where(eq(usage.storeId, storeId));
    const keys = await tx
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.storeId, storeId));
    const actions = await tx
      .select({
        id: pendingActions.id,
        storeId: pendingActions.storeId,
        ownerUserId: pendingActions.ownerUserId,
        originatingUpdateId: pendingActions.originatingUpdateId,
        tool: pendingActions.tool,
        arguments: pendingActions.arguments,
        billFingerprint: pendingActions.billFingerprint,
        status: pendingActions.status,
        createdAt: pendingActions.createdAt,
        expiresAt: pendingActions.expiresAt,
        processingAt: pendingActions.processingAt,
        confirmedUpdateId: pendingActions.confirmedUpdateId,
        outcome: pendingActions.outcome,
      })
      .from(pendingActions)
      .where(eq(pendingActions.storeId, storeId));
    const audit = await tx.select().from(auditLog).where(eq(auditLog.storeId, storeId));
    const updates = await tx
      .select()
      .from(processedUpdates)
      .where(eq(processedUpdates.chatId, storeId));

    const data: StoreExportData = {
      manifest: {
        format: 'supermarket-ops-agent-store-export',
        version: 1,
        generatedAt: new Date().toISOString(),
        recordCounts: {},
        omitted: [
          'invite code hashes and unredeemed invite codes',
          'pending confirmation callback IDs and argument hashes',
          'transcript rows whose store ownership cannot be determined (export fails closed if any exist)',
          'generated invoice and deck file contents (indexed artifact metadata is exported; unindexed historical files have no store ownership mapping)',
          'data held by Telegram and AI providers',
        ],
      },
      store,
      products: storeProducts,
      bills: storeBills,
      billItems: items,
      khataAccounts: accounts,
      khataEntries: entries,
      stockMovements: movements,
      generatedArtifacts: artifacts,
      preferences: storePreferences,
      sessions: storeSessions,
      transcripts,
      usage: storeUsage,
      idempotencyKeys: keys,
      pendingActions: actions,
      auditLog: audit,
      processedUpdates: updates,
    };
    data.manifest.recordCounts = {
      store: 1,
      products: data.products.length,
      bills: data.bills.length,
      billItems: data.billItems.length,
      khataAccounts: data.khataAccounts.length,
      khataEntries: data.khataEntries.length,
      stockMovements: data.stockMovements.length,
      generatedArtifacts: data.generatedArtifacts.length,
      preferences: data.preferences.length,
      sessions: data.sessions.length,
      transcripts: data.transcripts.length,
      usage: data.usage.length,
      idempotencyKeys: data.idempotencyKeys.length,
      pendingActions: data.pendingActions.length,
      auditLog: data.auditLog.length,
      processedUpdates: data.processedUpdates.length,
    };
    return { status: 'ready', data };
  });
}

export type CustomerPseudonymisationPreview =
  | { status: 'not_found' }
  | { status: 'cross_store_link' }
  | { status: 'preview'; accountId: string; accounts: 1; bills: number; notes: number };

async function linkedBillIds(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  storeId: bigint,
  accountId: string,
  customerName: string,
): Promise<string[]> {
  const named = await tx
    .select({ id: bills.id })
    .from(bills)
    .where(
      and(eq(bills.storeId, storeId), sql`lower(${bills.customerName}) = lower(${customerName})`),
    );
  const referenced = await tx
    .select({ billId: khataEntries.billId })
    .from(khataEntries)
    .where(and(eq(khataEntries.accountId, accountId), isNotNull(khataEntries.billId)));
  const referencedIds = referenced.flatMap((row) => (row.billId === null ? [] : [row.billId]));
  if (referencedIds.length > 0) {
    const linked = await tx
      .select({ id: bills.id, storeId: bills.storeId })
      .from(bills)
      .where(inArray(bills.id, referencedIds));
    if (linked.some((bill) => bill.storeId !== storeId)) throw new Error('cross_store_link');
    named.push(...linked.map((bill) => ({ id: bill.id })));
  }
  return [...new Set(named.map((bill) => bill.id))];
}

/** Exact-name, store-scoped preview. It returns counts only, never the matched phone or notes. */
export async function previewCustomerPseudonymisation(
  storeId: bigint,
  customerName: string,
): Promise<CustomerPseudonymisationPreview> {
  const name = customerName.trim();
  if (!name) return { status: 'not_found' };
  try {
    return await db.transaction(async (tx) => {
      const [account] = await tx
        .select()
        .from(khataAccounts)
        .where(
          and(
            eq(khataAccounts.storeId, storeId),
            sql`lower(${khataAccounts.customerName}) = lower(${name})`,
          ),
        )
        .limit(1);
      if (!account) return { status: 'not_found' };
      const billIds = await linkedBillIds(tx, storeId, account.id, account.customerName);
      const notes = await tx
        .select({ id: khataEntries.id })
        .from(khataEntries)
        .where(and(eq(khataEntries.accountId, account.id), isNotNull(khataEntries.note)));
      return {
        status: 'preview',
        accountId: account.id,
        accounts: 1,
        bills: billIds.length,
        notes: notes.length,
      };
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'cross_store_link') {
      return { status: 'cross_store_link' };
    }
    throw error;
  }
}

export type CustomerPseudonymisationResult =
  | { status: 'not_found' }
  | { status: 'cross_store_link' }
  | { status: 'pseudonymised'; outcome: 'pseudonymised' };

/** Replaces direct identifiers in one store while preserving its ledger and bill amounts. */
export async function pseudonymiseCustomerAccount(
  storeId: bigint,
  accountId: string,
): Promise<CustomerPseudonymisationResult> {
  try {
    return await db.transaction(async (tx) => {
      const [account] = await tx
        .select()
        .from(khataAccounts)
        .where(and(eq(khataAccounts.storeId, storeId), eq(khataAccounts.id, accountId)))
        .for('update')
        .limit(1);
      if (!account) return { status: 'not_found' };
      const billIds = await linkedBillIds(tx, storeId, account.id, account.customerName);
      const placeholder = `Former customer ${account.id}`;
      await tx
        .update(khataAccounts)
        .set({ customerName: placeholder, phone: null })
        .where(and(eq(khataAccounts.storeId, storeId), eq(khataAccounts.id, account.id)));
      await tx
        .update(khataEntries)
        .set({ note: null })
        .where(eq(khataEntries.accountId, account.id));
      if (billIds.length > 0) {
        await tx
          .update(bills)
          .set({ customerName: placeholder, paymentRef: null })
          .where(and(eq(bills.storeId, storeId), inArray(bills.id, billIds)));
      }
      return { status: 'pseudonymised', outcome: 'pseudonymised' };
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'cross_store_link') {
      return { status: 'cross_store_link' };
    }
    throw error;
  }
}
