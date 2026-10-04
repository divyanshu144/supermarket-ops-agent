/**
 * Live probe: does a conversation survive a "redeploy" when the transcript is mirrored to Postgres?
 *
 *   pnpm tsx src/agent/session-store.probe.ts
 *
 * Needs a real ANTHROPIC_API_KEY and the local database. Costs a few cents. It has not been run
 * yet; the operator runs it. It deletes the session entries it mirrored and closes the pool when done.
 *
 *   A. Turn 1 runs with its local transcripts in a throwaway config dir and the Postgres store.
 *   B. Turn 2 RESUMES the same session id with a DIFFERENT, empty config dir — i.e. no local
 *      transcript, exactly what a fresh container looks like — and asks for the codeword.
 *      PASS in B is required before relying on session durability. FAIL: resume from the store did
 *      not work; do not rely on it.
 *   C. Turn 3 resumes a session id that exists nowhere. It records HOW that fails (thrown error
 *      text, or an error result), which decides whether runtime.ts's retry condition ("throws
 *      before any assistant output") matches reality. Paste the output of C
 *      into tasks/agent_memory.md under Known Gotchas.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadEnv } from '../config/env.js';
import { pool } from '../db/client.js';
import { deleteSessionEntries } from '../repositories/session-entries.js';
import { postgresSessionStore } from './session-store.js';

const env = loadEnv();
const CODEWORD = 'PINEAPPLE';

async function turn(prompt: string, resume: string | undefined, configDir: string) {
  let sessionId = resume ?? '';
  let reply = '';
  let seenAssistant = false;
  let resultSubtype = '';
  let threw = '';
  try {
    for await (const m of query({
      prompt,
      options: {
        model: env.AGENT_MODEL,
        resume,
        sessionStore: postgresSessionStore,
        systemPrompt: 'Be brief.',
        settingSources: [],
        allowedTools: [],
        maxTurns: 3,
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      },
    })) {
      if (m.type === 'system' && 'session_id' in m) sessionId = String(m.session_id);
      if (m.type === 'assistant') {
        seenAssistant = true;
        for (const b of m.message.content) if (b.type === 'text') reply += b.text;
      }
      if (m.type === 'result') resultSubtype = m.subtype;
    }
  } catch (error) {
    threw = (error as Error).message;
  }
  return { sessionId, reply, seenAssistant, resultSubtype, threw };
}

const dirA = mkdtempSync(join(tmpdir(), 'probe-a-'));
const dirB = mkdtempSync(join(tmpdir(), 'probe-b-'));

let probedSessionId = '';
try {
  console.log('A. fresh session, local transcripts in', dirA);
  const a = await turn(`Remember the codeword ${CODEWORD}. Reply with just: ok`, undefined, dirA);
  probedSessionId = a.sessionId;
  console.log(`   session=${a.sessionId} reply="${a.reply.trim()}" threw="${a.threw}"`);

  console.log('B. resume from the store with an EMPTY config dir', dirB);
  const b = await turn('What is the codeword? Reply with just the word.', a.sessionId, dirB);
  console.log(`   reply="${b.reply.trim()}" threw="${b.threw}"`);
  console.log(
    b.reply.toUpperCase().includes(CODEWORD)
      ? '   PASS: the conversation survived without any local transcript.'
      : '   FAIL: resume from the store did not restore the conversation.',
  );

  console.log('C. resume a session id that exists nowhere');
  const missing = randomUUID();
  const c = await turn('hello', missing, mkdtempSync(join(tmpdir(), 'probe-c-')));
  console.log(
    `   threw="${c.threw}" resultSubtype="${c.resultSubtype}" sawAssistantOutput=${c.seenAssistant}`,
  );
  console.log(
    c.threw && !c.seenAssistant
      ? '   MATCHES runtime.ts: a spawn-level throw before any assistant output (the retry condition).'
      : '   DOES NOT MATCH the runtime.ts retry condition: update RunFailed handling before relying on it.',
  );
} finally {
  if (probedSessionId) await deleteSessionEntries(probedSessionId);
  await pool.end();
}
