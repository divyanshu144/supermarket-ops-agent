const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

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
