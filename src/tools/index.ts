import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { getStockTool } from './inventory.js';

export const STORE_SERVER_NAME = 'store';

export const storeToolServer = createSdkMcpServer({
  name: STORE_SERVER_NAME,
  version: '0.1.0',
  tools: [getStockTool],
});

/**
 * The complete allowlist.
 *
 * Every built-in filesystem and shell tool — Bash, Read, Write, Edit, Glob, Grep, WebSearch,
 * WebFetch — is absent by design. A Telegram bot is an open input channel, and those tools
 * sitting behind it amount to a shell anyone can reach.
 *
 * `Skill` is the one built-in we do allow. Skills are progressive-disclosure: the model pulls
 * SKILL.md content on demand through this tool. Verified empirically that it is the gate —
 * granting `Skill` is sufficient and `Read` is never required, so the filesystem stays shut.
 *
 * Store-tool naming follows the SDK's `mcp__<server>__<tool>` convention. A wrong name here
 * does not error; it silently blocks the tool, so this is covered by a test.
 */
export const SKILL_TOOL = 'Skill';

export const ALLOWED_TOOLS = [SKILL_TOOL, `mcp__${STORE_SERVER_NAME}__get_stock`];

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
