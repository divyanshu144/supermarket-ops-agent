CREATE TYPE "public"."unit" AS ENUM('kg', 'g', 'litre', 'ml', 'packet', 'dozen', 'piece');--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" bigint NOT NULL,
	"name" text NOT NULL,
	"brand" text,
	"pack_size" text,
	"unit" "unit" NOT NULL,
	"is_loose" boolean DEFAULT false NOT NULL,
	"hsn_code" text NOT NULL,
	"gst_rate_bps" integer NOT NULL,
	"cost_price_paise" bigint NOT NULL,
	"mrp_paise" bigint NOT NULL,
	"quantity_base" bigint DEFAULT 0 NOT NULL,
	"reorder_level_base" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "products_qty_non_negative" CHECK ("products"."quantity_base" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"gstin" text NOT NULL,
	"state_code" text DEFAULT '27' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "products_store_name_uq" ON "products" USING btree ("store_id","name");--> statement-breakpoint
CREATE INDEX "products_store_idx" ON "products" USING btree ("store_id");