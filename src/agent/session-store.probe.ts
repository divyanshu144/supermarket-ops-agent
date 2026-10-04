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
 *      into tasks/agent_memory.md under Known Gotchas. C's verdict is a heuristic from ONE
 *      observation, not a proof; B depends on the model complying with the one-word instruction.
 *      If A fails, B and C are skipped (they would be meaningless) and the exit code is non-zero.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadEnv } from '../config/env.js';
import { pool } from '../db/client.js';
import { deleteSessionEntries } from '../repositories/session-entries.js';
import { postgresSessionStore } from './session-store.js';

const env = loadEnv();
const CODEWORD = 'PINEAPPLE';

/** Every session id the probe touches, so the finally block can delete them all. */
const seenSessionIds = new Set<string>();
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function turn(prompt: string, resume: string | undefined, configDir: string) {
  let sessionId = resume ?? '';
  if (resume) seenSessionIds.add(resume);
  let reply = '';
  let seenAssistant = false;
  let resultSubtype = '';
  let threw = '';
  let stderr = '';
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
        stderr: (data: string) => {
          stderr += data;
        },
      },
    })) {
      if (m.type === 'system' && 'session_id' in m) {
        sessionId = String(m.session_id);
        seenSessionIds.add(sessionId);
      }
      if (m.type === 'assistant') {
        seenAssistant = true;
        for (const b of m.message.content) if (b.type === 'text') reply += b.text;
      }
      if (m.type === 'result') resultSubtype = m.subtype;
    }
  } catch (error) {
    threw = (error as Error).message;
  }
  return { sessionId, reply, seenAssistant, resultSubtype, threw, stderrTail: stderr.slice(-400) };
}

try {
  const dirA = tempDir('probe-a-');
  const dirB = tempDir('probe-b-');
  const dirC = tempDir('probe-c-');

  console.log('A. fresh session, local transcripts in', dirA);
  const a = await turn(`Remember the codeword ${CODEWORD}. Reply with just: ok`, undefined, dirA);
  console.log(`   session=${a.sessionId} reply="${a.reply.trim()}" threw="${a.threw}"`);

  if (a.threw || !a.sessionId) {
    console.log(
      `   A FAILED (${a.threw || 'no session id'}): B and C are not meaningful. ` +
        'Fix the A failure first (is ANTHROPIC_API_KEY real?).',
    );
    process.exitCode = 1;
  } else {
    console.log('B. resume from the store with an EMPTY config dir', dirB);
    const b = await turn('What is the codeword? Reply with just the word.', a.sessionId, dirB);
    console.log(`   reply="${b.reply.trim()}" threw="${b.threw}"`);
    console.log(
      b.reply.toUpperCase().includes(CODEWORD)
        ? '   PASS: the conversation survived without any local transcript.'
        : '   FAIL: resume from the store did not restore the conversation.',
    );

    console.log('C. resume a session id that exists nowhere');
    const c = await turn('hello', randomUUID(), dirC);
    console.log(
      `   threw="${c.threw}" resultSubtype="${c.resultSubtype}" sawAssistantOutput=${c.seenAssistant}`,
    );
    console.log(`   reply="${c.reply.trim()}" stderrTail=${JSON.stringify(c.stderrTail)}`);
    if (c.threw && !c.seenAssistant) {
      console.log(
        '   MATCHES runtime.ts: an unknown resume throws before any assistant output, so the retry-once-without-resume branch will fire.',
      );
    } else if (c.threw) {
      console.log(
        '   THREW AFTER OUTPUT: runtime.ts will NOT retry (output had started); an unknown resume fails mid-run. Review RunFailed.sawOutput before relying on the retry.',
      );
    } else if (c.resultSubtype !== 'success') {
      console.log(
        `   ERROR RESULT, NOT A THROW: an unknown resume yields a result with subtype ${c.resultSubtype}; runtime.ts's retry only handles throws — handle result errors for resumes or rely on the pre-check (sessionExists) alone.`,
      );
    } else {
      console.log(
        '   SILENT SUCCESS: the SDK started a fresh session for an unknown id. The retry branch never fires; the sessionExists pre-check is what protects the owner, and that is fine.',
      );
    }
  }
} finally {
  try {
    for (const id of seenSessionIds) {
      try {
        await deleteSessionEntries(id);
      } catch (error) {
        console.log(`   cleanup of ${id} failed: ${(error as Error).message}`);
      }
    }
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  } finally {
    await pool.end();
  }
}
