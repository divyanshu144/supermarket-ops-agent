/** Every fixed string the owner can see from the transport layer, in one place. */

export const WELCOME = [
  'Namaste! I run your shop from this chat.',
  '',
  'Try: "how much sugar is left?", "50 packets of Maggi came in, cost ₹12, MRP ₹14",',
  '"make a bill: 2kg sugar, 4 Maggi, UPI", "what\'s running out?"',
  '',
  '/new — fresh conversation (your stock, khata and preferences stay)',
  '/reset — restore this shop to its starting state (asks you to confirm)',
].join('\n');

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
