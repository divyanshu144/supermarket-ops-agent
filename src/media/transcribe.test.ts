import { afterEach, describe, expect, it, vi } from 'vitest';
import { transcribe, whisperCostMicroUsd } from './transcribe.js';

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

describe('whisperCostMicroUsd', () => {
  it('charges $0.006 per minute in micro-USD', () => {
    expect(whisperCostMicroUsd(60)).toBe(6000);
    expect(whisperCostMicroUsd(3)).toBe(300);
  });

  it('rounds partial micro-dollars up', () => {
    expect(whisperCostMicroUsd(90.5)).toBe(9050);
    expect(whisperCostMicroUsd(0.01)).toBe(1);
  });

  it('is zero for no audio and never negative', () => {
    expect(whisperCostMicroUsd(0)).toBe(0);
    expect(whisperCostMicroUsd(-5)).toBe(0);
    expect(whisperCostMicroUsd(Number.NaN)).toBe(0);
  });
});
