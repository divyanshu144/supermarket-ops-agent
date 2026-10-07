import { describe, expect, it } from 'vitest';
import { ANALYTICS_TOOL_NAMES } from '../tools/analytics.js';
import { BILLING_TOOL_NAMES } from '../tools/billing.js';
import { DOCUMENT_TOOL_NAMES } from '../tools/documents.js';
import { INVENTORY_TOOL_NAMES } from '../tools/inventory.js';
import { KHATA_TOOL_NAMES } from '../tools/khata.js';
import { PREFERENCE_TOOL_NAMES } from '../tools/preferences.js';
import { EVAL_TOOL_NAMES } from './tool-names.js';

describe('eval tool-name registry', () => {
  it('matches the production registered tool-name constants without constructing an MCP server', () => {
    const productionNames = [
      ...INVENTORY_TOOL_NAMES,
      ...BILLING_TOOL_NAMES,
      ...KHATA_TOOL_NAMES,
      ...ANALYTICS_TOOL_NAMES,
      ...DOCUMENT_TOOL_NAMES,
      ...PREFERENCE_TOOL_NAMES,
    ];
    expect(EVAL_TOOL_NAMES).toEqual(productionNames);
  });
});
