CREATE TABLE IF NOT EXISTS "tunnel_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tunnel_session" ADD CONSTRAINT "tunnel_session_connection_id_db_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."db_connection"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tunnel_session_hash_unique" ON "tunnel_session" USING btree ("hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tunnel_session_connection_id_idx" ON "tunnel_session" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tunnel_session_expires_at_idx" ON "tunnel_session" USING btree ("expires_at");