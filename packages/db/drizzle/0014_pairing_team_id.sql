ALTER TABLE "tunnel_pairing" ADD COLUMN "team_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tunnel_pairing" ADD CONSTRAINT "tunnel_pairing_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
