import { afterEach, describe, expect, it, vi } from 'vitest';
import { transcribe } from './transcribe.js';

afterEach(() => vi.unstubAllGlobals());

const audio = Buffer.from('fake-ogg-bytes');

describe('transcribe', () => {
  it('posts the audio and returns the text', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ text: 'do kilo cheeni' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(transcribe(audio, 'audio/ogg', 'test-key')).resolves.toBe('do kilo cheeni');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('throws a clear error when the provider fails', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    await expect(transcribe(audio, 'audio/ogg', 'test-key')).rejects.toThrow(
      /transcription failed/i,
    );
  });

  it('refuses without an API key rather than calling out', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(transcribe(audio, 'audio/ogg', undefined)).rejects.toThrow(/not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
