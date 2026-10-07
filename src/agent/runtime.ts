import { query, type HookCallback } from '@anthropic-ai/claude-agent-sdk';
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
import { renderPreferenceContext } from '../domain/preferences.js';

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

/** Validated preferences are rendered as bounded data, not instructions. */
function withPreferences(prefs: Record<string, unknown>): string {
  const rendered = renderPreferenceContext(prefs);
  return rendered ? `${SYSTEM_PROMPT}\n\n${rendered}` : SYSTEM_PROMPT;
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
  /** SDK-reported evidence for each query attempt. Missing SDK fields remain null. */
  attempts: ModelAttemptEvidence[];
}

export interface ModelToolCallEvidence {
  toolUseId: string;
  name: string;
  source: 'mcp' | 'builtin';
  resultState: 'pending' | 'returned' | 'failed';
  isError: boolean | null;
  /** SDK hook outcome keyed by the same tool_use_id as this attempted call. */
  sdkExecution: {
    state: 'returned' | 'failed';
    durationMs: number | null;
  } | null;
}

export interface ModelAttemptEvidence {
  ordinal: number;
  /** Every raw model ID seen on assistant messages during this attempt. */
  modelIds: string[];
  /** Per-model usage reported by the SDK result, keyed by its declared modelUsage keys. */
  modelUsage: Record<string, ModelUsageEvidence>;
  resultSubtype: string | null;
  outcome: AgentOutcome | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  /** SDK-reported total_cost_usd for this result, which can be session-cumulative on resume. */
  costUsd: number | null;
  numTurns: number | null;
  resumed: boolean;
  retryFresh: boolean;
  toolCalls: ModelToolCallEvidence[];
}

export interface ModelUsageEvidence {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
  canonicalModel: string | null;
  provider: string | null;
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

/** A failed resumed-plus-retry run still exposes both SDK attempts and its conservative charge. */
export class AgentRunFailure extends Error {
  constructor(
    readonly original: unknown,
    readonly attempts: ModelAttemptEvidence[],
    readonly conservativelyChargedTurnCostUsd: number,
  ) {
    super('agent run failed after retry');
    this.name = 'AgentRunFailure';
  }
}

async function runOnce(args: {
  text: string;
  resume?: string;
  preferences?: Record<string, unknown>;
  prior: number;
  attempts: ModelAttemptEvidence[];
  retryFresh: boolean;
}): Promise<Omit<AgentResult, 'resumeDropped'>> {
  const limits = runLimits(env);
  const prior = args.prior;

  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, limits.timeoutMs);

  let stream: ReturnType<typeof query>;
  const chunks: string[] = [];
  const toolsUsed: string[] = [];
  let sessionId = args.resume ?? '';
  let outcome: AgentOutcome | undefined;
  let totalCostUsd = prior;
  let numTurns = 0;
  let sawResult = false;
  const attempt: ModelAttemptEvidence = {
    ordinal: args.attempts.length + 1,
    modelIds: [],
    modelUsage: {},
    resultSubtype: null,
    outcome: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
    costUsd: null,
    numTurns: null,
    resumed: args.resume !== undefined,
    retryFresh: args.retryFresh,
    toolCalls: [],
  };
  const pendingSdkExecutions = new Map<
    string,
    NonNullable<ModelToolCallEvidence['sdkExecution']>
  >();

  const recordSdkToolExecution: HookCallback = async (input, toolUseID) => {
    if (
      (input.hook_event_name !== 'PostToolUse' && input.hook_event_name !== 'PostToolUseFailure') ||
      typeof input.tool_use_id !== 'string'
    ) {
      return {};
    }
    const toolUseId = toolUseID ?? input.tool_use_id;
    const matching = attempt.toolCalls.find((call) => call.toolUseId === toolUseId);
    const sdkExecution = {
      state:
        input.hook_event_name === 'PostToolUseFailure'
          ? ('failed' as const)
          : ('returned' as const),
      durationMs: typeof input.duration_ms === 'number' ? input.duration_ms : null,
    };
    if (matching) {
      matching.resultState = input.hook_event_name === 'PostToolUseFailure' ? 'failed' : 'returned';
      matching.isError = input.hook_event_name === 'PostToolUseFailure';
      matching.sdkExecution = sdkExecution;
    } else {
      pendingSdkExecutions.set(toolUseId, sdkExecution);
    }
    return {};
  };

  try {
    stream = query({
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
        // SDK hooks expose the upstream tool_use_id and the completed tool response. This is
        // the canonical ID-linked execution evidence; the local handler observer has no SDK ID.
        hooks: {
          PostToolUse: [{ hooks: [recordSdkToolExecution] }],
          PostToolUseFailure: [{ hooks: [recordSdkToolExecution] }],
        },
      },
    });
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
        if (
          typeof message.message.model === 'string' &&
          !attempt.modelIds.includes(message.message.model)
        ) {
          attempt.modelIds.push(message.message.model);
        }
        for (const block of message.message.content) {
          if (block.type === 'text') chunks.push(block.text);
          if (block.type === 'tool_use' || block.type === 'mcp_tool_use') {
            toolsUsed.push(block.name);
            const call: ModelToolCallEvidence = {
              toolUseId: block.id,
              name: block.name,
              source: block.type === 'mcp_tool_use' ? 'mcp' : 'builtin',
              resultState: pendingSdkExecutions.has(block.id)
                ? pendingSdkExecutions.get(block.id)?.state === 'failed'
                  ? 'failed'
                  : 'returned'
                : 'pending',
              isError: pendingSdkExecutions.has(block.id)
                ? pendingSdkExecutions.get(block.id)?.state === 'failed'
                : null,
              sdkExecution: pendingSdkExecutions.get(block.id) ?? null,
            };
            attempt.toolCalls.push(call);
            pendingSdkExecutions.delete(block.id);
          }
        }
      }
      if (message.type === 'user' && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (
            typeof block === 'object' &&
            block !== null &&
            'tool_use_id' in block &&
            typeof block.tool_use_id === 'string' &&
            (!('is_error' in block) || typeof block.is_error === 'boolean')
          ) {
            const matching = attempt.toolCalls.find((call) => call.toolUseId === block.tool_use_id);
            if (matching) {
              const sdkExecutionFailed = matching.sdkExecution?.state === 'failed';
              if (!sdkExecutionFailed) {
                if ('is_error' in block && typeof block.is_error === 'boolean') {
                  matching.isError = block.is_error;
                  matching.resultState = block.is_error ? 'failed' : 'returned';
                } else if (!matching.sdkExecution) {
                  matching.resultState = 'returned';
                }
              }
            }
          }
        }
      }
      if (message.type === 'result') {
        attempt.resultSubtype = message.subtype;
        attempt.outcome = classifyResult(message);
        attempt.costUsd = message.total_cost_usd;
        attempt.numTurns = message.num_turns;
        attempt.inputTokens = message.usage.input_tokens;
        attempt.outputTokens = message.usage.output_tokens;
        attempt.cacheReadInputTokens = message.usage.cache_read_input_tokens;
        attempt.cacheCreationInputTokens = message.usage.cache_creation_input_tokens;
        attempt.modelUsage = Object.fromEntries(
          Object.entries(message.modelUsage).map(([modelId, usage]) => [
            modelId,
            {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadInputTokens: usage.cacheReadInputTokens,
              cacheCreationInputTokens: usage.cacheCreationInputTokens,
              costUsd: usage.costUSD,
              canonicalModel: usage.canonicalModel ?? null,
              provider: usage.provider ?? null,
            },
          ]),
        );
        // A resumed run that dies in an error result before saying anything fails identically on
        // every turn (the same session id would be stored again). Take the retry-fresh path.
        // Deliberately NOT for subtype 'success' + is_error (a transient API error: the owner's
        // conversation must survive it), nor max_turns / max_budget, nor once output was seen.
        if (
          args.resume &&
          message.subtype === 'error_during_execution' &&
          chunks.length === 0 &&
          toolsUsed.length === 0
        ) {
          throw new RunFailed(
            new Error('resumed run ended in an error result before any output'),
            false,
          );
        }
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
      attempt.outcome = 'error';
      throw new RunFailed(error, chunks.length > 0 || toolsUsed.length > 0);
    }
  } finally {
    args.attempts.push(attempt);
    clearTimeout(timer);
  }
  // Only a run that produced no result is a timeout; a late abort must not overwrite a real one.
  if (outcome === undefined && timedOut) outcome = 'timeout';
  if (attempt.outcome === null) attempt.outcome = outcome ?? 'error';

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
    attempts: args.attempts,
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
  const attempts: ModelAttemptEvidence[] = [];

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
      ...(await runOnce({
        text: input.text,
        resume,
        preferences: input.preferences,
        prior,
        attempts,
        retryFresh: false,
      })),
      resumeDropped,
    };
  } catch (error) {
    if (!(error instanceof RunFailed)) throw error;
    // A resume that fails to start, before the model has said anything, is retried once without
    // it. Spawn-level failures throw; a failure on a started session arrives as a result message,
    // so a transient API error does not reach this branch. If it ever does, the cost is one lost
    // conversation context, which the warning below makes visible.
    if (!resume || error.sawOutput) throw error.original;
    const failedAttempt = attempts.at(-1);
    // If an SDK result was absent there is no honest spend figure; charge the full run cap
    // conservatively so this retry cannot erase unknown spend from the failed resume.
    const failedAttemptCharge =
      failedAttempt?.costUsd === null || failedAttempt === undefined
        ? runLimits(env).maxBudgetUsd
        : turnCostUsd(failedAttempt.costUsd, prior);
    console.warn(
      JSON.stringify({
        scope: 'session',
        warning: 'resume failed before any output; retrying once without resume',
        sessionId: resume, // a UUID, not content
        // Class/type name only: the message can carry query parameters.
        errorName: error.original instanceof Error ? error.original.name : typeof error.original,
      }),
    );
    try {
      const fresh = await runOnce({
        text: input.text,
        resume: undefined,
        preferences: input.preferences,
        prior: 0,
        attempts,
        retryFresh: true,
      });
      return {
        ...fresh,
        turnCostUsd: fresh.turnCostUsd + failedAttemptCharge,
        resumeDropped: true,
      };
    } catch (retryError) {
      const retryAttempt = attempts.at(-1);
      const retryAttemptCharge =
        retryAttempt?.costUsd === null || retryAttempt === undefined
          ? runLimits(env).maxBudgetUsd
          : turnCostUsd(retryAttempt.costUsd, 0);
      throw new AgentRunFailure(
        retryError instanceof RunFailed ? retryError.original : retryError,
        [...attempts],
        failedAttemptCharge + retryAttemptCharge,
      );
    }
  }
}
