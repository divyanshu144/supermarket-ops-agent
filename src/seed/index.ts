import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { billItems, bills, khataAccounts, products, stockMovements } from '../db/schema.js';
import { computeLine } from '../domain/gst.js';
import { roundToNearestRupee } from '../domain/money.js';
import type { Unit } from '../domain/units.js';
import { CATALOGUE, SEED_KHATA } from './catalogue.js';

const HISTORY_DAYS = 14;
const BILLS_PER_DAY = 4;
const PAYMENT_MODES = ['cash', 'upi', 'card'] as const;

/** Deterministic pseudo-random so a seeded store is reproducible when debugging. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * Seeds a store's catalogue, khata accounts and ~2 weeks of sales history.
 *
 * History is dated relative to `now`, never to hardcoded calendar dates. With fixed dates,
 * "make this week's analysis deck" returns empty charts for anyone who messages the bot after
 * the seed window has passed — and the deck is one of the two headline artifacts.
 *
 * Seeded sales deliberately do NOT decrement `products.quantityBase`. The opening figures in
 * CATALOGUE are the intended *current* stock: Maggi sitting at 6 units is what makes the
 * oversell guard trivial to demonstrate, and it must not drift per store. The movements exist
 * so analytics has velocity data.
 */
export async function seedStore(storeId: bigint, now: Date = new Date()): Promise<void> {
  const inserted = await db
    .insert(products)
    .values(
      CATALOGUE.map((p) => ({
        storeId,
        name: p.name,
        brand: p.brand ?? null,
        packSize: p.packSize ?? null,
        unit: p.unit,
        isLoose: p.isLoose ?? false,
        hsnCode: p.hsnCode,
        gstRateBps: p.gstRateBps,
        costPricePaise: p.costPricePaise,
        mrpPaise: p.mrpPaise,
        quantityBase: p.openingBase,
        reorderLevelBase: p.reorderLevelBase,
      })),
    )
    .returning();

  await db.insert(khataAccounts).values(
    SEED_KHATA.map((k) => ({
      storeId,
      customerName: k.customerName,
      phone: k.phone,
      balancePaise: k.openingBalancePaise,
    })),
  );

  const rng = makeRng(Number(storeId % 100000n));

  for (let dayOffset = HISTORY_DAYS; dayOffset >= 1; dayOffset--) {
    for (let n = 0; n < BILLS_PER_DAY; n++) {
      const at = new Date(now.getTime() - dayOffset * 86_400_000 + n * 3_600_000);

      const picks = inserted.filter(() => rng() < 0.35).slice(0, 4);
      if (picks.length === 0) continue;

      let subtotal = 0;
      let cgst = 0;
      let sgst = 0;

      const lines = picks.map((p) => {
        const qtyBase = p.isLoose ? 500 * (1 + Math.floor(rng() * 4)) : 1 + Math.floor(rng() * 3);
        const amounts = computeLine({
          mrpPaise: p.mrpPaise,
          qtyBase,
          unit: p.unit as Unit,
          gstRateBps: p.gstRateBps,
        });
        subtotal += amounts.taxablePaise;
        cgst += amounts.cgstPaise;
        sgst += amounts.sgstPaise;
        return { product: p, qtyBase, amounts };
      });

      const gross = subtotal + cgst + sgst;
      const { totalPaise, roundOffPaise } = roundToNearestRupee(gross);

      const [bill] = await db
        .insert(bills)
        .values({
          storeId,
          status: 'finalized',
          paymentMode: PAYMENT_MODES[Math.floor(rng() * PAYMENT_MODES.length)]!,
          subtotalPaise: subtotal,
          cgstPaise: cgst,
          sgstPaise: sgst,
          roundOffPaise,
          totalPaise,
          invoiceNumber: `INV-${dayOffset}-${n}`,
          createdAt: at,
          finalizedAt: at,
        })
        .returning();

      await db.insert(billItems).values(
        lines.map((l) => ({
          billId: bill!.id,
          productId: l.product.id,
          qtyBase: l.qtyBase,
          unitPricePaise: l.product.mrpPaise,
          gstRateBps: l.product.gstRateBps,
          hsnCode: l.product.hsnCode,
        })),
      );

      await db.insert(stockMovements).values(
        lines.map((l) => ({
          storeId,
          productId: l.product.id,
          kind: 'sale' as const,
          qtyBaseDelta: -l.qtyBase,
          billId: bill!.id,
          createdAt: at,
        })),
      );
    }
  }
}

/** Restores a store to its just-provisioned state. Backs the `/reset` command. */
export async function reseedStore(storeId: bigint, now?: Date): Promise<void> {
  await db.delete(bills).where(eq(bills.storeId, storeId));
  await db.delete(khataAccounts).where(eq(khataAccounts.storeId, storeId));
  await db.delete(stockMovements).where(eq(stockMovements.storeId, storeId));
  await db.delete(products).where(eq(products.storeId, storeId));
  await seedStore(storeId, now);
}
