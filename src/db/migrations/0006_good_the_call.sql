CREATE TYPE "public"."pending_action_status" AS ENUM('pending', 'processing', 'confirmed', 'cancelled');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"store_id" bigint NOT NULL,
	"action" text NOT NULL,
	"tool" text NOT NULL,
	"outcome" text NOT NULL,
	"update_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"callback_id" text NOT NULL,
	"store_id" bigint NOT NULL,
	"owner_user_id" bigint NOT NULL,
	"originating_update_id" bigint NOT NULL,
	"tool" text NOT NULL,
	"arguments" jsonb NOT NULL,
	"argument_hash" text NOT NULL,
	"bill_fingerprint" text,
	"status" "pending_action_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"processing_at" timestamp with time zone,
	"confirmed_update_id" bigint,
	"outcome" text,
	CONSTRAINT "pending_actions_callback_id_unique" UNIQUE("callback_id")
);
--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "owner_user_id" bigint;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_actions_store_status_idx" ON "pending_actions" USING btree ("store_id","status","expires_at");