import { InputFile, type Context } from 'grammy';
import { AgentRunFailure, runAgent } from '../agent/runtime.js';
import { deleteSessionEntries } from '../repositories/session-entries.js';
import { hasStore } from '../repositories/access.js';
import {
  claimUpdate,
  clearSession,
  completeUpdate,
  getSessionCostMicroUsd,
  getSessionId,
  setSessionId,
} from '../repositories/updates.js';
import { recordUsage, spentTodayMicroUsd } from '../repositories/usage.js';
import { microUsd } from '../agent/limits.js';
import { turnLimiter } from './rate-limit.js';
import { DAILY_CAP_REPLY, PRIVATE_MESSAGE, RATE_LIMITED_REPLY } from './messages.js';
import { readPreferences } from '../tools/preferences.js';
import { newToolContext, toolContext } from '../tools/context.js';
import { logTurn } from '../observability/log.js';
import { loadEnv, shouldLogMessageText } from '../config/env.js';
import { redact } from './redact.js';

const env = loadEnv();
const DAILY_CAP_MICRO_USD = microUsd(env.STORE_DAILY_BUDGET_USD);

/** At the cap counts as over it: the budget is a ceiling, not a target. */
export async function dailyCapReached(storeId: bigint): Promise<boolean> {
  return (await spentTodayMicroUsd(storeId)) >= DAILY_CAP_MICRO_USD;
}

/**
 * One owner turn, whatever modality it arrived as.
 *
 * Text and voice share this because it holds the update claim and the artifact drain — the two
 * things a second copy would silently let drift.
 *
 * `options.alreadyClaimed` is for callers that must spend money (a download, a transcription)
 * before the substantive turn runs and so have to claim the update themselves, earlier, to avoid
 * paying for that work twice on a redelivery. Default (text) behaviour is unchanged: claim here
 * first, and return without doing anything on a duplicate.
 */
export async function handleTurn(
  ctx: Context,
  text: string,
  options: { alreadyClaimed?: boolean } = {},
): Promise<void> {
  const updateId = BigInt(ctx.update.update_id);
  const storeId = BigInt(ctx.chat!.id);
  const startedAt = Date.now();

  if (!options.alreadyClaimed) {
    // Claim, don't mark done. See repositories/updates.ts for why the difference matters.
    const claim = await claimUpdate(updateId, storeId);
    if (claim === 'duplicate') return;
  }

  const logOptions = { includeText: shouldLogMessageText(env) };

  // A refusal completes the update: a redelivery of a message we deliberately declined must
  // not be reprocessed.
  const refuse = async (
    outcome: 'rate_limited' | 'daily_cap' | 'denied',
    message: string,
  ): Promise<void> => {
    await ctx.reply(message);
    await completeUpdate(updateId);
    logTurn(
      { updateId, storeId, text, tools: [], durationMs: Date.now() - startedAt, outcome },
      logOptions,
    );
  };

  // Second line of defence behind the access gate: a turn never creates a store. The only way
  // one comes into existence is redeeming an invite code.
  if (!(await hasStore(storeId))) {
    return refuse('denied', PRIVATE_MESSAGE);
  }

  if (!turnLimiter.tryConsume(String(storeId))) {
    return refuse('rate_limited', RATE_LIMITED_REPLY);
  }
  if (await dailyCapReached(storeId)) {
    return refuse('daily_cap', DAILY_CAP_REPLY);
  }

  await ctx.replyWithChatAction('typing');

  try {
    const sessionId = await getSessionId(storeId);
    const priorMicro = await getSessionCostMicroUsd(storeId);
    const preferences = await readPreferences(storeId);

    const turnContext = newToolContext(storeId, updateId);
    const result = await toolContext.run(turnContext, () =>
      runAgent({ text, sessionId, preferences, priorCostUsd: priorMicro / 1_000_000 }),
    );

    // Accounting must never fail the turn: the owner's reply is more important than the ledger.
    try {
      await recordUsage(storeId, microUsd(result.turnCostUsd));
    } catch (error) {
      console.error(redact({ scope: 'usage', storeId: String(storeId), error }));
    }

    if (result.sessionId) {
      await setSessionId(storeId, result.sessionId, microUsd(result.totalCostUsd));
      if (result.resumeDropped && sessionId && sessionId !== result.sessionId) {
        // A retried resume leaves the old conversation's transcript behind; /new can no longer
        // reach it once the row points at the new session. Never fail the turn over cleanup.
        try {
          await deleteSessionEntries(sessionId);
        } catch (error) {
          console.error(redact({ scope: 'session-cleanup', storeId: String(storeId), error }));
        }
      }
    } else if (result.resumeDropped) {
      // The stored session could not be used and no new one was created (e.g. the fresh run timed
      // out before its first message): clear the stale row so the next turn starts clean.
      await clearSession(storeId);
    }
    await ctx.reply(result.reply || 'Sorry, I could not work that out.');

    // Files the tools produced this turn go out after the reply, so the owner reads the answer
    // first and the document lands underneath it.
    for (const artifact of turnContext.artifacts) {
      await ctx.replyWithDocument(new InputFile(artifact.path, artifact.filename));
    }

    await completeUpdate(updateId);

    logTurn(
      {
        updateId,
        storeId,
        text,
        tools: result.toolsUsed,
        durationMs: Date.now() - startedAt,
        outcome: result.outcome,
        costUsd: result.turnCostUsd,
        numTurns: result.numTurns,
        resumeDropped: result.resumeDropped,
      },
      logOptions,
    );
  } catch (error) {
    if (error instanceof AgentRunFailure) {
      // A failed resume and failed fresh retry have no owner reply, but their known or
      // conservative spend still belongs in the per-store daily budget.
      try {
        await recordUsage(storeId, microUsd(error.conservativelyChargedTurnCostUsd));
      } catch (usageError) {
        console.error(redact({ scope: 'usage', storeId: String(storeId), error: usageError }));
      }
    }
    console.error(redact({ updateId: String(updateId), storeId: String(storeId), error }));
    logTurn(
      {
        updateId,
        storeId,
        text,
        tools: [],
        durationMs: Date.now() - startedAt,
        outcome: 'error',
        error,
      },
      logOptions,
    );
    await ctx.reply('Something went wrong on my side. Try that again?');
    // Deliberately NOT completed: the claim goes stale and a retry can reprocess it.
  }
}
