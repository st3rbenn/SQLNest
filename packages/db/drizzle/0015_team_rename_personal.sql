-- C.21 UX fix : renomme la team perso au format « <shortName>'s team »
-- (pattern Notion) — plus expressif que « Personal » et différencié du
-- user_name affiché juste au-dessus dans la sidebar.
--
-- `shortName` = partie avant `@` si `user.name` est un email (fallback
-- Better Auth quand `name` n'est pas fourni au signup), sinon `user.name`
-- tel quel. Cohérent avec `defaultTeamNameForUser` côté TS.
--
-- Idempotent : ne touche QUE :
--   - les teams dont le name = user.name (résidu du 1er seed 0011)
--   - les teams renommées « Personal » (résidu du fix intermédiaire)
-- Une team custom (renommée par l'user) reste inchangée.

UPDATE "team" t
SET name = CASE
	WHEN POSITION('@' IN COALESCE(u.name, '')) > 0
		THEN SPLIT_PART(u.name, '@', 1)
	WHEN COALESCE(u.name, '') = ''
		THEN 'User'
	ELSE u.name
END || '''s team'
FROM "user" u
WHERE t.owner_id = u.id
  AND (t.name = u.name OR t.name = 'Personal');
