// Schéma de démo SQLNest (MongoDB), miroir du schéma Postgres.
// Exécuté au premier démarrage par l'entrypoint de l'image mongo.
// `_id` numériques explicites pour refléter les ids bigint côté Postgres et
// permettre un join `orders.user_id -> users._id` identique cross-db.

const target = db.getSiblingDB("sqlnest_demo");

target.users.insertMany([
	{ _id: 1, email: "ada@example.com", display_name: "Ada Lovelace", is_active: true },
	{ _id: 2, email: "alan@example.com", display_name: "Alan Turing", is_active: true },
	{ _id: 3, email: "grace@example.com", display_name: "Grace Hopper", is_active: false }
]);

target.orders.insertMany([
	{ _id: 1, user_id: 1, total_cents: 1299, status: "paid" },
	{ _id: 2, user_id: 1, total_cents: 4500, status: "pending" },
	{ _id: 3, user_id: 2, total_cents: 999, status: "paid" }
]);
