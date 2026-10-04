CREATE TABLE "invite_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_by_chat" bigint,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "invite_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "usage" (
	"store_id" bigint NOT NULL,
	"day" date NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_store_id_day_pk" PRIMARY KEY("store_id","day")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "cost_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;