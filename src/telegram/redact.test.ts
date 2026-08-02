import { describe, expect, it } from 'vitest';
import { redact } from './redact.js';

const TOKEN = '7891234560:AAHkq2LpXvBn3RtYw8ZcQe1FgH5JmNoPqRs';

describe('redact', () => {
  it('removes a value under a token-ish key', () => {
    const out = JSON.stringify(redact({ api: { token: TOKEN } }));
    expect(out).not.toContain(TOKEN);
    expect(out).toContain('[redacted]');
  });

  it('removes a bot token appearing as a bare string anywhere', () => {
    const out = JSON.stringify(redact({ message: `failed calling ${TOKEN}` }));
    expect(out).not.toContain(TOKEN);
  });

  it('removes a bot token embedded in a file-download URL', () => {
    // Telegram's getFile URL is https://api.telegram.org/file/bot<TOKEN>/path — voice input
    // would otherwise reintroduce the leak through a different property.
    const url = `https://api.telegram.org/file/bot${TOKEN}/voice/file_1.oga`;
    const out = JSON.stringify(redact({ url }));
    expect(out).not.toContain(TOKEN);
    expect(out).toContain('api.telegram.org');
  });

  it('removes Anthropic and OpenAI style keys', () => {
    const out = JSON.stringify(
      redact({ a: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345', b: 'sk-proj-abcdefghijklmno' }),
    );
    expect(out).not.toContain('sk-ant-');
    expect(out).not.toContain('sk-proj-');
  });

  it('survives a circular structure', () => {
    // BotError holds ctx, ctx holds api, and grammY objects reference back. A naive
    // recursive walk stack-overflows here instead of redacting.
    const a: Record<string, unknown> = { token: TOKEN };
    a.self = a;
    expect(() => JSON.stringify(redact(a))).not.toThrow();
  });

  it('preserves ordinary values', () => {
    expect(redact({ updateId: '42', nested: { ok: true } })).toEqual({
      updateId: '42',
      nested: { ok: true },
    });
  });

  it('keeps an Error readable', () => {
    const out = redact(new Error('boom')) as Record<string, string>;
    expect(out.message).toBe('boom');
    expect(out.name).toBe('Error');
  });
});
