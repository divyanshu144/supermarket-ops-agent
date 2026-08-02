import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import {
  dailySummary,
  reorderSuggestions,
  salesReport,
  stockHealth,
} from '../repositories/analytics.js';
import { baseUnitsPerSellingUnit, formatQuantity, type Unit } from '../domain/units.js';
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

export const reorderSuggestionsTool = tool(
  'reorder_suggestions',
  'What to order next, ranked by how soon it runs out. Uses actual sales velocity from the ' +
    'last N days, so a fast mover about to go empty ranks above a slow one sitting at its ' +
    'reorder level. Answers "what should I order?".',
  {
    days_back: z
      .number()
      .int()
      .positive()
      .max(90)
      .optional()
      .describe('Sales window. Defaults to 30.'),
    limit: z.number().int().positive().max(20).optional().describe('Defaults to 10.'),
  },
  async ({ days_back, limit }) => {
    const { storeId } = requireContext();
    const suggestions = await reorderSuggestions(storeId, days_back ?? 30);
    return toolResult({
      window_days: days_back ?? 30,
      suggestions: suggestions.slice(0, limit ?? 10).map((s) => ({
        name: s.name,
        in_stock: formatQuantity(s.quantityBase, s.unit as Unit),
        // unitsPerDay from the repository is a base-unit rate (grams/ml/etc). Convert to
        // selling units so it matches in_stock and the unit the owner actually speaks in —
        // otherwise a loose kg product reports its rate in grams (e.g. "1000/day" for sugar).
        sells_per_day: Number(
          (s.unitsPerDay / baseUnitsPerSellingUnit(s.unit as Unit)).toFixed(2),
        ),
        days_of_cover:
          s.daysOfCover === null ? 'no recent sales' : Number(s.daysOfCover.toFixed(1)),
        below_reorder_level: s.quantityBase <= s.reorderLevelBase,
      })),
    });
  },
);

export const ANALYTICS_TOOLS = [
  dailySummaryTool,
  salesReportTool,
  stockHealthTool,
  reorderSuggestionsTool,
];

export const ANALYTICS_TOOL_NAMES = [
  'daily_summary',
  'sales_report',
  'stock_health',
  'reorder_suggestions',
] as const;
