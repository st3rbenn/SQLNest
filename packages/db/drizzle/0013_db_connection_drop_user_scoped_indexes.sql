-- C.21.2 : drop les indexes user-scoped historiques sur db_connection.
--
-- Devenus REDONDANTS en V1 (1 team par user → team_id ↔ user_id
-- équivalents) et BLOQUANTS en V2 (un user avec 2 teams pourrait
-- vouloir la même DSN name "prod" dans chaque). Les indexes
-- team-scoped `db_connection_team_name_unique` et
-- `db_connection_team_fingerprint_unique` (ajoutés en 0012) prennent
-- le relais.
--
-- Les routes legacy qui font `WHERE user_id = X AND name = Y` (proxy,
-- preview-snapshot, upsert historique) continuent de fonctionner —
-- juste sans l'index dédié (seq scan sur une table peu peuplée, cost
-- négligeable). Elles seront supprimées en C.21.7.

DROP INDEX IF EXISTS "db_connection_user_name_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "db_connection_user_fingerprint_unique";
