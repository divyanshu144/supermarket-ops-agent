import { redact } from '../telegram/redact.js';

export type TurnOutcome =
  'ok' | 'error' | 'max_turns' | 'max_budget' | 'timeout' | 'rate_limited' | 'daily_cap' | 'denied';

export interface TurnLog {
  updateId: bigint;
  storeId: bigint;
  tools: string[];
  durationMs: number;
  outcome: TurnOutcome;
  costUsd?: number;
  numTurns?: number;
  resumeDropped?: boolean;
  text?: string;
  error?: unknown;
}

export interface LogOptions {
  includeText: boolean;
}

/**
 * One JSON line per turn, to stdout, where Railway indexes it.
 *
 * Message text is opt-in: it carries customer names and amounts, and what debugging actually
 * needs is which tools ran and how long the turn took.
 */
export function logTurn(entry: TurnLog, options: LogOptions = { includeText: false }): void {
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    update_id: String(entry.updateId),
    store_id: String(entry.storeId),
    tools: entry.tools,
    duration_ms: entry.durationMs,
    outcome: entry.outcome,
  };

  if (entry.costUsd !== undefined) line.cost_usd = entry.costUsd;
  if (entry.numTurns !== undefined) line.num_turns = entry.numTurns;
  if (entry.resumeDropped) line.resume_dropped = true;
  if (options.includeText && entry.text !== undefined) line.text = entry.text;
  if (entry.error !== undefined) line.error = redact(entry.error);

  console.log(JSON.stringify(line));
}
