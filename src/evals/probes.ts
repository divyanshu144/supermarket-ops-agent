import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { redact } from '../shared/redact.js';

export type ProtectedChildStatus =
  'completed' | 'timeout' | 'interrupted' | 'output-limit' | 'spawn-error';

export interface ProtectedChildOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  /** Names to copy from this process. No other environment entries are inherited. */
  envAllowlist: readonly string[];
  /** Literal values to remove from all returned child text. */
  secrets?: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface ProtectedChildResult {
  status: ProtectedChildStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  outputBytes: number;
}

const REDACTED_URL = '[redacted-url]';
const REDACTED_VALUE = '[redacted]';
// Captured stdout may contain connection strings from old probes. Redact every URI scheme,
// not only web URLs, because postgres:// and other schemes carry the same credential risk.
const URL_PATTERN = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const SENSITIVE_ENV_NAME =
  /(?:TOKEN|API_?KEY|PASSWORD|SECRET|CREDENTIAL|AUTH|(?:DATABASE|DB)_?URL)/i;

function validateOptions(options: ProtectedChildOptions): void {
  if (!options.command || !options.cwd) throw new TypeError('command and cwd are required');
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new TypeError('timeoutMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1) {
    throw new TypeError('maxOutputBytes must be a positive safe integer');
  }
  for (const name of options.envAllowlist) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TypeError('invalid environment key');
  }
}

function selectedEnvironment(names: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function selectedSecrets(names: readonly string[], secrets: readonly string[] = []): string[] {
  const values = [...secrets];
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && SENSITIVE_ENV_NAME.test(name)) values.push(value);
  }
  return values;
}

function terminateOwnedProcess(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    // `detached` gives this child its own process group on POSIX, so negative pid targets only
    // the group created for this invocation. On Windows, fall back to killing the owned child.
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    // It may have exited between the status check and kill.
  }
}

function forceTerminateOwnedProcess(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    // It may have exited between the status check and kill.
  }
}

function sanitize(text: string, secrets: readonly string[]): string {
  let safe = text;
  for (const secret of secrets) {
    if (secret.length > 0) safe = safe.split(secret).join(REDACTED_VALUE);
  }
  safe = String(redact(safe));
  return safe.replace(URL_PATTERN, REDACTED_URL);
}

/** Run a child without inheriting output streams or environment by accident. */
export function runProtectedChild(options: ProtectedChildOptions): Promise<ProtectedChildResult> {
  validateOptions(options);
  const startedAt = performance.now();
  const effectiveSecrets = selectedSecrets(options.envAllowlist, options.secrets);
  if (options.signal?.aborted) {
    return Promise.resolve({
      status: 'interrupted',
      stdout: '',
      stderr: '',
      exitCode: null,
      signal: null,
      durationMs: 0,
      outputBytes: 0,
    });
  }

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(options.command, [...options.args], {
        cwd: options.cwd,
        env: selectedEnvironment(options.envAllowlist),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch {
      resolve(emptyResult('spawn-error', startedAt));
      return;
    }

    const stdout: Buffer[] = [];
    // Drain stderr so a child cannot block on a full pipe, but never expose it. Error messages
    // are arbitrary prose and cannot be safely classified by a generic subprocess wrapper.
    let outputBytes = 0;
    let status: ProtectedChildStatus = 'completed';
    let ended = false;
    let forceKill: NodeJS.Timeout | undefined;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;

    const stop = (reason: 'timeout' | 'interrupted' | 'output-limit') => {
      if (ended || status !== 'completed') return;
      status = reason;
      terminateOwnedProcess(child);
      forceKill = setTimeout(() => forceTerminateOwnedProcess(child), 250);
      forceKill.unref();
    };

    const onAbort = () => stop('interrupted');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => stop('timeout'), options.timeoutMs);
    timeout.unref();

    const finish = () => {
      if (ended) return;
      ended = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      options.signal?.removeEventListener('abort', onAbort);
      // Failed or interrupted children may have stopped halfway through a credential or UTF-8
      // sequence. In those cases the only provably safe diagnostic is the stable classification.
      const discard = status !== 'completed';
      const decode = (chunks: Buffer[]) =>
        sanitize(Buffer.concat(chunks).toString('utf8'), effectiveSecrets);
      resolve({
        status,
        stdout: discard ? '' : decode(stdout),
        stderr: '',
        exitCode,
        signal: exitSignal,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        outputBytes,
      });
    };

    const collect = (target: Buffer[], chunk: Buffer | string) => {
      if (ended || status === 'output-limit') return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (outputBytes + bytes.length > options.maxOutputBytes) {
        outputBytes += bytes.length;
        stop('output-limit');
        return;
      }
      outputBytes += bytes.length;
      target.push(bytes);
    };

    child.stdout?.on('data', (chunk: Buffer | string) => collect(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      if (ended || status === 'output-limit') return;
      if (outputBytes + bytes > options.maxOutputBytes) {
        outputBytes += bytes;
        stop('output-limit');
      } else {
        outputBytes += bytes;
      }
    });
    child.once('error', () => {
      if (status === 'completed') status = 'spawn-error';
    });
    child.once('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    // `close`, unlike `exit`, waits until both piped streams have closed. It also follows spawn
    // errors, so this is the single resolution point for all child lifecycle outcomes.
    child.once('close', finish);
  });
}

function emptyResult(status: ProtectedChildStatus, startedAt: number): ProtectedChildResult {
  return {
    status,
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    outputBytes: 0,
  };
}
