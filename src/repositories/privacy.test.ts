import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import {
  bills,
  khataAccounts,
  khataEntries,
  products,
  sessionEntries,
  sessions,
  stores,
} from '../db/schema.js';
import { collectStoreExport, previewCustomerPseudonymisation } from './privacy.js';
import { exportStoreArtifact } from '../documents/export.js';

const STORE = 999000051n;
const OTHER = 999000052n;
const OWNER = 999000151n;
const OTHER_OWNER = 999000152n;
const ACCOUNT_ID = '1b5db255-b7a9-492e-a1cb-21e945c22215';
const PRODUCT_ID = '2b5db255-b7a9-492e-a1cb-21e945c22215';
const BILL_ID = '3b5db255-b7a9-492e-a1cb-21e945c22215';

beforeEach(async () => {
  await db.delete(sessionEntries).where(eq(sessionEntries.projectKey, 'privacy-export-test'));
  await db.delete(stores).where(and(eq(stores.id, STORE)));
  await db.delete(stores).where(eq(stores.id, OTHER));
  await db.insert(stores).values([
    { id: STORE, ownerUserId: OWNER, name: 'Owner shop', gstin: '27AAAAA0000A1Z5' },
    { id: OTHER, ownerUserId: OTHER_OWNER, name: 'Other shop', gstin: '27BBBBB0000B1Z5' },
  ]);
  await db.insert(products).values([
    {
      id: PRODUCT_ID,
      storeId: STORE,
      name: 'Owner product',
      unit: 'packet',
      hsnCode: '19023010',
      gstRateBps: 1200,
      costPricePaise: 1000,
      mrpPaise: 1500,
      quantityBase: 12,
    },
    {
      storeId: OTHER,
      name: 'Foreign product sentinel',
      unit: 'packet',
      hsnCode: '19023010',
      gstRateBps: 1200,
      costPricePaise: 1000,
      mrpPaise: 1500,
      quantityBase: 88,
    },
  ]);
  await db.insert(bills).values([
    { id: BILL_ID, storeId: STORE, customerName: 'Ramesh', paymentRef: 'PRIVATE-REF' },
    { storeId: OTHER, customerName: 'Foreign customer sentinel' },
  ]);
  await db.insert(khataAccounts).values([
    {
      id: ACCOUNT_ID,
      storeId: STORE,
      customerName: 'Ramesh',
      phone: '9999999999',
      balancePaise: 5000,
    },
    { storeId: OTHER, customerName: 'Foreign customer sentinel', balancePaise: 9900 },
  ]);
  await db.insert(khataEntries).values([
    {
      accountId: ACCOUNT_ID,
      kind: 'charge',
      amountPaise: 5000,
      billId: BILL_ID,
      note: 'private note sentinel',
    },
  ]);
  await db.insert(sessions).values({ storeId: STORE, agentSessionId: 'privacy-export-session' });
  await db.insert(sessionEntries).values({
    projectKey: 'privacy-export-test',
    sessionId: 'privacy-export-session',
    entry: { message: 'owner transcript sentinel' },
  });
});

afterAll(async () => {
  await db.delete(sessionEntries).where(eq(sessionEntries.projectKey, 'privacy-export-test'));
  await db.delete(stores).where(eq(stores.id, STORE));
  await db.delete(stores).where(eq(stores.id, OTHER));
  await pool.end();
});

describe('collectStoreExport', () => {
  it('returns a manifest and only the authenticated store records', async () => {
    const result = await collectStoreExport(STORE, OWNER);

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.data.manifest.format).toBe('supermarket-ops-agent-store-export');
    expect(result.data.manifest.recordCounts.products).toBe(1);
    expect(result.data.manifest.recordCounts.bills).toBe(1);
    expect(result.data.products.map((product) => product.name)).toEqual(['Owner product']);
    expect(result.data.bills.map((bill) => bill.customerName)).toEqual(['Ramesh']);
    expect(result.data.khataEntries[0]!.note).toBe('private note sentinel');
    expect(result.data.transcripts[0]!.entry).toEqual({ message: 'owner transcript sentinel' });
    const serialized = JSON.stringify(result.data, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(serialized).not.toContain('Foreign product sentinel');
    expect(serialized).not.toContain('Foreign customer sentinel');
    expect(result.data.manifest.omitted).toContain(
      'invite code hashes and unredeemed invite codes',
    );
    expect(result.data.manifest.omitted).toContain(
      'generated invoice and deck files (the artifact directory has no store ownership index)',
    );
  });

  it('denies a different Telegram user and a legacy store without an owner', async () => {
    expect(await collectStoreExport(STORE, OTHER_OWNER)).toEqual({ status: 'forbidden' });
    await db.update(stores).set({ ownerUserId: null }).where(eq(stores.id, STORE));
    expect(await collectStoreExport(STORE, OWNER)).toEqual({ status: 'forbidden' });
  });

  it('fails closed when transcript ownership cannot be assigned to any store', async () => {
    await db.insert(sessionEntries).values({
      projectKey: 'privacy-export-test',
      sessionId: 'unmapped-orphan-session',
      entry: { message: 'unattributed transcript sentinel' },
    });

    expect(await collectStoreExport(STORE, OWNER)).toEqual({ status: 'unattributed_transcripts' });
  });

  it('fails closed when the selected customer has a ledger link into another store', async () => {
    const [foreignBill] = await db
      .select({ id: bills.id })
      .from(bills)
      .where(eq(bills.storeId, OTHER));
    await db.insert(khataEntries).values({
      accountId: ACCOUNT_ID,
      kind: 'charge',
      amountPaise: 1,
      billId: foreignBill!.id,
    });

    expect(await previewCustomerPseudonymisation(STORE, 'Ramesh')).toEqual({
      status: 'cross_store_link',
    });
  });

  it('writes a private JSON artifact with BigInt amounts serialized as decimal strings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rai-export-artifact-'));
    try {
      const result = await exportStoreArtifact(STORE, OWNER, directory);
      expect(result.status).toBe('generated');
      if (result.status !== 'generated') return;
      const content = await readFile(result.path, 'utf8');
      const parsed = JSON.parse(content) as {
        store: { id: string };
        khataAccounts: Array<{ balancePaise: string }>;
        manifest: { format: string };
      };
      expect(parsed.manifest.format).toBe('supermarket-ops-agent-store-export');
      expect(parsed.store.id).toBe(STORE.toString());
      expect(parsed.khataAccounts[0]!.balancePaise).toBe(5000);
      expect((await stat(result.path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
