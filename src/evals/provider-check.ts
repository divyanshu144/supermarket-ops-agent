import 'dotenv/config';
import { query } from '@anthropic-ai/claude-agent-sdk';
// No database, Telegram, store tools, project settings or raw provider output.
const patterns = {
  insufficient_credit: /credit balance|insufficient.*credit|balance.*low/i,
  rate_limit: /rate.?limit|too many requests/i,
  authentication: /invalid.*api.?key|authentication|unauthorized/i,
  billing: /billing|payment required/i,
  model_unavailable: /model.*not found|model.*not available/i,
};
try {
  for await (const message of query({
    prompt: 'Reply OK.',
    options: {
      model: process.env.AGENT_MODEL ?? 'claude-opus-5',
      systemPrompt: 'Reply OK.',
      settingSources: [],
      tools: [],
      allowedTools: [],
      maxTurns: 1,
      maxBudgetUsd: 0.05,
    },
  })) {
    const text = JSON.stringify(message);
    const category = Object.entries(patterns).find(([, pattern]) => pattern.test(text))?.[0];
    if (category) console.log(JSON.stringify({ providerFailure: category }));
    if (message.type === 'result')
      console.log(
        JSON.stringify({
          subtype: message.subtype,
          isError: message.is_error,
          costUsd: message.total_cost_usd,
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
        }),
      );
  }
} catch {
  console.log(JSON.stringify({ status: 'provider_check_failed' }));
  process.exitCode = 1;
}
