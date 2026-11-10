CREATE TABLE "graph_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" bigint NOT NULL,
	"event_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" text
);
--> statement-breakpoint
ALTER TABLE "graph_outbox" ADD CONSTRAINT "graph_outbox_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "graph_outbox_pending_idx" ON "graph_outbox" USING btree ("next_attempt_at","created_at") WHERE "graph_outbox"."processed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "graph_outbox_store_idx" ON "graph_outbox" USING btree ("store_id","created_at");