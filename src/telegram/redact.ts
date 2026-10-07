// Keep the existing Telegram-layer import path stable while shared code (including eval tooling)
// can use the pure redactor without importing Telegram.
export { redact } from '../shared/redact.js';
