import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { generateInvoicePdf } from '../documents/invoice.js';
import { generateAnalysisDeck } from '../documents/deck.js';
import { requireContext, recordArtifact } from './context.js';
import { toolResult } from './present.js';

export const generateInvoicePdfTool = tool(
  'generate_invoice_pdf',
  'Produce a GST-correct PDF invoice for a finalized bill. If you do not have the bill id, ' +
    'use find_bills first. The file is sent to the owner automatically once the turn ends — ' +
    'do not describe its contents at length, just say it is on its way.',
  { bill_id: z.string() },
  async ({ bill_id }) => {
    const { storeId } = requireContext();
    const result = await generateInvoicePdf(storeId, bill_id);

    if (result.status === 'generated') {
      recordArtifact(result.artifact);
      return toolResult({
        status: 'generated',
        invoice_number: result.invoiceNumber,
        filename: result.artifact.filename,
        message: 'Invoice PDF generated and queued for delivery to this chat.',
      });
    }
    if (result.status === 'not_finalized') {
      return toolResult({
        status: 'not_finalized',
        message: 'That bill is still a draft. Finalize it first — a draft is not a tax document.',
      });
    }
    return toolResult(result);
  },
);

export const generateAnalysisDeckTool = tool(
  'generate_analysis_deck',
  'Produce a PowerPoint analysing the shop: sales over time, top items, stock health and GST ' +
    'collected, with real charts. The file is sent to the owner automatically once the turn ends.',
  { days_back: z.number().int().positive().max(90).optional().describe('Defaults to 7.') },
  async ({ days_back }) => {
    const { storeId } = requireContext();
    const to = new Date();
    const from = new Date(to.getTime() - (days_back ?? 7) * 86_400_000);

    const result = await generateAnalysisDeck(storeId, { from, to });
    recordArtifact(result.artifact);

    return toolResult({
      status: 'generated',
      period: `${result.from} to ${result.to}`,
      bills_analysed: result.billCount,
      filename: result.artifact.filename,
      message: 'Analysis deck generated and queued for delivery to this chat.',
    });
  },
);

export const DOCUMENT_TOOLS = [generateInvoicePdfTool, generateAnalysisDeckTool];

export const DOCUMENT_TOOL_NAMES = ['generate_invoice_pdf', 'generate_analysis_deck'] as const;
