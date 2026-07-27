-- Schéma de démo SQLNest (Postgres).
-- Exécuté au premier démarrage (volume vide) par l'entrypoint de l'image.
-- Pensé pour exercer les slices à venir :
--   - Slice 6 (introspection) : types, PK, contraintes, FK explicites.
--   - Slice 7 (exécution)     : join réel users -> orders.

CREATE TABLE users (
	id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	email         TEXT NOT NULL UNIQUE,
	display_name  TEXT,
	is_active     BOOLEAN NOT NULL DEFAULT TRUE,
	created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
	id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	user_id      BIGINT NOT NULL REFERENCES users (id),
	total_cents  BIGINT NOT NULL,
	status       TEXT NOT NULL DEFAULT 'pending',
	placed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX orders_user_id_idx ON orders (user_id);

INSERT INTO users (email, display_name, is_active) VALUES
	('ada@example.com',   'Ada Lovelace',    TRUE),
	('alan@example.com',  'Alan Turing',     TRUE),
	('grace@example.com', 'Grace Hopper',    FALSE);

-- Commandes rattachées aux utilisateurs (via l'email pour rester lisible).
INSERT INTO orders (user_id, total_cents, status)
SELECT u.id, v.total_cents, v.status
FROM (VALUES
	('ada@example.com',   1299, 'paid'),
	('ada@example.com',   4500, 'pending'),
	('alan@example.com',   999, 'paid')
) AS v (email, total_cents, status)
JOIN users u ON u.email = v.email;
