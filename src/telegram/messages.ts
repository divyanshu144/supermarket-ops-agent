/** Every fixed string the owner can see from the transport layer, in one place. */

export const WELCOME = [
  'Namaste! I run your shop from this chat.',
  '',
  'Try: "how much sugar is left?", "50 packets of Maggi came in, cost ₹12, MRP ₹14",',
  '"make a bill: 2kg sugar, 4 Maggi, UPI", "what\'s running out?"',
  '',
  '/new — fresh conversation (your stock, khata and preferences stay)',
  '/reset — restore this shop to its starting state (asks you to confirm)',
  '',
  'AI notice: messages and relevant shop data may be processed by Anthropic. Voice audio goes to OpenAI for transcription.',
  'Send /privacy for app storage, current retention, and privacy contact details.',
].join('\n');

export const PRIVACY_CONTACT_FALLBACK = 'ask whoever gave you your invite';

export function privacyMessage(contact?: string, retentionDays = 30): string {
  const contactLine = contact
    ? `For privacy requests, contact ${contact}.`
    : `For privacy requests, ${PRIVACY_CONTACT_FALLBACK}.`;
  return [
    'Privacy and AI use',
    '',
    'This bot uses Anthropic to process owner messages and relevant shop data for replies and tool use. If you send a voice note, its audio is sent to OpenAI for transcription.',
    'The app stores shop and product records, bills, customer names and khata records, preferences, conversation transcripts, usage records, and generated invoice/deck files.',
    `Current app retention: transcripts and generated files are removed after ${retentionDays} days without activity. Finalized invoices can be generated again from their bills. Telegram and AI-provider retention is outside this app and is not stated here.`,
    'In-chat store export and customer pseudonymisation are not yet available.',
    contactLine,
  ].join('\n');
}

export const PRIVATE_MESSAGE =
  'This is a private bot. If you have an invite code, send /start <your code>.';

export const INVALID_CODE =
  'That code is not valid — it may be used, revoked or mistyped. Check it with whoever invited you.';

export const RESET_EXPLAINER =
  'This wipes your stock, bills and khata and restores the starting demo shop. ' +
  'If you are sure, send /reset confirm.';

export const RATE_LIMITED_REPLY =
  'Too many messages too fast. Give it a few minutes and try again.';

export const DAILY_CAP_REPLY =
  "This shop has reached today's usage limit. It resets at midnight IST.";
