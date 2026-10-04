import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadEnv } from '../config/env.js';
import {
  runLimits,
  classifyResult,
  perRunBudgetUsd,
  turnCostUsd,
  OUTCOME_REPLY,
  type AgentOutcome,
} from './limits.js';
import { ALLOWED_TOOLS, STORE_SERVER_NAME, storeToolServer } from '../tools/index.js';

const env = loadEnv();

const SYSTEM_PROMPT = `
You run a small Indian kirana store for its owner, over Telegram.

The owner types tersely, the way a shopkeeper actually talks. Match that register: short,
direct, no preamble. Amounts are in rupees (₹).

Any figure about the shop's state — prices, GST, stock, khata balances, totals, sales figures —
comes from your tools, never from memory. A figure you stated earlier in this conversation must
still be re-read before you restate it: state can change between turns, so remembering is
guessing. If a tool reports that a product name matches more than one product, ask the owner
which one they mean rather than guessing. If it reports the product is unknown, say so plainly
rather than inventing one.
`.trim();

/** Preferences are injected as instructions so they apply with no tool call. */
function withPreferences(prefs: Record<string, unknown>): string {
  const entries = Object.entries(prefs);
  if (entries.length === 0) return SYSTEM_PROMPT;

  const lines = entries.map(([key, value]) => `- ${key}: ${String(value)}`).join('\n');
  return `${SYSTEM_PROMPT}

The owner has set these standing preferences. Apply them without being asked and without
looking them up. They survive /new, so do not treat a fresh chat as a reason to re-ask:

${lines}`;
}

export interface AgentResult {
  reply: string;
  sessionId: string;
  toolsUsed: string[];
  outcome: AgentOutcome;
  /** SDK-reported total for the session so far (cumulative on a resumed session). */
  totalCostUsd: number;
  /** What this run cost. Feeds the daily budget. */
  turnCostUsd: number;
  numTurns: number;
}

export async function runAgent(input: {
  text: string;
  sessionId?: string;
  preferences?: Record<string, unknown>;
  /** Session spend before this run, so the budget cap and the cost accounting are per-run. */
  priorCostUsd?: number;
}): Promise<AgentResult> {
  const limits = runLimits(env);
  const prior = input.priorCostUsd ?? 0;

  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, limits.timeoutMs);

  const stream = query({
    prompt: input.text,
    options: {
      model: limits.model,
      fallbackModel: limits.fallbackModel,
      maxTurns: limits.maxTurns,
      maxBudgetUsd: perRunBudgetUsd(limits.maxBudgetUsd, prior),
      abortController: abort,
      systemPrompt: withPreferences(input.preferences ?? {}),
      mcpServers: { [STORE_SERVER_NAME]: storeToolServer },
      allowedTools: ALLOWED_TOOLS,
      skills: 'all',
      // 'project' is required for `.claude/skills/` to be discovered at all — with
      // settingSources: [] the skills never load, verified empirically. This does mean
      // project settings are read, so the agent's working directory must not contain
      // development instructions meant for a different audience.
      settingSources: ['project'],
      resume: input.sessionId,
      // Adaptive thinking stays on. `effort` is the latency lever — never disable thinking,
      // which on Opus 5 can emit tool calls as plain text that then silently never run.
      effort: env.AGENT_EFFORT,
    },
  });

  const chunks: string[] = [];
  const toolsUsed: string[] = [];
  let sessionId = input.sessionId ?? '';
  let outcome: AgentOutcome | undefined;
  let totalCostUsd = 0;
  let numTurns = 0;

  try {
    for await (const message of stream) {
      if (message.type === 'system' && 'session_id' in message) {
        sessionId = String(message.session_id);
      }
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') chunks.push(block.text);
          if (block.type === 'tool_use') toolsUsed.push(block.name);
        }
      }
      if (message.type === 'result') {
        outcome = classifyResult(message);
        totalCostUsd = message.total_cost_usd ?? 0;
        numTurns = message.num_turns;
      }
    }
  } catch (error) {
    // A single-shot query() yields the error result and THEN throws (max turns, max budget).
    // If we already saw the result, the throw carries no new information.
    if (timedOut) outcome = 'timeout';
    else if (outcome === undefined) throw error;
  } finally {
    clearTimeout(timer);
  }

  const finalOutcome = outcome ?? 'error';
  const reply = finalOutcome === 'ok' ? chunks.join('').trim() : OUTCOME_REPLY[finalOutcome];

  return {
    reply,
    sessionId,
    toolsUsed,
    outcome: finalOutcome,
    totalCostUsd,
    turnCostUsd: turnCostUsd(totalCostUsd, prior),
    numTurns,
  };
}
