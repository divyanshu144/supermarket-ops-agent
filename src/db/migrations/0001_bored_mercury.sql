CREATE TYPE "public"."bill_status" AS ENUM('draft', 'finalized', 'void');--> statement-breakpoint
CREATE TYPE "public"."khata_kind" AS ENUM('charge', 'payment', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."movement_kind" AS ENUM('receive', 'sale', 'adjust', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."payment_mode" AS ENUM('cash', 'upi', 'card', 'khata');--> statement-breakpoint
CREATE TYPE "public"."update_status" AS ENUM('claimed', 'done');--> statement-breakpoint
CREATE TABLE "bill_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"qty_base" bigint NOT NULL,
	"unit_price_paise" bigint NOT NULL,
	"gst_rate_bps" integer NOT NULL,
	"hsn_code" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" bigint NOT NULL,
	"status" "bill_status" DEFAULT 'draft' NOT NULL,
	"customer_name" text,
	"payment_mode" "payment_mode",
	"payment_ref" text,
	"subtotal_paise" bigint,
	"cgst_paise" bigint,
	"sgst_paise" bigint,
	"round_off_paise" bigint,
	"total_paise" bigint,
	"invoice_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"store_id" bigint NOT NULL,
	"key" text NOT NULL,
	"operation" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_store_id_key_pk" PRIMARY KEY("store_id","key")
);
--> statement-breakpoint
CREATE TABLE "khata_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" bigint NOT NULL,
	"customer_name" text NOT NULL,
	"phone" text,
	"balance_paise" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "khata_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "khata_kind" NOT NULL,
	"amount_paise" bigint NOT NULL,
	"bill_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preferences" (
	"store_id" bigint NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preferences_store_id_key_pk" PRIMARY KEY("store_id","key")
);
--> statement-breakpoint
CREATE TABLE "processed_updates" (
	"update_id" bigint PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"status" "update_status" DEFAULT 'claimed' NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"store_id" bigint PRIMARY KEY NOT NULL,
	"agent_session_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" bigint NOT NULL,
	"product_id" uuid NOT NULL,
	"kind" "movement_kind" NOT NULL,
	"qty_base_delta" bigint NOT NULL,
	"bill_id" uuid,
	"unit_cost_paise" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bill_items" ADD CONSTRAINT "bill_items_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_items" ADD CONSTRAINT "bill_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "khata_accounts" ADD CONSTRAINT "khata_accounts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "khata_entries" ADD CONSTRAINT "khata_entries_account_id_khata_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."khata_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "khata_entries" ADD CONSTRAINT "khata_entries_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bills_store_invoice_uq" ON "bills" USING btree ("store_id","invoice_number") WHERE "bills"."invoice_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "bills_store_created_idx" ON "bills" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "khata_store_name_uq" ON "khata_accounts" USING btree ("store_id",lower("customer_name"));