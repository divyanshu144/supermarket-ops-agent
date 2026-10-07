import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { ANALYTICS_TOOLS, ANALYTICS_TOOL_NAMES } from './analytics.js';
import { BILLING_TOOLS, BILLING_TOOL_NAMES } from './billing.js';
import { DOCUMENT_TOOLS, DOCUMENT_TOOL_NAMES } from './documents.js';
import { INVENTORY_TOOLS, INVENTORY_TOOL_NAMES } from './inventory.js';
import { KHATA_TOOLS, KHATA_TOOL_NAMES } from './khata.js';
import { PREFERENCE_TOOLS, PREFERENCE_TOOL_NAMES } from './preferences.js';
import { observeRegisteredTools } from './observe.js';

export const STORE_SERVER_NAME = 'store';

/** Every tool the shop exposes. Adding one here is not enough — see ALLOWED_TOOLS below. */
export const STORE_TOOLS = [
  ...INVENTORY_TOOLS,
  ...BILLING_TOOLS,
  ...KHATA_TOOLS,
  ...ANALYTICS_TOOLS,
  ...DOCUMENT_TOOLS,
  ...PREFERENCE_TOOLS,
];

export const STORE_TOOL_NAMES = [
  ...INVENTORY_TOOL_NAMES,
  ...BILLING_TOOL_NAMES,
  ...KHATA_TOOL_NAMES,
  ...ANALYTICS_TOOL_NAMES,
  ...DOCUMENT_TOOL_NAMES,
  ...PREFERENCE_TOOL_NAMES,
] as const;

export const storeToolServer = createSdkMcpServer({
  name: STORE_SERVER_NAME,
  version: '0.1.0',
  // The wrappers emit nothing unless an eval-only ToolContext sink is explicitly present.
  tools: observeRegisteredTools(STORE_TOOLS),
  // Without this the SDK defers these tools behind ToolSearch, which fires an extra model
  // round-trip before nearly every call. The set is small and entirely relevant to every turn,
  // so there is nothing to search. Costs a blocking connect at startup, capped at 5s.
  alwaysLoad: true,
});

/**
 * `Skill` is the one built-in we allow. Skills are progressive-disclosure: the model pulls
 * SKILL.md content on demand through this tool. Verified empirically that it is the gate —
 * granting `Skill` is sufficient and `Read` is never required, so the filesystem stays shut.
 */
export const SKILL_TOOL = 'Skill';

/**
 * The complete allowlist.
 *
 * Every built-in filesystem and shell tool — Bash, Read, Write, Edit, Glob, Grep, WebSearch,
 * WebFetch — is absent by design. A Telegram bot is an open input channel, and those tools
 * sitting behind it amount to a shell anyone can reach.
 *
 * Derived from STORE_TOOL_NAMES rather than hand-listed, because a name that is registered but
 * not allowlisted fails silently: the tool simply never gets offered to the model, with no
 * error anywhere. A test asserts the two stay in step.
 */
export const ALLOWED_TOOLS = [
  SKILL_TOOL,
  ...STORE_TOOL_NAMES.map((name) => `mcp__${STORE_SERVER_NAME}__${name}`),
];

/** Tools that must never appear in the allowlist. Asserted in tests. */
export const FORBIDDEN_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
] as const;
