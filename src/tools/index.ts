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
 * Every built-in SDK tool — Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch — is
 * absent by design. A Telegram bot is an open input channel, and those tools sitting behind
 * it amount to a shell anyone can reach.
 *
 * Naming follows the SDK's `mcp__<server>__<tool>` convention. A wrong name here does not
 * error; it silently blocks the tool, so this is covered by a test.
 */
export const ALLOWED_TOOLS = [`mcp__${STORE_SERVER_NAME}__get_stock`];
