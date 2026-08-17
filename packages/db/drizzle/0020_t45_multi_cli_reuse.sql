ALTER TABLE "tunnel_pairing" ADD COLUMN "db_fingerprint" text;--> statement-breakpoint
ALTER TABLE "tunnel_pairing" ADD COLUMN "db_schema_checksum" text;--> statement-breakpoint
ALTER TABLE "tunnel_session" ADD COLUMN "cli_fingerprint" text;--> statement-breakpoint

-- T4/5 backfill : chaque tunnel_session hérite du cli_fingerprint de sa
-- db_connection (le CLI unique qui l'a créée avant le refactor multi-CLI).
-- Après ce backfill, les sessions historiques restent auth-able ; les
-- nouvelles portent le cli_fingerprint réel du CLI attaché (potentiellement
-- différent de dbConnection.cliFingerprint dans le cas multi-device).
UPDATE "tunnel_session" ts SET
  "cli_fingerprint" = dc."cli_fingerprint"
FROM "db_connection" dc
WHERE ts."connection_id" = dc."id"
  AND ts."cli_fingerprint" IS NULL;