// Génère un dataset e-commerce déterministe et le charge À L'IDENTIQUE dans
// Postgres et MongoDB (base `sqlnest_shop`). Un seul jeu de données → la sortie
// SNQL est comparable entre les deux moteurs.
//
//   pnpm db:up && pnpm db:seed:shop
//
// Postgres : id BIGINT + FK déclarées.  MongoDB : _id numérique + champs <x>_id
// (l'heuristique de nommage infère les mêmes relations). `sqlnest_demo` (les 3
// lignes des tests) n'est pas touchée.

import { MongoClient } from "mongodb";
import pg from "pg";

const { Client } = pg;

const PG_ADMIN_URL =
	process.env.SEED_PG_URL ??
	"postgres://sqlnest:sqlnest@localhost:5433/postgres";
const MONGO_URL =
	process.env.SEED_MONGO_URL ??
	"mongodb://sqlnest:sqlnest@localhost:27017/?authSource=admin";
const DB = "sqlnest_shop";

// --- PRNG déterministe (reproductible) ---
function makeRng(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
}
const rng = makeRng(1337);
const int = (min, max) => min + Math.floor(rng() * (max - min + 1));
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const chance = (p) => rng() < p;

const BASE = Date.UTC(2023, 0, 1);
const YEAR = 365 * 24 * 3600 * 1000;
const dateWithin = (years) => new Date(BASE + Math.floor(rng() * years * YEAR));

const CATEGORY_NAMES = [
	"Electronics", "Books", "Home & Kitchen", "Clothing", "Sports", "Toys",
	"Beauty", "Garden", "Automotive", "Grocery", "Health", "Office", "Music",
	"Games", "Pet Supplies", "Tools", "Baby", "Shoes", "Jewelry", "Art",
	"Furniture", "Lighting", "Phones", "Cameras"
];
const FIRST = ["Ada", "Alan", "Grace", "Linus", "Margaret", "Dennis", "Barbara", "Ken", "Katherine", "Tim", "Radia", "Guido", "Bjarne", "Anita", "Donald", "Edsger", "Leslie", "Frances", "John", "Vint"];
const LAST = ["Lovelace", "Turing", "Hopper", "Torvalds", "Hamilton", "Ritchie", "Liskov", "Thompson", "Johnson", "Berners-Lee", "Perlman", "Rossum", "Stroustrup", "Borg", "Knuth", "Dijkstra", "Lamport", "Allen", "Backus", "Cerf"];
const CITIES = ["Paris", "Lyon", "Berlin", "Madrid", "Rome", "Amsterdam", "Lisbon", "Dublin", "Vienna", "Prague"];
const COUNTRIES = ["FR", "DE", "ES", "IT", "NL", "PT", "IE", "AT", "CZ", "BE"];
const STATUSES = ["pending", "paid", "shipped", "delivered", "cancelled"];
const ADJ = ["Pro", "Max", "Lite", "Ultra", "Eco", "Prime", "Nano", "Mega", "Smart", "Classic"];
const NOUN = ["Widget", "Gadget", "Gizmo", "Device", "Kit", "Tool", "Set", "Pack", "Unit", "Module"];

function generate() {
	const categories = CATEGORY_NAMES.map((name, i) => ({
		id: i + 1,
		name,
		slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-")
	}));

	const users = [];
	for (let i = 1; i <= 400; i++) {
		const first = pick(FIRST);
		const last = pick(LAST);
		users.push({
			id: i,
			email: `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, "")}${i}@example.com`,
			display_name: `${first} ${last}`,
			is_active: chance(0.85),
			created_at: dateWithin(2)
		});
	}

	const addresses = [];
	let addrId = 1;
	for (const u of users) {
		const n = int(0, 2);
		for (let k = 0; k < n; k++) {
			addresses.push({
				id: addrId++,
				user_id: u.id,
				line1: `${int(1, 200)} ${pick(LAST)} Street`,
				city: pick(CITIES),
				country: pick(COUNTRIES),
				postal_code: String(int(10000, 99999))
			});
		}
	}

	const products = [];
	for (let i = 1; i <= 250; i++) {
		products.push({
			id: i,
			category_id: int(1, categories.length),
			name: `${pick(ADJ)} ${pick(NOUN)} ${int(100, 999)}`,
			sku: `SKU-${String(i).padStart(5, "0")}`,
			price_cents: int(199, 250000),
			in_stock: chance(0.8),
			rating: int(1, 5)
		});
	}

	const activeUsers = users.filter((u) => u.is_active);
	const orders = [];
	const orderItems = [];
	let itemId = 1;
	for (let i = 1; i <= 1500; i++) {
		const user = pick(activeUsers);
		const placed_at = dateWithin(2);
		let total = 0;
		const nItems = int(1, 5);
		const pending = [];
		for (let k = 0; k < nItems; k++) {
			const product = pick(products);
			const quantity = int(1, 4);
			total += product.price_cents * quantity;
			pending.push({
				id: itemId++,
				order_id: i,
				product_id: product.id,
				quantity,
				unit_price_cents: product.price_cents
			});
		}
		orders.push({
			id: i,
			user_id: user.id,
			status: pick(STATUSES),
			total_cents: total,
			placed_at
		});
		orderItems.push(...pending);
	}

	const reviews = [];
	for (let i = 1; i <= 1200; i++) {
		reviews.push({
			id: i,
			product_id: int(1, products.length),
			user_id: pick(users).id,
			rating: int(1, 5),
			body: `${pick(ADJ)} product, ${pick(["works great", "as described", "fast delivery", "would buy again", "a bit pricey"])}.`,
			created_at: dateWithin(1)
		});
	}

	return { categories, users, addresses, products, orders, order_items: orderItems, reviews };
}

// --- Postgres ---
const DDL = `
CREATE TABLE categories (id BIGINT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE);
CREATE TABLE users (id BIGINT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT, is_active BOOLEAN NOT NULL, created_at TIMESTAMPTZ NOT NULL);
CREATE TABLE addresses (id BIGINT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id), line1 TEXT NOT NULL, city TEXT NOT NULL, country TEXT NOT NULL, postal_code TEXT NOT NULL);
CREATE TABLE products (id BIGINT PRIMARY KEY, category_id BIGINT NOT NULL REFERENCES categories(id), name TEXT NOT NULL, sku TEXT NOT NULL UNIQUE, price_cents BIGINT NOT NULL, in_stock BOOLEAN NOT NULL, rating INT NOT NULL);
CREATE TABLE orders (id BIGINT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id), status TEXT NOT NULL, total_cents BIGINT NOT NULL, placed_at TIMESTAMPTZ NOT NULL);
CREATE TABLE order_items (id BIGINT PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES orders(id), product_id BIGINT NOT NULL REFERENCES products(id), quantity INT NOT NULL, unit_price_cents BIGINT NOT NULL);
CREATE TABLE reviews (id BIGINT PRIMARY KEY, product_id BIGINT NOT NULL REFERENCES products(id), user_id BIGINT NOT NULL REFERENCES users(id), rating INT NOT NULL, body TEXT, created_at TIMESTAMPTZ NOT NULL);
CREATE INDEX ON order_items (order_id);
CREATE INDEX ON reviews (product_id);
`;

function pgVal(v) {
	if (v === null || v === undefined) return "NULL";
	if (v instanceof Date) return `'${v.toISOString()}'`;
	if (typeof v === "number") return String(v);
	if (typeof v === "boolean") return v ? "true" : "false";
	return `'${String(v).replace(/'/g, "''")}'`;
}

async function bulkInsert(client, table, columns, rows, batch = 400) {
	const cols = columns.map((c) => `"${c}"`).join(", ");
	for (let i = 0; i < rows.length; i += batch) {
		const values = rows
			.slice(i, i + batch)
			.map((r) => `(${columns.map((c) => pgVal(r[c])).join(", ")})`)
			.join(", ");
		await client.query(`INSERT INTO "${table}" (${cols}) VALUES ${values}`);
	}
}

async function loadPostgres(data) {
	const admin = new Client({ connectionString: PG_ADMIN_URL });
	await admin.connect();
	await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
	await admin.query(`CREATE DATABASE ${DB}`);
	await admin.end();

	const url = PG_ADMIN_URL.replace(/\/[^/]*$/, `/${DB}`);
	const client = new Client({ connectionString: url });
	await client.connect();
	await client.query(DDL);
	const cols = {
		categories: ["id", "name", "slug"],
		users: ["id", "email", "display_name", "is_active", "created_at"],
		addresses: ["id", "user_id", "line1", "city", "country", "postal_code"],
		products: ["id", "category_id", "name", "sku", "price_cents", "in_stock", "rating"],
		orders: ["id", "user_id", "status", "total_cents", "placed_at"],
		order_items: ["id", "order_id", "product_id", "quantity", "unit_price_cents"],
		reviews: ["id", "product_id", "user_id", "rating", "body", "created_at"]
	};
	for (const [table, columns] of Object.entries(cols)) {
		await bulkInsert(client, table, columns, data[table]);
	}
	await client.end();
}

// --- MongoDB ---
function toDoc(row) {
	const { id, ...rest } = row;
	return { _id: id, ...rest };
}

async function loadMongo(data) {
	const client = new MongoClient(MONGO_URL);
	await client.connect();
	const db = client.db(DB);
	for (const name of Object.keys(data)) {
		await db.collection(name).drop().catch(() => {});
		await db.collection(name).insertMany(data[name].map(toDoc));
	}
	await client.close();
}

async function main() {
	const data = generate();
	const counts = Object.fromEntries(
		Object.entries(data).map(([k, v]) => [k, v.length])
	);
	console.log("Dataset généré:", counts);
	console.log("Chargement Postgres (sqlnest_shop)…");
	await loadPostgres(data);
	console.log("Chargement MongoDB (sqlnest_shop)…");
	await loadMongo(data);
	const total = Object.values(counts).reduce((a, b) => a + b, 0);
	console.log(`✓ ${total} lignes chargées à l'identique dans PG et Mongo.`);
}

main().catch((e) => {
	console.error("ÉCHEC:", e instanceof Error ? e.message : e);
	process.exit(1);
});
