// Charge Chinook depuis Postgres (déjà seedé via seed-chinook.sh) et le
// re-insère dans MongoDB — même noms de tables/colonnes (snake_case) pour
// permettre à SNQL de tourner IDENTIQUEMENT sur les 2 engines.
//
//   pnpm db:seed:chinook       (PG, prerequis)
//   pnpm db:seed:chinook:mongo (ce script)
//
// Convention :
//  - Collection Mongo = même nom que la table PG.
//  - Chaque doc porte _id (natif Mongo) = valeur de la PK PG. La col PK PG
//    (ex. artist_id) est aussi présente dans le doc → une query SNQL comme
//    `find album where artist_id = 5` marche à l'identique sur PG et Mongo.
//  - Les DECIMAL PG (invoice.total, track.unit_price…) sont convertis en
//    Number JS — perte de précision mineure acceptée pour comparaison
//    portable (Mongo Number vs PG numeric). Documented.

import { MongoClient } from "mongodb";
import pg from "pg";

const { Client, types } = pg;

// PG DECIMAL/NUMERIC (OID 1700) : le driver renvoie une string par défaut pour
// préserver la précision arbitraire. On la parse en Number ici — les valeurs
// Chinook (invoice.total, track.unit_price) sont < 10000 et n'ont pas besoin de
// la précision d'un Decimal128. Sans ce parser, le fix ci-dessous serait tenté
// via regex sur les strings, ce qui convertissait `track.name = "5.15"` (un
// titre légitime) en Number 5.15 → tri lexicographique différent PG vs Mongo.
types.setTypeParser(1700, (val) => (val === null ? null : Number(val)));

const PG_URL =
	process.env.SEED_PG_URL ??
	"postgres://sqlnest:sqlnest@localhost:5433/chinook";
const MONGO_URL =
	process.env.SEED_MONGO_URL ??
	"mongodb://localhost:27017/?directConnection=true";
const MONGO_DB = "chinook";

// Ordre topologique : les racines d'abord (self-ref employee.reports_to OK
// car insertMany dans une même collection tolère les self-FKs — aucune
// contrainte native côté Mongo).
const TABLES = /** @type {const} */ ([
	{ name: "artist", pk: "artist_id" },
	{ name: "employee", pk: "employee_id" },
	{ name: "genre", pk: "genre_id" },
	{ name: "media_type", pk: "media_type_id" },
	{ name: "playlist", pk: "playlist_id" },
	{ name: "album", pk: "album_id" },
	{ name: "customer", pk: "customer_id" },
	{ name: "track", pk: "track_id" },
	{ name: "invoice", pk: "invoice_id" },
	{ name: "invoice_line", pk: "invoice_line_id" },
	{ name: "playlist_track", pk: null } // PK composite (playlist_id, track_id) — pas de _id métier, Mongo génère un ObjectId
]);

// Le pg type parser (ci-dessus) fait déjà le boulot pour les DECIMAL/NUMERIC.
// On garde ce hook comme passthrough — pas de regex sur les strings arbitraires.
function normalize(row) {
	return row;
}

async function main() {
	const pgClient = new Client({ connectionString: PG_URL });
	const mongoClient = new MongoClient(MONGO_URL);

	await pgClient.connect();
	await mongoClient.connect();
	const db = mongoClient.db(MONGO_DB);

	console.log(`→ Source PG : ${PG_URL.replace(/:[^:@]+@/, ":***@")}`);
	console.log(`→ Cible Mongo : ${MONGO_URL} db='${MONGO_DB}'`);

	for (const { name, pk } of TABLES) {
		const res = await pgClient.query(`SELECT * FROM ${name}`);
		const rows = res.rows.map(normalize);
		const docs = rows.map((r) =>
			pk !== null ? { _id: r[pk], ...r } : r
		);
		const coll = db.collection(name);
		await coll.deleteMany({});
		if (docs.length > 0) {
			await coll.insertMany(docs);
		}
		console.log(`  ${name.padEnd(16)} ${String(docs.length).padStart(5)} docs`);
	}

	// Miroir des indexes secondaires PG côté Mongo pour parité de perf. Sans
	// ça, un join `album with one artist on artist_id` fait un COLLSCAN de
	// artist par album (~1.8s pour 15 rows). Avec l'idx sur artist_id + une
	// query côté `artist._id` (déjà idx natif), on retombe à ~50ms.
	const idxRes = await pgClient.query(`
		SELECT tablename, indexdef
		FROM pg_indexes
		WHERE schemaname = 'public'
		  AND indexname NOT LIKE '%_pkey'
		ORDER BY tablename, indexname
	`);
	const idxRegex = /USING btree \(([\w, ]+)\)/;
	console.log("→ Indexes secondaires :");
	for (const row of idxRes.rows) {
		const match = idxRegex.exec(row.indexdef);
		if (match === null) continue;
		const cols = match[1].split(",").map((c) => c.trim());
		const keySpec = Object.fromEntries(cols.map((c) => [c, 1]));
		const coll = db.collection(row.tablename);
		const idxName = await coll.createIndex(keySpec);
		console.log(`  ${row.tablename.padEnd(16)} ${idxName}`);
	}

	await pgClient.end();
	await mongoClient.close();
	console.log("✔ Chinook Mongo chargé.");
}

main().catch((err) => {
	console.error("✗ Seed Chinook Mongo échoué :", err.message);
	process.exit(1);
});
