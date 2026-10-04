import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { pool } from './client.js';
import { acquireInstanceLock } from './instance-lock.js';

const held: Array<() => Promise<void>> = [];
async function acquire(opts?: { pollMs?: number; timeoutMs?: number }) {
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
});
