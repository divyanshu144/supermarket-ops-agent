-- Hand-edited after generation: the column is NOT NULL and has no default, so existing rows are
-- backfilled between the ADD and the SET NOT NULL. Ordering by id is arbitrary but stable, which
-- is all history needs — from here on the repository assigns line_no explicitly.
ALTER TABLE "bill_items" ADD COLUMN "line_no" integer;--> statement-breakpoint
UPDATE "bill_items" AS bi
SET "line_no" = ranked.rn
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "bill_id" ORDER BY "id") AS rn
  FROM "bill_items"
) AS ranked
WHERE bi."id" = ranked."id";--> statement-breakpoint
ALTER TABLE "bill_items" ALTER COLUMN "line_no" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bill_items_bill_line_uq" ON "bill_items" USING btree ("bill_id","line_no");--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_finalized_has_invoice" CHECK ("bills"."status" <> 'finalized' OR "bills"."invoice_number" IS NOT NULL);
