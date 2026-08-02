import { InputFile, type Context } from 'grammy';
import { runAgent } from '../agent/runtime.js';
import { provisionStore } from '../repositories/stores.js';
import {
  claimUpdate,
  completeUpdate,
  getSessionId,
  setSessionId,
} from '../repositories/updates.js';
import { readPreferences } from '../tools/preferences.js';
import { newToolContext, toolContext } from '../tools/context.js';
import { logTurn } from '../observability/log.js';
import { loadEnv, shouldLogMessageText } from '../config/env.js';
import { redact } from './redact.js';

const env = loadEnv();

/**
 * One owner turn, whatever modality it arrived as.
 *
 * Text and voice share this because it holds the update claim and the artifact drain — the two
 * things a second copy would silently let drift.
 */
export async function handleTurn(ctx: Context, text: string): Promise<void> {
  const updateId = BigInt(ctx.update.update_id);
  const storeId = BigInt(ctx.chat!.id);
  const startedAt = Date.now();

  // Claim, don't mark done. See repositories/updates.ts for why the difference matters.
  const claim = await claimUpdate(updateId, storeId);
  if (claim === 'duplicate') return;

  await provisionStore(storeId);
  await ctx.replyWithChatAction('typing');

  try {
    const sessionId = await getSessionId(storeId);
    const preferences = await readPreferences(storeId);

    const turnContext = newToolContext(storeId, updateId);
    const result = await toolContext.run(turnContext, () =>
      runAgent({ text, sessionId, preferences }),
    );

    if (result.sessionId) await setSessionId(storeId, result.sessionId);
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
        outcome: 'ok',
      },
      { includeText: shouldLogMessageText(env) },
    );
  } catch (error) {
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
      { includeText: shouldLogMessageText(env) },
    );
    await ctx.reply('Something went wrong on my side. Try that again?');
    // Deliberately NOT completed: the claim goes stale and a retry can reprocess it.
  }
}
