import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test-setup.ts'],
    testTimeout: 15000,
    // bills.invariants.test.ts installs a global DDL trigger (`khata_failboat` on
    // khata_entries) as fault injection for its atomicity test. While that trigger exists,
    // any other test file concurrently inserting into khata_entries (e.g. khata.test.ts)
    // fails. Vitest runs test files in parallel by default, so this flake was intermittent
    // (~1 run in 5). Do not "optimise" this back to parallel — the trigger can't be scoped
    // to its own transaction because khata_entries has no store_id column, the account is
    // created inside the transaction under test, and a bill_id IS NOT NULL guard would break
    // bills.test.ts's khata finalizes. Cost: ~3.3s -> ~9.7s wall clock, worth it for a green suite.
    fileParallelism: false,
  },
});
