-- C.5 : Rattacher canvas_state à db_connection au lieu de (engine, tables).
-- Ancien modèle (user_id, schema_signature) provoquait collisions dès que
-- 2 db_connections partageaient le même set de tables (ex : 2 DBs Prisma).
-- Nouveau modèle (user_id, db_connection_id) = 1 canvas par connection.
-- Migration DESTRUCTIVE : les rows existantes sont supprimées (dev only,
-- positions déjà buggées à cause du modèle précédent).

DELETE FROM "canvas_state";
--> statement-breakpoint
DROP INDEX IF EXISTS "canvas_user_schema_unique";
--> statement-breakpoint
ALTER TABLE "canvas_state" DROP COLUMN IF EXISTS "schema_signature";
--> statement-breakpoint
ALTER TABLE "canvas_state" ADD COLUMN "db_connection_id" uuid NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvas_state" ADD CONSTRAINT "canvas_state_db_connection_id_db_connection_id_fk" FOREIGN KEY ("db_connection_id") REFERENCES "public"."db_connection"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "canvas_user_connection_unique" ON "canvas_state" USING btree ("user_id","db_connection_id");
