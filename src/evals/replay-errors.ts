export interface SafeReplayFailure {
  name: 'ReplayWorkerError';
  code: string | null;
}

/** Drops driver messages, stacks, URLs, and parameters before any worker error crosses IPC. */
export function safeReplayFailure(error: unknown): SafeReplayFailure {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null;
  return {
    name: 'ReplayWorkerError',
    code: code && /^[A-Z0-9_]{1,32}$/.test(code) ? code : null,
  };
}

export function replayFailureMessage(_failure: SafeReplayFailure): string {
  return 'Replay worker failed; details are redacted.';
}
