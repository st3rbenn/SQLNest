CREATE TABLE IF NOT EXISTS "canvas_checksum_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canvas_state_id" uuid NOT NULL,
	"db_connection_id" uuid,
	"db_schema_checksum" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "canvas_state" DROP CONSTRAINT "canvas_state_db_connection_id_db_connection_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "canvas_user_connection_unique";--> statement-breakpoint
ALTER TABLE "canvas_state" ALTER COLUMN "db_connection_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "canvas_state" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "canvas_state" ADD COLUMN "db_fingerprint" text;--> statement-breakpoint
ALTER TABLE "canvas_state" ADD COLUMN "db_schema_checksums" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint

-- T4/4 backfill : populate team_id + db_fingerprint + db_schema_checksums
-- depuis db_connection pour chaque canvas existant. Les canvas legacy sans
-- db_connection valide (impossible en pratique car FK NOT NULL avant ce
-- refactor) restent avec les colonnes à NULL — retomberont sur l'index
-- legacy `canvas_user_connection_legacy_unique`.
UPDATE "canvas_state" cs SET
  "team_id" = dc."team_id",
  "db_fingerprint" = dc."db_fingerprint",
  "db_schema_checksums" = CASE
    WHEN dc."db_schema_checksum" IS NOT NULL
      THEN ARRAY[dc."db_schema_checksum"]::text[]
    ELSE ARRAY[]::text[]
  END
FROM "db_connection" dc
WHERE cs."db_connection_id" = dc."id";--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "canvas_checksum_event" ADD CONSTRAINT "canvas_checksum_event_canvas_state_id_canvas_state_id_fk" FOREIGN KEY ("canvas_state_id") REFERENCES "public"."canvas_state"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvas_checksum_event" ADD CONSTRAINT "canvas_checksum_event_db_connection_id_db_connection_id_fk" FOREIGN KEY ("db_connection_id") REFERENCES "public"."db_connection"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canvas_checksum_event_canvas_idx" ON "canvas_checksum_event" USING btree ("canvas_state_id","seen_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvas_state" ADD CONSTRAINT "canvas_state_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvas_state" ADD CONSTRAINT "canvas_state_db_connection_id_db_connection_id_fk" FOREIGN KEY ("db_connection_id") REFERENCES "public"."db_connection"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "canvas_user_team_fp_unique" ON "canvas_state" USING btree ("user_id","team_id","db_fingerprint") WHERE "canvas_state"."db_fingerprint" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "canvas_user_connection_legacy_unique" ON "canvas_state" USING btree ("user_id","db_connection_id") WHERE "canvas_state"."db_fingerprint" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canvas_team_checksums_gin_idx" ON "canvas_state" USING gin ("db_schema_checksums") WHERE array_length("canvas_state"."db_schema_checksums", 1) > 0;