import type { Context } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadTelegramFile } from './download.js';

afterEach(() => vi.unstubAllGlobals());

describe('downloadTelegramFile', () => {
  it('returns the audio buffer without persisting a Telegram download', async () => {
    const originalCwd = process.cwd();
    const isolated = await mkdtemp(join(tmpdir(), 'rai-telegram-download-'));
    const bytes = Buffer.from('fake-ogg-bytes');
    const ctx = {
      getFile: vi.fn().mockResolvedValue({ file_path: 'voice/file.oga' }),
    } as unknown as Context;
    const fetchMock = vi.fn(async () => new Response(bytes, { status: 200 }));

    try {
      process.chdir(isolated);
      vi.stubGlobal('fetch', fetchMock);
      await expect(downloadTelegramFile(ctx, 'unused-test-token')).resolves.toEqual(bytes);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(await readdir(isolated)).toEqual([]);
    } finally {
      process.chdir(originalCwd);
      await rm(isolated, { recursive: true, force: true });
    }
  });

  it('does not expose a bot token when the Telegram download fails', async () => {
    const ctx = {
      getFile: vi.fn().mockResolvedValue({ file_path: 'voice/file.oga' }),
    } as unknown as Context;
    vi.stubGlobal('fetch', async () => new Response('failure', { status: 503 }));

    await expect(downloadTelegramFile(ctx, '123456:fake-secret')).rejects.toThrow(
      'Could not download the file (503).',
    );
  });
});
