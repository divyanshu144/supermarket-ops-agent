import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'grammy';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverTemporaryExport } from './export-delivery.js';

afterEach(() => vi.restoreAllMocks());

describe('deliverTemporaryExport', () => {
  it('deletes the export file after Telegram accepts it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rai-export-send-'));
    const path = join(directory, 'store-export.json');
    await writeFile(path, '{"manifest":{}}');
    const ctx = { replyWithDocument: vi.fn().mockResolvedValue(undefined) } as unknown as Context;
    try {
      await expect(deliverTemporaryExport(ctx, path, 'store-export.json')).resolves.toBe(true);
      expect(ctx.replyWithDocument).toHaveBeenCalledOnce();
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('deletes the export file when the Telegram send fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rai-export-failed-'));
    const path = join(directory, 'store-export.json');
    await writeFile(path, '{"manifest":{}}');
    const ctx = {
      replyWithDocument: vi.fn().mockRejectedValue(new Error('telegram unavailable')),
    } as unknown as Context;
    try {
      await expect(deliverTemporaryExport(ctx, path, 'store-export.json')).rejects.toThrow(
        'telegram unavailable',
      );
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
