CREATE TABLE "session_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_key" text NOT NULL,
	"session_id" text NOT NULL,
	"subpath" text DEFAULT '' NOT NULL,
	"entry_uuid" text,
	"entry" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "session_entries_lookup_idx" ON "session_entries" USING btree ("session_id","project_key","subpath","id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_entries_uuid_uq" ON "session_entries" USING btree ("project_key","session_id","subpath","entry_uuid") WHERE "session_entries"."entry_uuid" is not null;