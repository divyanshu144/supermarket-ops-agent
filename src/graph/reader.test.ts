import { describe, expect, it, vi } from 'vitest';
import { GRAPH_READ_TIMEOUT_MS, runGraphRead, type GraphQueryName } from './reader.js';

describe('graph read limits', () => {
  it('uses a fixed timeout for every whitelisted query', async () => {
    const executeRead = vi.fn(
      async (
        work: (tx: { run: typeof vi.fn }) => Promise<unknown>,
        config: { timeout: number },
      ) => {
        expect(config.timeout).toBe(GRAPH_READ_TIMEOUT_MS);
        return work({ run: vi.fn().mockResolvedValue({ records: [] }) });
      },
    );
    const session = { executeRead } as never;
    for (const name of ['explainStockChange', 'frequentlyBoughtWith'] satisfies GraphQueryName[]) {
      await runGraphRead(session, name, { storeId: '42', limit: 20 });
    }
    expect(executeRead).toHaveBeenCalledTimes(2);
  });
});
