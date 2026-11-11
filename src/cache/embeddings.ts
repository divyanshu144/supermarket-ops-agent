import type { Embedding, EmbeddingProvider } from './semantic.js';

/** Provider errors fail open to the agent; never substitute fake semantic vectors. */
export class OpenAIEmbeddings implements EmbeddingProvider {
  readonly id = 'openai:text-embedding-3-small';
  constructor(
    private key: string,
    private usdPerMillionTokens = 0.02,
  ) {}
  async embed(text: string): Promise<Embedding> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
    });
    if (!response.ok) throw new Error(`Embedding provider HTTP ${response.status}`);
    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
      usage: { total_tokens: number };
    };
    const tokens = data.usage.total_tokens;
    if (!Number.isInteger(tokens) || tokens < 0 || !Array.isArray(data.data[0]?.embedding))
      throw new Error('Invalid embedding response');
    return {
      vector: data.data[0]!.embedding,
      tokens,
      estimatedCostUsd: (tokens * this.usdPerMillionTokens) / 1_000_000,
    };
  }
}

/** Local mean-pooled learned word vectors; no model download. macOS only. */
export class AppleWordEmbeddings implements EmbeddingProvider {
  readonly id = 'apple:english-word-mean-v1';
  constructor(private executable = 'artifacts/engineering/apple-embedding') {}
  async embed(text: string): Promise<Embedding> {
    const { spawn } = await import('node:child_process');
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
      let output = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Local embedding timed out'));
      }, 10_000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.stdin.on('error', () => undefined);
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (output.length > 100_000) child.kill();
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error('Local embedding unavailable'));
          return;
        }
        try {
          resolve(JSON.parse(output) as Embedding);
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(JSON.stringify({ text }) + '\n');
    });
  }
}
