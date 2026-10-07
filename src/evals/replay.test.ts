import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { z } from 'zod';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createSandbox, sandboxOwnershipVerifier } from './database.js';
import type { DatabaseTarget, Sandbox, SandboxOwnershipProof } from './database.js';
import { replayRecording, ReplayRecordingSchema } from './replay.js';
import { replayWithInjectedToolsForTest } from './replay.testing.js';
import { replayFailureMessage, safeReplayFailure } from './replay-errors.js';
import {
  assertReplayDatabaseTargets,
  assertSameDatabaseTarget,
  type ReplayTool,
} from './replay-core.js';
import { parseScenario } from './scenario.js';
import { seedScenario, snapshotScenario } from './seed.js';

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...sdk,
    query: vi.fn(() => {
      throw new Error('Provider/model calls are forbidden during replay.');
    }),
  };
});

const adminUrl = process.env.EVAL_TEST_DATABASE_ADMIN_URL;
const normalUrl = 'postgres://eval-deny:unused@localhost:5435/eval-not-production';
const manifestDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    manifestDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function scenario() {
  return parseScenario({
    version: 1,
    id: 'synthetic-replay-bill',
    description: 'Synthetic recorded bill build, edit and finalize through registered tools.',
    tags: ['billing'],
    difficulty: 'normal',
    seed: {
      anchor: '2026-10-07T10:00:00.000Z',
      store: { ref: 'shop', chatId: '920001', name: 'Replay fixture shop' },
      products: [
        {
          ref: 'rice',
          name: 'Rice 1kg',
          unit: 'packet',
          isLoose: false,
          hsnCode: '10061000',
          gstRateBps: 0,
          costPricePaise: 200,
          mrpPaise: 700,
          quantityBase: 10,
        },
        {
          ref: 'tea-a',
          name: 'Tea Brand A',
          brand: 'Brand A',
          unit: 'packet',
          isLoose: false,
          hsnCode: '09023000',
          gstRateBps: 0,
          costPricePaise: 100,
          mrpPaise: 300,
          quantityBase: 4,
        },
        {
          ref: 'tea-b',
          name: 'Tea Brand B',
          brand: 'Brand B',
          unit: 'packet',
          isLoose: false,
          hsnCode: '09023000',
          gstRateBps: 0,
          costPricePaise: 100,
          mrpPaise: 300,
          quantityBase: 5,
        },
      ],
      sentinel: { ref: 'sentinel', chatId: '920002', name: 'Replay sentinel' },
    },
    steps: [
      { id: 'owner', kind: 'owner_message', text: 'Synthetic replay fixture', language: 'en' },
    ],
    expectations: { byStep: [{ stepId: 'owner', assert: {} }], final: {} },
  });
}

async function makeSandbox() {
  if (!adminUrl) throw new Error('Set EVAL_TEST_DATABASE_ADMIN_URL to dedicated eval Postgres.');
  const manifestDirectory = await mkdtemp(join(tmpdir(), 'eval-replay-test-'));
  manifestDirectories.push(manifestDirectory);
  return createSandbox({ adminUrl, normalUrl, manifestDirectory });
}

describe('replay recording integrity', () => {
  it('rejects duplicate step IDs, unknown tools and schema-invalid arguments before execution', async () => {
    const base = {
      version: 1,
      id: 'bad-replay',
      provenance: 'synthetic',
      storeId: '920001',
      updateId: '1',
      steps: [{ id: 'open', tool: 'open_bill', args: {}, expect: { status: 'opened' } }],
    };
    expect(() =>
      ReplayRecordingSchema.parse({ ...base, steps: [...base.steps, ...base.steps] }),
    ).toThrow('duplicate step id');
    await expect(replayRecording(base, {} as Sandbox)).rejects.toThrow('Unowned');
    const handler = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: '{"status":"opened"}' }],
    }));
    const registry: ReplayTool[] = [
      { name: 'open_bill', inputSchema: { customer_name: z.string().optional() }, handler },
    ];
    await expect(
      replayWithInjectedToolsForTest(
        { ...base, steps: [{ ...base.steps[0], tool: 'shell' }] },
        registry,
      ),
    ).rejects.toThrow('Unknown registered store tool: shell');
    await expect(
      replayWithInjectedToolsForTest(
        {
          ...base,
          steps: [{ id: 'bad', tool: 'open_bill', args: { unexpected: true }, expect: {} }],
        },
        registry,
      ),
    ).rejects.toThrow('Unrecognized key');
    expect(handler).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('resolves symbolic IDs and rejects a recorded success that differs from the handler', async () => {
    const open = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: '{"bill_id":"bill-real"}' }],
    }));
    const read = vi.fn(async (args: unknown) => {
      const billId = (args as { bill_id: string }).bill_id;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ status: billId === 'bill-real' ? 'draft' : 'bill_not_found' }),
          },
        ],
      };
    });
    const registry: ReplayTool[] = [
      { name: 'open_bill', inputSchema: {}, handler: open },
      { name: 'get_bill', inputSchema: { bill_id: z.string() }, handler: read },
    ];
    const recording = {
      version: 1,
      id: 'symbolic-replay',
      provenance: 'synthetic',
      storeId: '920001',
      updateId: '2',
      steps: [
        { id: 'opened', tool: 'open_bill', args: {}, expect: { bill_id: 'bill-real' } },
        {
          id: 'read-once',
          tool: 'get_bill',
          args: { bill_id: '$ref:opened.bill_id' },
          expect: { status: 'draft' },
        },
        {
          id: 'read-again',
          tool: 'get_bill',
          args: { bill_id: '$ref:opened.bill_id' },
          expect: { status: 'draft' },
        },
      ],
    };
    const result = await replayWithInjectedToolsForTest(recording, registry);
    expect(result.calls).toHaveLength(3);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenNthCalledWith(1, { bill_id: 'bill-real' }, {});
    await expect(
      replayWithInjectedToolsForTest(
        {
          ...recording,
          id: 'recorded-success-disagrees',
          steps: [
            ...recording.steps.slice(0, 2),
            { ...recording.steps[2], expect: { status: 'finalized' } },
          ],
        },
        registry,
      ),
    ).rejects.toThrow('result.status: expected "finalized", received "draft"');
    await expect(
      replayWithInjectedToolsForTest(
        { ...recording, id: 'unknown-reference', steps: [recording.steps[1]] },
        registry,
      ),
    ).rejects.toThrow('Unknown replay result reference');
    expect(query).not.toHaveBeenCalled();
  });

  it('redacts a sandbox connection error containing the worker password', () => {
    const workerPassword = 'generated-worker-password-must-not-escape';
    const connectionError = Object.assign(
      new Error(
        `connect ECONNREFUSED for postgresql://eval:${workerPassword}@127.0.0.1:59899/eval_db`,
      ),
      { code: 'ECONNREFUSED' },
    );
    const safe = safeReplayFailure(connectionError);
    const rendered = `${replayFailureMessage(safe)} ${JSON.stringify(safe)}`;
    expect(rendered).not.toContain(workerPassword);
    expect(rendered).toContain('ECONNREFUSED');
  });

  it.skipIf(!adminUrl)(
    'keeps the worker password out of a real failed sandbox connection error',
    async () => {
      const sandbox = await makeSandbox();
      const unavailableUrl = new URL(sandbox.workerUrl);
      unavailableUrl.port = '1';
      const client = new pg.Client({
        connectionString: unavailableUrl.toString(),
        connectionTimeoutMillis: 500,
      });
      try {
        const failure = await client.connect().then(
          () => null,
          (error: unknown) => error,
        );
        if (!failure)
          throw new Error('The deliberately unavailable sandbox port accepted a connection.');
        const safe = safeReplayFailure(failure);
        expect(safe.code).toBeTruthy();
        expect(JSON.stringify(safe)).not.toContain(unavailableUrl.password);
      } finally {
        await client.end().catch(() => undefined);
        await sandbox.cleanup();
      }
    },
  );

  it('rechecks the target before every step and stops before calling a handler on drift', async () => {
    const target: DatabaseTarget = {
      host: 'eval.invalid',
      port: 5432,
      database: 'eval_test',
      user: 'eval_test',
    };
    const drifted = { ...target, database: 'real_store' };
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{}' }] }));
    const registry: ReplayTool[] = [{ name: 'get_stock', inputSchema: {}, handler }];
    const recording = {
      version: 1,
      id: 'target-drift',
      provenance: 'synthetic',
      storeId: '920001',
      updateId: '3',
      steps: [
        { id: 'first', tool: 'get_stock', args: {}, expect: {} },
        { id: 'second', tool: 'get_stock', args: {}, expect: {} },
      ],
    };
    let check = 0;
    const verify = vi.fn(async () => ({
      process: target,
      pool: check++ < 2 ? target : drifted,
    }));
    await expect(
      replayWithInjectedToolsForTest(recording, registry, target, verify),
    ).rejects.toThrow('Replay database target mismatch');
    expect(verify).toHaveBeenCalledTimes(3);
    expect(handler).toHaveBeenCalledTimes(1);
    for (const changed of [
      { ...target, host: 'different' },
      { ...target, port: 5433 },
      { ...target, database: 'different' },
      { ...target, user: 'different' },
    ]) {
      expect(() => assertSameDatabaseTarget(changed, target)).toThrow(
        'Replay database target mismatch',
      );
    }
    expect(() =>
      assertReplayDatabaseTargets({ process: target, pool: { ...target, port: 5433 } }, target),
    ).toThrow('Replay database target mismatch');
    expect(() =>
      assertReplayDatabaseTargets(
        { process: { ...target, database: 'wrong_db' }, pool: target },
        target,
      ),
    ).toThrow('Replay database target mismatch');
  });

  it('rechecks sandbox manifest ownership before each step and stops on ownership drift', async () => {
    const manifestDirectory = await mkdtemp(join(tmpdir(), 'eval-replay-ownership-'));
    const manifestPath = join(manifestDirectory, 'sandbox.json');
    const ownerToken = 'synthetic-owner-marker';
    const proof: SandboxOwnershipProof = {
      manifestPath,
      database: 'eval_test',
      role: 'eval_test',
      ownerTokenSha256: createHash('sha256').update(ownerToken).digest('hex'),
    };
    const manifest = {
      version: 1,
      database: proof.database,
      role: proof.role,
      ownerToken,
      createdAt: '2026-10-07T10:00:00.000Z',
      state: 'ready',
    };
    await writeFile(manifestPath, JSON.stringify(manifest));

    const handler = vi.fn(async () => {
      if (handler.mock.calls.length === 1) {
        await writeFile(manifestPath, JSON.stringify({ ...manifest, state: 'cleaned' }));
      }
      return { content: [{ type: 'text' as const, text: '{}' }] };
    });
    const registry: ReplayTool[] = [{ name: 'get_stock', inputSchema: {}, handler }];
    const recording = {
      version: 1,
      id: 'ownership-drift',
      provenance: 'synthetic',
      storeId: '920001',
      updateId: '4',
      steps: [
        { id: 'first', tool: 'get_stock', args: {}, expect: {} },
        { id: 'second', tool: 'get_stock', args: {}, expect: {} },
      ],
    };
    try {
      await expect(
        replayWithInjectedToolsForTest(
          recording,
          registry,
          undefined,
          undefined,
          sandboxOwnershipVerifier(proof),
        ),
      ).rejects.toThrow('Replay sandbox ownership check failed');
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      await rm(manifestDirectory, { recursive: true, force: true });
    }
  });

  it('injects the synthetic owner identity into a test replay context when supplied', async () => {
    const registry: ReplayTool[] = [
      {
        name: 'get_stock',
        inputSchema: {},
        handler: async () => {
          const { requireContext } = await import('../tools/context.js');
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ owner_user_id: requireContext().ownerUserId?.toString() }),
              },
            ],
          };
        },
      },
    ];
    const recording = {
      version: 1,
      id: 'owner-context',
      provenance: 'synthetic',
      storeId: '920001',
      updateId: '107',
      ownerUserId: '77001',
      steps: [{ id: 'identity', tool: 'get_stock', args: {}, expect: { owner_user_id: '77001' } }],
    };

    await expect(replayWithInjectedToolsForTest(recording, registry)).resolves.toMatchObject({
      calls: [{ result: { owner_user_id: '77001' } }],
    });
  });

  it.skipIf(!adminUrl)(
    'builds and finalizes a bill through real handlers, validates results and scopes foreign IDs',
    async () => {
      const sandbox = await makeSandbox();
      const client = new pg.Client({ connectionString: sandbox.workerUrl });
      try {
        await client.connect();
        const fixture = scenario();
        await seedScenario(client, fixture);
        const shopId = fixture.seed.store.chatId;
        const sentinelId = fixture.seed.sentinel.chatId;

        const billRun = await replayRecording(
          {
            version: 1,
            id: 'synthetic-build-edit-finalize',
            provenance: 'synthetic',
            storeId: shopId,
            updateId: '101',
            steps: [
              { id: 'open', tool: 'open_bill', args: {}, expect: { status: 'opened' } },
              {
                id: 'add',
                tool: 'add_bill_item',
                args: {
                  bill_id: '$ref:open.bill_id',
                  product_query: 'Rice 1kg',
                  qty: 1,
                  unit: 'packet',
                },
                expect: { status: 'added' },
              },
              {
                id: 'edit',
                tool: 'update_bill_item',
                args: {
                  bill_id: '$ref:open.bill_id',
                  product_query: 'Rice 1kg',
                  qty: 2,
                  unit: 'packet',
                },
                expect: { status: 'updated' },
              },
              {
                id: 'finish',
                tool: 'finalize_bill',
                args: { bill_id: '$ref:open.bill_id', payment_mode: 'cash' },
                expect: { status: 'finalized', totals: { total: 1400 } },
              },
            ],
          },
          sandbox,
        );
        expect(billRun.calls.map((call) => call.tool)).toEqual([
          'open_bill',
          'add_bill_item',
          'update_bill_item',
          'finalize_bill',
        ]);
        const state = await snapshotScenario(client, shopId, [], sentinelId);
        expect(state.products.find((row) => row.name === 'Rice 1kg')?.quantityBase).toBe(8);
        expect(state.movements.filter((move) => move.kind === 'sale')).toHaveLength(1);
        const billId = (billRun.calls[0]!.result as { bill_id: string }).bill_id;

        const otherStoreRun = await replayRecording(
          {
            version: 1,
            id: 'synthetic-sentinel-bill',
            provenance: 'synthetic',
            storeId: sentinelId,
            updateId: '102',
            steps: [{ id: 'open', tool: 'open_bill', args: {}, expect: { status: 'opened' } }],
          },
          sandbox,
        );
        const foreignBillId = (otherStoreRun.calls[0]!.result as { bill_id: string }).bill_id;
        await expect(
          replayRecording(
            {
              version: 1,
              id: 'synthetic-cross-store-read',
              provenance: 'synthetic',
              storeId: shopId,
              updateId: '103',
              steps: [
                {
                  id: 'foreign',
                  tool: 'get_bill',
                  args: { bill_id: foreignBillId },
                  expect: { status: 'bill_not_found' },
                },
              ],
            },
            sandbox,
          ),
        ).resolves.toMatchObject({ calls: [{ result: { status: 'bill_not_found' } }] });

        await expect(
          replayRecording(
            {
              version: 1,
              id: 'synthetic-unknown-reference',
              provenance: 'synthetic',
              storeId: shopId,
              updateId: '104',
              steps: [
                {
                  id: 'read',
                  tool: 'get_bill',
                  args: { bill_id: '$ref:missing.bill_id' },
                  expect: {},
                },
              ],
            },
            sandbox,
          ),
        ).rejects.toThrow('Replay worker failed; details are redacted.');

        const ambiguous = await replayRecording(
          {
            version: 1,
            id: 'synthetic-ambiguous-same-name',
            provenance: 'synthetic',
            storeId: shopId,
            updateId: '105',
            steps: [
              { id: 'open', tool: 'open_bill', args: {}, expect: { status: 'opened' } },
              {
                id: 'choose',
                tool: 'add_bill_item',
                args: {
                  bill_id: '$ref:open.bill_id',
                  product_query: 'Tea',
                  qty: 1,
                  unit: 'packet',
                },
                expect: { status: 'ambiguous' },
              },
            ],
          },
          sandbox,
        );
        expect((ambiguous.calls[1]!.result as { candidates: unknown[] }).candidates).toHaveLength(
          2,
        );
        expect(billId).toMatch(/^[0-9a-f-]{36}$/i);
      } finally {
        await client.end().catch(() => undefined);
        await sandbox.cleanup();
      }
    },
  );
});
