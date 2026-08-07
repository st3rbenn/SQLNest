CREATE TABLE IF NOT EXISTS "api_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"hash" text NOT NULL,
	"prefix" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "db_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"cli_fingerprint" text NOT NULL,
	"engine" text NOT NULL,
	"engine_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active_since" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tunnel_pairing" (
	"code" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"cli_pubkey_ed25519" text NOT NULL,
	"device_name" text,
	"approved_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_token" ADD CONSTRAINT "api_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "db_connection" ADD CONSTRAINT "db_connection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tunnel_pairing" ADD CONSTRAINT "tunnel_pairing_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_token_hash_unique" ON "api_token" USING btree ("hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_token_user_name_active_unique" ON "api_token" USING btree ("user_id","name") WHERE "api_token"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_token_user_id_idx" ON "api_token" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "db_connection_user_name_unique" ON "db_connection" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "db_connection_fingerprint_idx" ON "db_connection" USING btree ("cli_fingerprint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "db_connection_user_id_idx" ON "db_connection" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tunnel_pairing_expires_at_idx" ON "tunnel_pairing" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tunnel_pairing_user_id_idx" ON "tunnel_pairing" USING btree ("user_id");