-- T4/1 : ajout du db_fingerprint sur db_connection.
--
-- Identifie l'instance DB elle-même (via pg_control_system pour PG,
-- SHA256 canonique pour Mongo) — indépendant du CLI qui s'y connecte.
-- Permet à un même user de retrouver son canvas quand il pair-e la
-- même DB depuis un 2e device (Mac + Windows), OU après un revoke
-- local + re-add.
--
-- Nullable : rétro-compat avec les db_connection existantes (pré-T4/1)
-- + les CLIs anciens qui ne remontent pas encore le fingerprint. Le
-- backend fait un backfill au premier connect qui l'envoie.
--
-- Index composite `(team_id, db_fingerprint)` : lookup rapide au
-- pairing pour détecter "est-ce que cette DB est déjà connue dans
-- cette team ?". NON unique volontairement : la même DB pair-ée depuis
-- 2 CLIs distincts crée 2 rows (chaque CLI a son cli_fingerprint).
-- La v2 pourra proposer une fusion UX si un même db_fingerprint existe
-- déjà avec un cli_fingerprint différent.

ALTER TABLE "db_connection" ADD COLUMN "db_fingerprint" text;--> statement-breakpoint
CREATE INDEX "db_connection_team_db_fingerprint_idx" ON "db_connection" USING btree ("team_id","db_fingerprint");
