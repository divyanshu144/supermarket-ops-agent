import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadEnv } from '../config/env.js';
import {
  runLimits,
  classifyResult,
  perRunBudgetUsd,
  turnCostUsd,
  SDK_COST_IS_CUMULATIVE,
  OUTCOME_REPLY,
  type AgentOutcome,
} from './limits.js';
import { postgresSessionStore, sessionExists } from './session-store.js';
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
  /**
   * Session total so far (cumulative on a resumed session). Equals `priorCostUsd` when no
   * result message arrived, so the cumulative chain never resets to zero.
   */
  totalCostUsd: number;
  /** What this run cost. Feeds the daily budget. */
  turnCostUsd: number;
  numTurns: number;
  /**
   * True when the stored session id could not be used and this run started a fresh conversation
   * (the store had no transcript for it, or the resume failed to start). The caller must replace
   * or clear its stored session row.
   */
  resumeDropped: boolean;
}

/** A run that threw instead of yielding a result; `sawOutput` says whether the model had spoken. */
class RunFailed extends Error {
  constructor(
    readonly original: unknown,
    readonly sawOutput: boolean,
  ) {
    super('agent run failed');
  }
}

async function runOnce(args: {
  text: string;
  resume?: string;
  preferences?: Record<string, unknown>;
  prior: number;
}): Promise<Omit<AgentResult, 'resumeDropped'>> {
  const limits = runLimits(env);
  const prior = args.prior;

  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, limits.timeoutMs);

  const stream = query({
    prompt: args.text,
    options: {
      model: limits.model,
      fallbackModel: limits.fallbackModel,
      maxTurns: limits.maxTurns,
      maxBudgetUsd: perRunBudgetUsd(limits.maxBudgetUsd, prior),
      abortController: abort,
      systemPrompt: withPreferences(args.preferences ?? {}),
      mcpServers: { [STORE_SERVER_NAME]: storeToolServer },
      allowedTools: ALLOWED_TOOLS,
      skills: 'all',
      // 'project' is required for `.claude/skills/` to be discovered at all — with
      // settingSources: [] the skills never load, verified empirically. This does mean
      // project settings are read, so the agent's working directory must not contain
      // development instructions meant for a different audience.
      settingSources: ['project'],
      resume: args.resume,
      sessionStore: postgresSessionStore,
      // Adaptive thinking stays on. `effort` is the latency lever — never disable thinking,
      // which on Opus 5 can emit tool calls as plain text that then silently never run.
      effort: env.AGENT_EFFORT,
    },
  });

  const chunks: string[] = [];
  const toolsUsed: string[] = [];
  let sessionId = args.resume ?? '';
  let outcome: AgentOutcome | undefined;
  let totalCostUsd = prior;
  let numTurns = 0;
  let sawResult = false;

  try {
    for await (const message of stream) {
      if (message.type === 'system' && message.subtype === 'mirror_error') {
        // Fixed text + session id only: the error string can embed the failed query's parameters,
        // which are conversation content.
        console.error(
          JSON.stringify({
            scope: 'session-store',
            warning: 'transcript mirror failed; the turn is unaffected',
            sessionId: message.session_id,
          }),
        );
        continue;
      }
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
        sawResult = true;
        outcome = classifyResult(message);
        totalCostUsd = message.total_cost_usd;
        numTurns = message.num_turns;
      }
    }
  } catch (error) {
    // A single-shot query() yields the error result and THEN throws (max turns, max budget).
    // If we already saw the result, the throw carries no new information.
    if (outcome === undefined && !timedOut) {
      throw new RunFailed(error, chunks.length > 0 || toolsUsed.length > 0);
    }
  } finally {
    clearTimeout(timer);
  }
  // Only a run that produced no result is a timeout; a late abort must not overwrite a real one.
  if (outcome === undefined && timedOut) outcome = 'timeout';

  // A timed-out run produced no result, so its real spend is unknown. Charge the daily budget the
  // per-run cap (worst case for an aborted run) so it over-counts rather than under-counts. The
  // session total stays at `prior` so the cumulative chain is untouched. A late abort AFTER a
  // result keeps the real cost.
  const timedOutWithoutResult = outcome === 'timeout' && !sawResult;
  const finalOutcome = outcome ?? 'error';

  // Tripwire: a resumed run whose cumulative total went DOWN means either the cost total is
  // really per-call or the resume silently started a fresh session. Neither is visible otherwise.
  if (args.resume && sawResult && SDK_COST_IS_CUMULATIVE && totalCostUsd < prior) {
    console.warn(
      JSON.stringify({
        scope: 'cost',
        warning:
          'resumed run total below prior; cost total may be per-call or the resume started a fresh session',
        prior,
        total: totalCostUsd,
      }),
    );
  }
  const reply = finalOutcome === 'ok' ? chunks.join('').trim() : OUTCOME_REPLY[finalOutcome];

  return {
    reply,
    sessionId,
    toolsUsed,
    outcome: finalOutcome,
    totalCostUsd,
    turnCostUsd: timedOutWithoutResult ? limits.maxBudgetUsd : turnCostUsd(totalCostUsd, prior),
    numTurns,
  };
}

export async function runAgent(input: {
  text: string;
  sessionId?: string;
  preferences?: Record<string, unknown>;
  /** Session spend before this run, so the budget cap and the cost accounting are per-run. */
  priorCostUsd?: number;
}): Promise<AgentResult> {
  let resume = input.sessionId;
  let prior = input.priorCostUsd ?? 0;
  let resumeDropped = false;

  // A session id the store has no transcript for cannot be resumed on a fresh container. That is
  // every session created before the mirror existed, so the first message after a deploy starts a
  // new conversation instead of failing. The old session's spend does not carry over.
  if (resume && !(await sessionExists(resume))) {
    resume = undefined;
    prior = 0;
    resumeDropped = true;
  }

  try {
    return {
      ...(await runOnce({ text: input.text, resume, preferences: input.preferences, prior })),
      resumeDropped,
    };
  } catch (error) {
    if (!(error instanceof RunFailed)) throw error;
    // A resume that fails to start, before the model has said anything, is retried once without
    // it. Spawn-level failures throw; a failure on a started session arrives as a result message,
    // so a transient API error does not reach this branch. If it ever does, the cost is one lost
    // conversation context, which the warning below makes visible.
    if (!resume || error.sawOutput) throw error.original;
    console.warn(
      JSON.stringify({
        scope: 'session',
        warning: 'resume failed before any output; retrying once without resume',
      }),
    );
    try {
      const fresh = await runOnce({
        text: input.text,
        resume: undefined,
        preferences: input.preferences,
        prior: 0,
      });
      return { ...fresh, resumeDropped: true };
    } catch (retryError) {
      throw retryError instanceof RunFailed ? retryError.original : retryError;
    }
  }
}
