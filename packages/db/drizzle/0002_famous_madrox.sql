ALTER TABLE "user" ALTER COLUMN "name" SET DEFAULT '';--> statement-breakpoint
-- Backfill : Postgres SET DEFAULT n'update PAS les lignes existantes → sans
-- ce UPDATE, la SET NOT NULL suivante crashe si un user a été créé sous 0001
-- avec name IS NULL. Idempotent (safe sur env fresh comme sur env peuplé).
UPDATE "user" SET "name" = '' WHERE "name" IS NULL;--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_expires_at_idx" ON "session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_expires_at_idx" ON "verification" USING btree ("expires_at");--> statement-breakpoint
-- Index fonctionnel case-insensitive sur user.email — ajouté à la main car
-- drizzle-kit ne génère pas les expressions d'index (lower(col), etc.).
-- Empêche `Alice@x.com` et `alice@x.com` de coexister et protège contre les
-- attaques d'énumération par variation de casse.
CREATE UNIQUE INDEX IF NOT EXISTS "user_email_lower_unique" ON "user" (lower(email));