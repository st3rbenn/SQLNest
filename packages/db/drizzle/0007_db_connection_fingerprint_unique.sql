-- C.6 : Pairing idempotent — un (user_id, cli_fingerprint) = une db_connection.
-- Avant : chaque `sqlnest connect` créait une nouvelle row même si le CLI
-- avait la même keypair Ed25519. Le canvas_state rattaché à l'ancienne
-- devenait orphelin à chaque relance.
--
-- Migration DESTRUCTIVE : les doublons existants (même user + même
-- fingerprint) sont supprimés — on ne garde que la row la plus récente
-- (max active_since). Les canvas_state et tunnel_session rattachés aux
-- rows supprimées cascadent automatiquement.

DELETE FROM "db_connection"
WHERE id NOT IN (
	SELECT DISTINCT ON (user_id, cli_fingerprint) id
	FROM "db_connection"
	ORDER BY user_id, cli_fingerprint, active_since DESC
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "db_connection_user_fingerprint_unique" ON "db_connection" USING btree ("user_id","cli_fingerprint");
