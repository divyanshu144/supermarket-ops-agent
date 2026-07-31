import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { dailySummary, salesReport, stockHealth } from '../repositories/analytics.js';
import { requireContext } from './context.js';
import { toolResult } from './present.js';

export const dailySummaryTool = tool(
  'daily_summary',
  'Close the day: total sales, GST collected, cash vs UPI vs card vs khata, top items and ' +
    'bill count. Answers "today\'s sales?" and "close the day".',
  { date: z.string().optional().describe('ISO date (YYYY-MM-DD). Defaults to today.') },
  async ({ date }) => {
    const { storeId } = requireContext();
    const summary = await dailySummary(storeId, date ? new Date(date) : undefined);
    return toolResult({
      date: summary.date,
      bills: summary.billCount,
      total_sales: summary.total,
      gst_collected: summary.taxCollected,
      by_payment_mode: summary.byPaymentMode.map((m) => ({
        mode: m.mode,
        bills: m.count,
        total: m.total,
      })),
      top_items: summary.topItems.map((i) => ({
        name: i.name,
        sold: i.quantity,
        revenue: i.revenue,
      })),
    });
  },
);

export const salesReportTool = tool(
  'sales_report',
  'Sales across a date range, broken down by day, with the best-selling items.',
  {
    days_back: z.number().int().positive().max(90).optional().describe('Defaults to 7.'),
  },
  async ({ days_back }) => {
    const { storeId } = requireContext();
    const to = new Date();
    const from = new Date(to.getTime() - (days_back ?? 7) * 86_400_000);
    const report = await salesReport(storeId, from, to);
    return toolResult({
      from: report.from,
      to: report.to,
      bills: report.billCount,
      total_sales: report.total,
      gst_collected: report.taxCollected,
      by_day: report.daily.map((d) => ({ date: d.date, bills: d.billCount })),
      top_items: report.topItems.map((i) => ({ name: i.name, sold: i.quantity })),
    });
  },
);

export const stockHealthTool = tool(
  'stock_health',
  'How the shelf is doing: how many SKUs, stock value at cost, what is at or below reorder ' +
    'level, and what has not sold at all recently.',
  {},
  async () => {
    const { storeId } = requireContext();
    const health = await stockHealth(storeId);
    return toolResult({
      skus: health.skuCount,
      stock_value_at_cost: health.stockValue,
      running_out: health.lowStock,
      not_selling: health.deadStock,
    });
  },
);

export const ANALYTICS_TOOLS = [dailySummaryTool, salesReportTool, stockHealthTool];

export const ANALYTICS_TOOL_NAMES = ['daily_summary', 'sales_report', 'stock_health'] as const;
