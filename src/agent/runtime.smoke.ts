/**
 * Milestone 0 verification script. Not a unit test — it calls the real API and costs tokens.
 *
 * Run: pnpm tsx src/agent/runtime.smoke.ts
 *
 * Answers three questions from the design spec §14:
 *   1. Does the agent reach Postgres through a tool and ground its answer in real data?
 *   2. Do skills load with the allowlist ON? (highest risk — can invalidate spec §9)
 *   3. What does a simple query cost in latency at the configured effort level?
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { products, stores } from '../db/schema.js';
import { IdempotencyIssuer, toolContext } from '../tools/context.js';
import { runAgent } from './runtime.js';

const STORE = 999000006n;

function inStore<T>(updateId: bigint, fn: () => Promise<T>): Promise<T> {
  return toolContext.run(
    { storeId: STORE, updateId, idempotency: new IdempotencyIssuer(updateId) },
    fn,
  );
}

async function main(): Promise<void> {
  await db.delete(stores).where(eq(stores.id, STORE));
  await db.insert(stores).values({ id: STORE, name: 'Smoke Kirana', gstin: '27AAAAA0000A1Z5' });
  await db.insert(products).values({
    storeId: STORE,
    name: 'Sugar (loose)',
    unit: 'kg',
    isLoose: true,
    hsnCode: '17019990',
    gstRateBps: 0,
    costPricePaise: 4200,
    mrpPaise: 5200,
    quantityBase: 18_000,
  });

  const failures: string[] = [];

  // --- 1 & 3: grounding through a tool, and latency -------------------------------------
  const started = Date.now();
  const stock = await inStore(1n, () => runAgent({ text: 'how much sugar is left?' }));
  const elapsedMs = Date.now() - started;

  console.log('\n--- stock query ---');
  console.log('reply     :', stock.reply);
  console.log('toolsUsed :', stock.toolsUsed);
  console.log('latency   :', `${elapsedMs}ms`);
  console.log('effort    :', process.env.AGENT_EFFORT ?? 'medium');

  if (stock.toolsUsed.length === 0) failures.push('agent answered without calling any tool');
  if (!/\b18\b|eighteen/i.test(stock.reply)) {
    failures.push('reply does not reflect the real stock figure of 18 kg');
  }

  // --- 2: do skills load behind the allowlist? -----------------------------------------
  const probe = await inStore(2n, () => runAgent({ text: 'what is our shop mascot?' }));
  const skillsLoaded = /chotu/i.test(probe.reply);

  console.log('\n--- skill probe ---');
  console.log('reply     :', probe.reply);
  console.log('toolsUsed :', probe.toolsUsed);
  console.log('SKILLS LOAD BEHIND ALLOWLIST:', skillsLoaded ? 'YES' : 'NO');

  if (!skillsLoaded) {
    failures.push(
      'skills did NOT load with the allowlist on — spec §9 needs reshaping, see plan Task 9 Step 4',
    );
  }

  console.log('\n=== RESULT ===');
  if (failures.length > 0) {
    for (const f of failures) console.log('FAIL:', f);
  } else {
    console.log('PASS: grounded through tools, skills load, latency recorded');
  }

  await db.delete(stores).where(eq(stores.id, STORE));
  await pool.end();

  if (failures.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
