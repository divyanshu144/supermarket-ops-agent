import { afterEach, describe, expect, it } from 'vitest';
import { runProtectedChild } from './probes.js';

const originalEnv = new Map<string, string | undefined>();

function setTestEnv(name: string, value: string | undefined): void {
  if (!originalEnv.has(name)) originalEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originalEnv.clear();
});

const run = (script: string, options: Partial<Parameters<typeof runProtectedChild>[0]> = {}) =>
  runProtectedChild({
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    envAllowlist: ['PATH'],
    timeoutMs: 3_000,
    maxOutputBytes: 32_768,
    ...options,
  });

describe('runProtectedChild', () => {
  it('redacts API keys split between writes', async () => {
    const result = await run(
      "process.stdout.write('sk-ant-api03-abcdefgh'); setTimeout(() => process.stdout.write('ijklmnop'), 5)",
    );
    expect(result.status).toBe('completed');
    expect(result.stdout).not.toContain('sk-ant-');
    expect(result.stdout).toContain('[redacted]');
  });

  it('decodes UTF-8 characters split between output chunks', async () => {
    const result = await run(
      'process.stdout.write(Buffer.from([0x63, 0x61, 0x66, 0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9])), 5)',
    );
    expect(result.stdout).toBe('café');
  });

  it('redacts Telegram tokens split between stdout writes', async () => {
    const result = await run(
      "process.stdout.write('token=7891234560:AAHkq2Lp'); setTimeout(() => process.stdout.write('XvBn3RtYw8ZcQe1FgH5JmNoPqRs'), 5)",
    );
    expect(result.status).toBe('completed');
    expect(result.stdout).toBe('token=[redacted]');
    expect(result.stdout).not.toContain('7891234560:');
  });

  it('redacts exact opaque configured secrets even when split between writes', async () => {
    const secret = 'opaque::secret/with?symbols';
    const result = await run(
      "process.stdout.write('receipt opaque::secret/'); setTimeout(() => process.stdout.write('with?symbols done'), 5)",
      { secrets: [secret] },
    );
    expect(result.stdout).toBe('receipt [redacted] done');
  });

  it('suppresses raw stderr exception text and URLs', async () => {
    const result = await run(
      "console.error('Error: fetch failed at https://user:pass@example.invalid/path?token=abc'); process.exit(2)",
    );
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('');
    expect(JSON.stringify(result)).not.toContain('fetch failed');
    expect(result.stderr).not.toContain('example.invalid');
    expect(result.stderr).not.toContain('user:pass');
  });

  it('redacts PostgreSQL URLs with credentials from stdout', async () => {
    const result = await run(
      "process.stdout.write('db=postgresql://worker:super-secret@db.example.invalid:5432/store')",
    );
    expect(result.stdout).toBe('db=[redacted-url]');
    expect(JSON.stringify(result)).not.toContain('super-secret');
    expect(JSON.stringify(result)).not.toContain('db.example.invalid');
  });

  it('reports a nonzero exit with captured sanitized output', async () => {
    const result = await run("process.stdout.write('safe summary'); process.exit(7)");
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe('safe summary');
  });

  it('terminates on timeout and returns no partial diagnostics', async () => {
    const result = await run(
      "process.stdout.write('partial'); setTimeout(() => process.exit(0), 300)",
      {
        timeoutMs: 80,
      },
    );
    expect(result.status).toBe('timeout');
    expect(result.signal).toBe('SIGTERM');
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('terminates on interruption and returns no partial diagnostics', async () => {
    const controller = new AbortController();
    const promise = run("process.stderr.write('partial'); setTimeout(() => process.exit(0), 300)", {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 80);
    const result = await promise;
    expect(result.status).toBe('interrupted');
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('terminates on output limit and discards all captured output', async () => {
    const result = await run(
      "process.stdout.write('x'.repeat(100_000)); setTimeout(() => process.exit(0), 300)",
      {
        maxOutputBytes: 128,
      },
    );
    expect(result.status).toBe('output-limit');
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.outputBytes).toBeGreaterThan(128);
  });

  it('classifies spawn failure without exposing the command or raw error', async () => {
    const result = await runProtectedChild({
      command: '/definitely/not/a/real/program-secret-name',
      args: ['private-arg'],
      cwd: process.cwd(),
      envAllowlist: [],
      timeoutMs: 500,
      maxOutputBytes: 128,
    });
    expect(result.status).toBe('spawn-error');
    expect(JSON.stringify(result)).not.toContain('/definitely/not/a/real');
    expect(JSON.stringify(result)).not.toContain('private-arg');
    expect(result.stderr).toBe('');
  });

  it('copies only explicitly allowlisted environment keys', async () => {
    setTestEnv('EVAL_CAPTURE_ALLOW', 'visible-marker');
    setTestEnv('TELEGRAM_BOT_TOKEN', 'do-not-forward-telegram');
    setTestEnv('DATABASE_ADMIN_URL', 'do-not-forward-database');
    const result = await run(
      'process.stdout.write(JSON.stringify({ allowed: process.env.EVAL_CAPTURE_ALLOW, telegram: process.env.TELEGRAM_BOT_TOKEN, admin: process.env.DATABASE_ADMIN_URL }))',
      { envAllowlist: ['PATH', 'EVAL_CAPTURE_ALLOW'] },
    );
    expect(JSON.parse(result.stdout)).toEqual({ allowed: 'visible-marker' });
    expect(result.stdout).not.toContain('do-not-forward');
  });

  it('redacts values of allowlisted credential environment variables', async () => {
    setTestEnv('EVAL_TEST_DATABASE_URL', 'opaque-eval-password-marker');
    const result = await run(
      "process.stdout.write(process.env.EVAL_TEST_DATABASE_URL ?? 'missing')",
      {
        envAllowlist: ['EVAL_TEST_DATABASE_URL'],
      },
    );
    expect(result.stdout).toBe('[redacted]');
    expect(JSON.stringify(result)).not.toContain('opaque-eval-password-marker');
  });
});
