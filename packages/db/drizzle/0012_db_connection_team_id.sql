-- C.21.2 : ajoute `team_id` FK team cascade sur `db_connection`.
-- Migration en 3 phases pour préserver les rows existants :
--   1. ADD COLUMN nullable
--   2. UPDATE data : chaque row hérite de la team la plus ancienne de
--      son owner (= la team « Personal » créée en C.21.1).
--   3. ALTER SET NOT NULL + ADD FK + indexes team-scoped.
--
-- Les vieux indexes user-scoped (name, fingerprint) sont conservés
-- pendant C.21 pour la compat rétro (routes legacy). Drop en C.21.7.

-- Phase 1 — colonne nullable
ALTER TABLE "db_connection" ADD COLUMN "team_id" uuid;
--> statement-breakpoint

-- Phase 1.5 — filet de sécurité : crée une team pour tout user qui a
-- des db_connection sans avoir de team. Nécessaire pour que 0012
-- s'applique sur des DBs qui n'ont pas suivi le chemin nominal
-- 0010 → 0011 → 0012 (test DBs peuplées par des runs partiels,
-- restore d'un backup pre-C.21, etc.). En prod nominal c'est un no-op.
DO $$
DECLARE
	u RECORD;
	slug_candidate TEXT;
	attempt INT;
BEGIN
	FOR u IN
		SELECT DISTINCT u2.id, u2.name
		FROM "user" u2
		WHERE EXISTS (SELECT 1 FROM "db_connection" WHERE user_id = u2.id)
		AND NOT EXISTS (SELECT 1 FROM "team" WHERE owner_id = u2.id)
	LOOP
		attempt := 0;
		LOOP
			slug_candidate := substring(md5(u.id || random()::text || attempt::text), 1, 6);
			BEGIN
				INSERT INTO "team" (slug, name, owner_id)
				VALUES (
					slug_candidate,
					COALESCE(NULLIF(u.name, ''), 'Personal'),
					u.id
				);
				EXIT;
			EXCEPTION WHEN unique_violation THEN
				attempt := attempt + 1;
				IF attempt >= 10 THEN
					RAISE EXCEPTION 'C.21.2 filet: impossible de trouver un slug unique pour user %', u.id;
				END IF;
			END;
		END LOOP;
	END LOOP;
END $$;
--> statement-breakpoint

-- Phase 2 — backfill : chaque db_connection hérite de la team perso de
-- son owner. La subquery prend la team la plus ancienne (créée par le
-- seed 0011, le hook signup ou le filet phase 1.5) — en V1 chaque
-- user a exactement UNE team, donc pas d'ambiguïté. Si un user n'a
-- aucune team après phase 1.5 (cas impossible), la phase 2.5 lève.
UPDATE "db_connection" dc
SET team_id = (
	SELECT id FROM "team"
	WHERE owner_id = dc.user_id
	ORDER BY created_at ASC
	LIMIT 1
);
--> statement-breakpoint

DO $$
DECLARE
	orphan_count INT;
BEGIN
	SELECT COUNT(*) INTO orphan_count FROM "db_connection" WHERE team_id IS NULL;
	IF orphan_count > 0 THEN
		RAISE EXCEPTION 'C.21.2: % db_connection sans team après backfill — vérifie que 0011_team_seed_existing_users a bien tourné', orphan_count;
	END IF;
END $$;
--> statement-breakpoint

-- Phase 3 — verrouillage NOT NULL + FK + indexes team-scoped
ALTER TABLE "db_connection" ALTER COLUMN "team_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "db_connection" ADD CONSTRAINT "db_connection_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "db_connection_team_name_unique" ON "db_connection" USING btree ("team_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "db_connection_team_fingerprint_unique" ON "db_connection" USING btree ("team_id","cli_fingerprint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "db_connection_team_id_idx" ON "db_connection" USING btree ("team_id");
