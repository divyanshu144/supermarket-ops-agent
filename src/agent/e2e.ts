/**
 * End-to-end walk of the brief's recording script, through the real agent and a real Postgres.
 *
 * Run: pnpm tsx src/agent/e2e.ts
 *
 * This is not a unit test — it calls the live API and costs tokens. It exists because every
 * layer below it is tested in isolation and none of that proves the model actually orchestrates
 * them. The seven beats are the ones the brief asks to see recorded:
 *
 *   receive stock -> multi-item bill with an edit -> oversell guard -> khata cycle ->
 *   PDF invoice -> analysis deck -> set a preference, /new, show it is remembered
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { bills, products, stores } from '../db/schema.js';
import { provisionStore } from '../repositories/stores.js';
import { readPreferences } from '../tools/preferences.js';
import { newToolContext, toolContext, type ProducedArtifact } from '../tools/context.js';
import { runAgent } from './runtime.js';

const STORE = 999000099n;

interface Beat {
  name: string;
  say: string;
  /** Returns null on success, or a description of what went wrong. */
  check: (
    reply: string,
    toolsUsed: string[],
    artifacts: ProducedArtifact[],
  ) => Promise<string | null>;
  /** Start a fresh conversation before this beat, as /new would. */
  freshChat?: boolean;
}

const used = (tools: string[], name: string) => tools.some((t) => t.endsWith(name));

const BEATS: Beat[] = [
  {
    name: '1. Receive stock',
    say: '50 packets of Maggi came in, cost 12 rupees, MRP 14',
    check: async (_reply, tools) => {
      if (!used(tools, 'receive_stock')) return 'did not call receive_stock';
      const [row] = await db.select().from(products).where(eq(products.storeId, STORE));
      const maggi = (await db.select().from(products).where(eq(products.storeId, STORE))).find(
        (p) => /maggi/i.test(p.name),
      );
      if (!maggi) return 'no Maggi row found';
      if (maggi.quantityBase !== 56) return `expected 6+50=56 packets, found ${maggi.quantityBase}`;
      if (maggi.mrpPaise !== 1400) return `MRP should be 1400 paise, found ${maggi.mrpPaise}`;
      void row;
      return null;
    },
  },
  {
    name: '2. Multi-item bill',
    say: 'make a bill: 2kg sugar, 1 aashirvaad atta, 4 maggi, 1 amul butter',
    check: async (_reply, tools) => {
      if (!used(tools, 'open_bill')) return 'did not open a bill';
      if (!used(tools, 'add_bill_item')) return 'did not add items';
      const drafts = await db.select().from(bills).where(eq(bills.storeId, STORE));
      if (!drafts.some((b) => b.status === 'draft')) return 'no draft bill exists';
      return null;
    },
  },
  {
    name: '3. Edit the bill mid-build',
    say: 'drop the butter, make it 6 maggi',
    check: async (_reply, tools) => {
      if (!used(tools, 'remove_bill_item') && !used(tools, 'update_bill_item')) {
        return 'did not edit the bill';
      }
      return null;
    },
  },
  {
    name: '4. Finalize on UPI',
    say: 'UPI, reference 998877',
    check: async (_reply, tools) => {
      if (!used(tools, 'finalize_bill')) return 'did not finalize';
      const finalized = (await db.select().from(bills).where(eq(bills.storeId, STORE))).filter(
        (b) => b.status === 'finalized',
      );
      if (finalized.length === 0) return 'no finalized bill in the database';
      if (!finalized[0]!.invoiceNumber) return 'finalized bill has no invoice number';
      return null;
    },
  },
  {
    name: '5. Oversell guard',
    say: 'make a bill for 500 maggi, cash',
    check: async (reply, tools) => {
      if (!used(tools, 'finalize_bill') && !used(tools, 'add_bill_item')) {
        return 'did not attempt the bill';
      }
      const maggi = (await db.select().from(products).where(eq(products.storeId, STORE))).find(
        (p) => /maggi/i.test(p.name),
      );
      if (!maggi) return 'no Maggi row';
      if (maggi.quantityBase < 0) return `STOCK WENT NEGATIVE: ${maggi.quantityBase}`;
      // The reply must actually tell the owner it could not be done.
      if (!/not enough|only|short|insufficient|cannot|can't/i.test(reply)) {
        return `reply does not communicate the refusal: "${reply.slice(0, 120)}"`;
      }
      return null;
    },
  },
  {
    name: '6. Khata charge',
    say: "put 500 rupees on Ramesh's credit",
    check: async (_reply, tools) => {
      if (!used(tools, 'charge_khata') && !used(tools, 'finalize_bill')) {
        return 'did not charge the khata';
      }
      return null;
    },
  },
  {
    name: '7. Khata balance',
    say: "what's Ramesh's balance?",
    check: async (reply, tools) => {
      if (!used(tools, 'get_khata_balance')) return 'did not look up the balance';
      if (!/\d/.test(reply)) return 'reply contains no figure';
      return null;
    },
  },
  {
    name: '8. Khata settlement',
    say: 'Ramesh paid 300',
    check: async (_reply, tools) =>
      used(tools, 'settle_khata') ? null : 'did not settle the khata',
  },
  {
    name: '9. Daily close',
    say: "today's sales?",
    check: async (_reply, tools) =>
      used(tools, 'daily_summary') ? null : 'did not run the daily summary',
  },
  {
    name: '10. PDF invoice',
    say: 'send me that bill as a PDF',
    check: async (_reply, tools, artifacts) => {
      if (!used(tools, 'generate_invoice_pdf')) return 'did not generate the invoice';
      if (artifacts.length === 0) return 'no artifact queued for delivery';
      if (!artifacts.some((a) => a.mime === 'application/pdf')) return 'artifact is not a PDF';
      return null;
    },
  },
  {
    name: '11. Analysis deck',
    say: "make this week's sales analysis deck",
    check: async (_reply, tools, artifacts) => {
      if (!used(tools, 'generate_analysis_deck')) return 'did not generate the deck';
      if (!artifacts.some((a) => a.filename.endsWith('.pptx'))) return 'no PPTX queued';
      return null;
    },
  },
  {
    name: '12. Set a preference',
    say: 'always assume UPI unless I say cash',
    check: async (_reply, tools) => {
      if (!used(tools, 'set_preference')) return 'did not save the preference';
      const prefs = await readPreferences(STORE);
      if (Object.keys(prefs).length === 0) return 'nothing was written to preferences';
      return null;
    },
  },
  {
    name: '13. Preference survives /new',
    freshChat: true,
    say: 'what payment mode do I usually use?',
    check: async (reply) =>
      /upi/i.test(reply)
        ? null
        : `fresh chat did not recall the preference: "${reply.slice(0, 120)}"`,
  },
];

async function main(): Promise<void> {
  await db.delete(stores).where(eq(stores.id, STORE));
  await provisionStore(STORE); // seeds the catalogue and two weeks of history

  let sessionId: string | undefined;
  let priorCostUsd = 0;
  let updateId = 1n;
  const failures: string[] = [];

  for (const beat of BEATS) {
    if (beat.freshChat) {
      sessionId = undefined; // exactly what /new does: drop the conversation, keep the shop
      priorCostUsd = 0;
      console.log('\n--- /new (fresh conversation) ---');
    }

    const context = newToolContext(STORE, updateId);
    const started = Date.now();

    // Read preferences fresh each turn, exactly as the Telegram adapter does.
    const preferences = await readPreferences(STORE);
    const result = await toolContext.run(context, () =>
      runAgent({ text: beat.say, sessionId, preferences, priorCostUsd }),
    );
    sessionId = result.sessionId || sessionId;
    priorCostUsd = result.totalCostUsd;
    updateId += 1n;

    const problem = await beat.check(result.reply, result.toolsUsed, context.artifacts);

    console.log(`\n${beat.name}`);
    console.log(`  owner : ${beat.say}`);
    console.log(`  agent : ${result.reply.replace(/\n/g, ' ').slice(0, 160)}`);
    console.log(`  tools : ${result.toolsUsed.join(', ') || '(none)'}`);
    console.log(`  time  : ${Date.now() - started}ms`);
    console.log(`  cost  : $${result.turnCostUsd.toFixed(4)} · ${result.outcome}`);
    console.log(`  result: ${problem ? `FAIL — ${problem}` : 'pass'}`);

    if (problem) failures.push(`${beat.name}: ${problem}`);
    if (result.outcome !== 'ok') failures.push(`${beat.name}: outcome ${result.outcome}`);
  }

  console.log('\n================ END-TO-END RESULT ================');
  if (failures.length === 0) {
    console.log(`PASS — all ${BEATS.length} beats`);
  } else {
    console.log(`FAIL — ${failures.length}/${BEATS.length} beats`);
    for (const f of failures) console.log(`  - ${f}`);
  }

  await db.delete(stores).where(eq(stores.id, STORE));
  await pool.end();
  if (failures.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
