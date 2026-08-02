CREATE TABLE IF NOT EXISTS "session_kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_kv_expires_at_idx" ON "session_kv" USING btree ("expires_at");