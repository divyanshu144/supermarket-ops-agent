import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadEnv } from '../config/env.js';
import { ALLOWED_TOOLS, STORE_SERVER_NAME, storeToolServer } from '../tools/index.js';

const env = loadEnv();

const SYSTEM_PROMPT = `
You run a small Indian kirana store for its owner, over Telegram.

The owner types tersely, the way a shopkeeper actually talks. Match that register: short,
direct, no preamble. Amounts are in rupees (₹).

Every price, GST rate and stock figure comes from your tools. Never state a price or a quantity
you have not read from a tool. If a tool reports that a product name matches more than one
product, ask the owner which one they mean rather than guessing. If it reports the product is
unknown, say so plainly rather than inventing one.
`.trim();

export interface AgentResult {
  reply: string;
  sessionId: string;
  toolsUsed: string[];
}

export async function runAgent(input: { text: string; sessionId?: string }): Promise<AgentResult> {
  const stream = query({
    prompt: input.text,
    options: {
      model: 'claude-opus-5',
      systemPrompt: SYSTEM_PROMPT,
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
  }

  return { reply: chunks.join('').trim(), sessionId, toolsUsed };
}
