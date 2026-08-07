-- C.21.1 : seed data — pour chaque user existant, créer une team «
-- Personal » avec un slug 6 hex unique. Idempotent (skip si l'user en
-- a déjà une nommée « Personal »).
--
-- Slug 6 hex tiré de md5(user_id || random() || attempt). ~16M combos
-- suffisent largement pour un déploiement V1 (birthday collision <1e-6
-- à 100 users). On boucle jusqu'à 10 tentatives par user au cas où —
-- au-delà, on lève : la contrainte unique fera son travail.
--
-- Le name par défaut = user.name (Better Auth le stocke) sinon
-- « Personal ». `user.name` est `notNull default ''` → on filtre le
-- vide via NULLIF avant COALESCE.

DO $$
DECLARE
	u RECORD;
	slug_candidate TEXT;
	attempt INT;
BEGIN
	FOR u IN SELECT id, name FROM "user" LOOP
		IF NOT EXISTS (
			SELECT 1 FROM "team"
			WHERE owner_id = u.id AND name = COALESCE(NULLIF(u.name, ''), 'Personal')
		) THEN
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
						RAISE EXCEPTION 'C.21.1 seed: impossible de trouver un slug unique pour user %', u.id;
					END IF;
				END;
			END LOOP;
		END IF;
	END LOOP;
END $$;
