import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { pool } from './client.js';
import { acquireInstanceLock, INSTANCE_LOCK_KEY } from './instance-lock.js';

const held: Array<() => Promise<void>> = [];
async function acquire(opts?: { pollMs?: number; timeoutMs?: number; onLost?: () => void }) {
  const release = await acquireInstanceLock(opts);
  let done = false;
  const once = async () => {
    if (done) return;
    done = true;
    await release();
  };
  held.push(once);
  return once;
}

afterEach(async () => {
  for (const r of held.splice(0)) await r();
});
afterAll(() => pool.end());

describe('acquireInstanceLock', () => {
  it('acquires when free', async () => {
    await expect(acquire()).resolves.toBeTypeOf('function');
  });

  it('rejects after the timeout while held, leaving the lock free afterwards', async () => {
    const first = await acquire();
    await expect(acquire({ pollMs: 20, timeoutMs: 200 })).rejects.toThrow(
      /Could not acquire the instance lock/,
    );
    await first();
    await expect(acquire({ pollMs: 20, timeoutMs: 200 })).resolves.toBeTypeOf('function');
  });

  it('can be acquired again after release', async () => {
    const first = await acquire();
    await first();
    await expect(acquire({ pollMs: 20, timeoutMs: 200 })).resolves.toBeTypeOf('function');
  });

  it('waits for a held lock and acquires once it is released', async () => {
    const first = await acquire();
    const second = acquire({ pollMs: 20, timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 100));
    await first();
    await expect(second).resolves.toBeTypeOf('function');
  });

  it('calls onLost exactly once when the lock connection is killed after acquisition', async () => {
    const onLost = vi.fn();
    const errLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await acquire({ onLost });
      const holder = await pool.query<{ pid: number }>(
        `SELECT pid FROM pg_locks
          WHERE locktype = 'advisory' AND granted
            AND ((classid::bigint << 32) | objid::bigint) = $1::bigint`,
        [INSTANCE_LOCK_KEY.toString()],
      );
      expect(holder.rows).toHaveLength(1);
      await pool.query('SELECT pg_terminate_backend($1)', [holder.rows[0]!.pid]);
      for (let i = 0; i < 40 && onLost.mock.calls.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // Let a trailing 'end' after the 'error' arrive; it must not fire a second call.
      await new Promise((r) => setTimeout(r, 200));
      expect(onLost).toHaveBeenCalledTimes(1);
      for (const call of errLog.mock.calls) {
        expect(String(call[0])).toContain('instance-lock');
        expect(String(call[0])).not.toContain('terminating connection');
      }
    } finally {
      errLog.mockRestore();
    }
    // The dead client was discarded by the pool: the lock is free and the pool still works.
    await expect(acquire({ pollMs: 20, timeoutMs: 2000 })).resolves.toBeTypeOf('function');
  });

  it('does not call onLost on a normal release', async () => {
    const onLost = vi.fn();
    const release = await acquire({ onLost });
    await release();
    await new Promise((r) => setTimeout(r, 100));
    expect(onLost).not.toHaveBeenCalled();
  });
});
