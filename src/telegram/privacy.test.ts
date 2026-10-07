import { describe, expect, it } from 'vitest';
import { privacyCommand } from './commands.js';
import { WELCOME } from './messages.js';

describe('privacy disclosure', () => {
  it('discloses AI providers, stored data, current retention, and unavailable controls honestly', () => {
    const reply = privacyCommand();
    expect(reply).toContain('Anthropic');
    expect(reply).toContain('OpenAI');
    expect(reply).toContain('conversation transcripts');
    expect(reply).toContain('no automatic expiry');
    expect(reply).toContain('not yet available');
    expect(reply).not.toContain('request an export through');
    expect(reply).not.toMatch(/compliant|legal basis|provider retention period/i);
    expect(reply).toContain('ask whoever gave you your invite');
  });

  it('uses only a configured contact when one is provided', () => {
    const reply = privacyCommand('@privacy_owner');
    expect(reply).toContain('@privacy_owner');
    expect(reply).not.toContain('ask whoever gave you your invite');
  });

  it('introduces AI processing and points owners to /privacy during onboarding', () => {
    expect(WELCOME).toContain('AI');
    expect(WELCOME).toContain('Anthropic');
    expect(WELCOME).toContain('OpenAI');
    expect(WELCOME).toContain('/privacy');
  });
});
