const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

/** OpenAI whisper-1 list price, USD per minute of audio. Update if the price changes. */
const WHISPER_USD_PER_MINUTE = 0.006;

/** Whisper spend for a clip, in whole micro-USD (rounded up, never negative). */
export function whisperCostMicroUsd(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  // 0.006 USD/min = 6000 micro-USD/min; work in integers of micro-USD to avoid float drift.
  const microPerMinute = Math.round(WHISPER_USD_PER_MINUTE * 1_000_000);
  return Math.ceil((durationSeconds * microPerMinute) / 60);
}

/**
 * Speech to text. The entire provider surface is this one function, so swapping Whisper for
 * anything else touches this file and nothing above it.
 */
export async function transcribe(
  audio: Buffer,
  mimeType: string,
  apiKey: string | undefined,
): Promise<string> {
  if (!apiKey) throw new Error('Voice input is not configured (no OPENAI_API_KEY).');

  const form = new FormData();
  // Buffer's ArrayBufferLike can widen to SharedArrayBuffer, which BlobPart rejects; a copy
  // into a plain Uint8Array keeps this a straightforward byte-for-byte pass-through.
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), 'voice.oga');
  form.append('model', 'whisper-1');

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    throw new Error(`Transcription failed (${response.status}).`);
  }

  const body = (await response.json()) as { text?: string };
  return (body.text ?? '').trim();
}
