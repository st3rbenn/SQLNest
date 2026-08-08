-- C.21 UX fix — `team.is_personal` boolean + `name` default `''`.
--
-- Décision : on ne stocke plus jamais le display name des teams
-- perso (`<user.name>'s team`) en DB. À la place, `is_personal = true`
-- + `name = ''` → le frontend concatène `${user.name}'s team` à
-- l'affichage. Rationale :
--   - un rename `user.name` propage sans job de fond.
--   - la source of truth du name reste `user.name`.
--   - une team V2 collaborative (is_personal=false) stocke son name
--     custom, comme prévu.

ALTER TABLE "team" ALTER COLUMN "name" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "team" ADD COLUMN "is_personal" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Backfill : les teams créées via le hook signup / seed 0011 sont
-- toutes des teams perso — on les marque + on vide leur name (qui
-- portait `<user.name>'s team` ou variantes). Détection : team.owner
-- match ET team.name est déjà dans les patterns connus.
--
-- On considère perso :
--   - toute team dont l'owner n'en a qu'UNE seule (V1 = 1 team = 1 owner)
--   - OU dont le name matche `<user.name>'s team` / `Personal` /
--     `<user.name>` (résidus des différents seeds intermédiaires).
UPDATE "team" t
SET is_personal = true, name = ''
FROM (
	SELECT owner_id, MIN(id::text) AS first_id
	FROM "team"
	GROUP BY owner_id
	HAVING COUNT(*) = 1
) singleton
WHERE t.id::text = singleton.first_id;
--> statement-breakpoint

-- Filet complémentaire : les teams résiduelles avec un name qui matche
-- explicitement les patterns générés par les seeds intermédiaires.
UPDATE "team" t
SET is_personal = true, name = ''
FROM "user" u
WHERE t.owner_id = u.id
  AND t.is_personal = false
  AND (
	t.name = u.name
	OR t.name = 'Personal'
	OR t.name = 'My team'
	OR t.name = CASE
		WHEN POSITION('@' IN COALESCE(u.name, '')) > 0
			THEN SPLIT_PART(u.name, '@', 1)
		ELSE u.name
	END || '''s team'
  );
