import { describe, expect, it } from "vitest";
import { ConnectionClosedError } from "../errors";
import { runQuery } from "../run";
import { mongoAdapter } from "./adapter";
import { resolveMongoConfig } from "./config";

/**
 * Tests d'intégration : nécessitent un vrai MongoDB.
 * Lancer `pnpm db:up`, puis exporter
 * `SNQL_TEST_MONGO_URL=mongodb://localhost:27017/sqlnest_demo?directConnection=true`.
 * Sans cette variable, tout le bloc est **sauté**.
 */
const MONGO_URL = process.env.SNQL_TEST_MONGO_URL ?? "";
const hasMongo = MONGO_URL !== "";
const loadConfig = () => resolveMongoConfig({ url: MONGO_URL });

describe.skipIf(!hasMongo)("mongodb adapter (intégration)", () => {
	it("connect → ping → close", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			const ping = await conn.ping();
			expect(ping.latencyMs).toBeGreaterThanOrEqual(0);
		} finally {
			await conn.close();
		}
	}, 20_000);

	it("ping après close lève ConnectionClosedError", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		await conn.close();
		await expect(conn.ping()).rejects.toBeInstanceOf(ConnectionClosedError);
	}, 20_000);

	it("introspect : schéma inféré par sampling (collections + relation)", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			const schema = await conn.introspect();
			expect(schema.engine).toBe("mongodb");

			const names = schema.collections.map((c) => c.name);
			expect(names).toContain("users");
			expect(names).toContain("orders");

			const users = schema.collections.find((c) => c.name === "users");
			expect(users?.source).toBe("inferred");
			expect(users?.fields.find((f) => f.name === "email")?.type).toBe(
				"string"
			);

			// Relation inférée orders.user_id -> users (heuristique de nommage).
			const rel = schema.relations.find((r) => r.from.collection === "orders");
			expect(rel?.to.collection).toBe("users");
			expect(rel?.origin).toBe("naming-heuristic");
		} finally {
			await conn.close();
		}
	}, 20_000);

	it("runQuery : le codegen Mongo touche enfin une vraie base", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			const rs = await runQuery(
				conn,
				"get users where is_active = true pick email"
			);
			const emails = rs.rows.map((row) => row.email).sort();
			expect(emails).toEqual(["ada@example.com", "alan@example.com"]);
		} finally {
			await conn.close();
		}
	}, 20_000);
});

/**
 * Mutations réelles. Tout se passe dans une collection jetable (`snql_write_probe`)
 * pour ne jamais toucher le seed `users`/`orders` des tests de lecture.
 */
describe.skipIf(!hasMongo)("mongodb — mutations (intégration)", () => {
	const PROBE = "snql_write_probe";
	const wipe = (conn: Awaited<ReturnType<typeof mongoAdapter.connect>>) =>
		runQuery(conn, `remove from ${PROBE}`);

	it("insert : documents réels, _id généré rendu (parité RETURNING)", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			await wipe(conn);
			const inserted = await runQuery(
				conn,
				`add [{sku: "a", qty: 1}, {sku: "b", qty: 2}] into ${PROBE}`
			);
			expect(inserted.rowCount).toBe(2);
			expect(inserted.rows.map((row) => row.sku).sort()).toEqual(["a", "b"]);
			// `_id` généré par Mongo, normalisé en chaîne.
			expect(typeof inserted.rows[0]?._id).toBe("string");

			const read = await runQuery(conn, `get ${PROBE} pick sku`);
			expect(read.rowCount).toBe(2);
		} finally {
			await wipe(conn);
			await conn.close();
		}
	}, 20_000);

	it("update : filtre + $set, rowCount = lignes touchées", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			await wipe(conn);
			await runQuery(
				conn,
				`add [{sku: "a", qty: 1}, {sku: "b", qty: 1}] into ${PROBE}`
			);

			const updated = await runQuery(
				conn,
				`update ${PROBE} where sku = "a" set qty = 42`
			);
			expect(updated.rowCount).toBe(1);
			// Asymétrie assumée avec Postgres : pas de RETURNING multi-documents.
			expect(updated.rows).toEqual([]);

			const check = await runQuery(
				conn,
				`get ${PROBE} where sku = "a" pick qty`
			);
			expect(check.rows[0]?.qty).toBe(42);
		} finally {
			await wipe(conn);
			await conn.close();
		}
	}, 20_000);

	it("update non filtré : porte sur tous les documents", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			await wipe(conn);
			await runQuery(
				conn,
				`add [{sku: "a", qty: 1}, {sku: "b", qty: 2}] into ${PROBE}`
			);

			const updated = await runQuery(conn, `update ${PROBE} set qty = 7`);
			expect(updated.rowCount).toBe(2);

			const check = await runQuery(conn, `get ${PROBE} pick qty`);
			expect(check.rows.map((row) => row.qty)).toEqual([7, 7]);
		} finally {
			await wipe(conn);
			await conn.close();
		}
	}, 20_000);

	it("update référençant un champ (forme pipeline) sur de vraies données", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			await wipe(conn);
			await runQuery(conn, `add {sku: "a", qty: 3, total: 0} into ${PROBE}`);

			const updated = await runQuery(
				conn,
				`update ${PROBE} where sku = "a" set total = qty`
			);
			expect(updated.rowCount).toBe(1);

			const check = await runQuery(
				conn,
				`get ${PROBE} where sku = "a" pick total`
			);
			expect(check.rows[0]?.total).toBe(3);
		} finally {
			await wipe(conn);
			await conn.close();
		}
	}, 20_000);

	it("forme pipeline : une chaîne `$…` est écrite telle quelle, pas résolue", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			await wipe(conn);
			await runQuery(conn, `add {sku: "a", qty: 3, label: "x"} into ${PROBE}`);

			// `total = qty` force la forme pipeline ; sans `$literal`, Mongo lirait
			// "$qty" comme un chemin de champ et écrirait 3 dans `label`.
			await runQuery(
				conn,
				`update ${PROBE} where sku = "a" set label = "$qty", total = qty`
			);

			const check = await runQuery(
				conn,
				`get ${PROBE} where sku = "a" pick label, total`
			);
			expect(check.rows[0]?.label).toBe("$qty");
			expect(check.rows[0]?.total).toBe(3);
		} finally {
			await wipe(conn);
			await conn.close();
		}
	}, 20_000);

	it("delete : filtré puis non filtré", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			await wipe(conn);
			await runQuery(
				conn,
				`add [{sku: "a", qty: 1}, {sku: "b", qty: 2}, {sku: "c", qty: 3}] into ${PROBE}`
			);

			const removed = await runQuery(
				conn,
				`remove from ${PROBE} where qty > 2`
			);
			expect(removed.rowCount).toBe(1);
			expect(removed.rows).toEqual([]);

			const rest = await runQuery(conn, `get ${PROBE} pick sku`);
			expect(rest.rowCount).toBe(2);

			const all = await runQuery(conn, `remove from ${PROBE}`);
			expect(all.rowCount).toBe(2);
			expect((await runQuery(conn, `get ${PROBE}`)).rowCount).toBe(0);
		} finally {
			await wipe(conn);
			await conn.close();
		}
	}, 20_000);

	it("delete sans correspondance : 0 ligne, pas d'erreur", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			await wipe(conn); // auto-suffisant (pas de dépendance à l'ordre des tests)
			const removed = await runQuery(
				conn,
				`remove from ${PROBE} where sku = "absent"`
			);
			expect(removed.rowCount).toBe(0);
		} finally {
			await conn.close();
		}
	}, 20_000);
});

/**
 * Corrections issues de la review adversariale (perte de données / fidélité BSON).
 * Chaque test échouerait sans le correctif correspondant.
 */
describe.skipIf(!hasMongo)("mongodb — mutations : corrections review", () => {
	const PROBE = "snql_write_probe";
	const wipe = (conn: Awaited<ReturnType<typeof mongoAdapter.connect>>) =>
		runQuery(conn, `remove from ${PROBE}`);

	it("`!=` n'efface PAS les documents où le champ est absent/null (parité 3VL)", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			await wipe(conn);
			await runQuery(conn, `add {sku: "a", age: 30} into ${PROBE}`);
			await runQuery(conn, `add {sku: "b", age: 40} into ${PROBE}`);
			await runQuery(conn, `add {sku: "c", age: null} into ${PROBE}`);
			await runQuery(conn, `add {sku: "d"} into ${PROBE}`); // age absent

			// Seul "b" (age 40) doit partir — comme Postgres (a=30 exclu, null/absent UNKNOWN).
			const removed = await runQuery(
				conn,
				`remove from ${PROBE} where age != 30`
			);
			expect(removed.rowCount).toBe(1);

			const survivors = await runQuery(conn, `get ${PROBE} pick sku`);
			expect(survivors.rows.map((r) => r.sku).sort()).toEqual(["a", "c", "d"]);
		} finally {
			await wipe(conn);
			await conn.close();
		}
	}, 20_000);

	it('`where _id = "<hex>"` matche, `_id != "<hex>"` épargne (ObjectId réhydraté)', async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			await wipe(conn);
			// _id générés par Mongo = ObjectId ; la lecture les rend en chaîne hex.
			const ins = await runQuery(
				conn,
				`add [{sku: "x"}, {sku: "y"}, {sku: "z"}] into ${PROBE}`
			);
			const targetId = ins.rows[0]?._id as string;
			expect(typeof targetId).toBe("string");

			// Filtre both-forms (#7) : `_id = "hex"` matche l'ObjectId auto-généré.
			const match = await runQuery(
				conn,
				`get ${PROBE} where _id = "${targetId}" pick sku`
			);
			expect(match.rows.map((r) => r.sku)).toEqual(["x"]);

			// Sans both-forms, `_id != "hex"` matcherait TOUT → collection vidée.
			const removed = await runQuery(
				conn,
				`remove from ${PROBE} where _id != "${targetId}"`
			);
			expect(removed.rowCount).toBe(2);
			const rest = await runQuery(conn, `get ${PROBE} pick sku`);
			expect(rest.rows.map((r) => r.sku)).toEqual(["x"]);
		} finally {
			await wipe(conn);
			await conn.close();
		}
	}, 20_000);

	it("update forme pipeline : champ source absent → null (pas de suppression de clé)", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			await wipe(conn);
			await runQuery(conn, `add {sku: "nf", total: 99} into ${PROBE}`); // pas de `price`

			await runQuery(
				conn,
				`update ${PROBE} where sku = "nf" set total = price`
			);
			const check = await runQuery(
				conn,
				`get ${PROBE} where sku = "nf" pick total`
			);
			// null (présent), PAS undefined (clé supprimée) — parité avec Postgres.
			expect(check.rows[0]?.total).toBeNull();
		} finally {
			await wipe(conn);
			await conn.close();
		}
	}, 20_000);

	it("_id 24-hex custom : stocké STRING (fidélité #7), adressable via both-forms", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		const hex = "507f1f77bcf86cd799439011";
		try {
			await wipe(conn);
			await runQuery(conn, `add {_id: "${hex}", sku: "keep"} into ${PROBE}`);
			await runQuery(conn, `add {sku: "other"} into ${PROBE}`);

			// Fidélité #7 : l'insert stocke `_id` TEL QUEL (string), pas un ObjectId
			// deviné. Le filtre both-forms le retrouve quand même.
			const found = await runQuery(
				conn,
				`get ${PROBE} where _id = "${hex}" pick _id, sku`
			);
			expect(found.rows.map((r) => r.sku)).toEqual(["keep"]);
			// _id rendu = la string custom (pas normalisé depuis un ObjectId).
			expect(found.rows[0]?._id).toBe(hex);
		} finally {
			await wipe(conn);
			await conn.close();
		}
	}, 20_000);

	it("décimal écrit exactement (Decimal128, pas de double lossy)", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			await wipe(conn);
			await runQuery(
				conn,
				`add {sku: "dec", price: 1.123456789012345678} into ${PROBE}`
			);
			const check = await runQuery(
				conn,
				`get ${PROBE} where sku = "dec" pick price`
			);
			// normalizeBson rend un Decimal128 en chaîne décimale exacte.
			expect(check.rows[0]?.price).toBe("1.123456789012345678");
		} finally {
			await wipe(conn);
			await conn.close();
		}
	}, 20_000);
});

describe.skipIf(!hasMongo)("mongodb adapter — add ref (ADR-036 E/1a)", () => {
	it("orphelins comptés et refusés, puis FK posée et appliquée aux writes", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		const drop = async () => {
			await runQuery(
				conn,
				"drop ref fk_e1a_kid_par_id_e1a_par from e1a_kid if exists"
			);
			await runQuery(conn, "drop table e1a_kid if exists");
			await runQuery(conn, "drop table e1a_par if exists");
		};
		try {
			await drop();
			await runQuery(
				conn,
				"create table e1a_par { id: string, primary key (id) }"
			);
			await runQuery(
				conn,
				"create table e1a_kid { id: string, par_id: string nullable, primary key (id) }"
			);
			await runQuery(conn, 'add { id: "p1" } into e1a_par');
			await runQuery(conn, 'add { id: "k1", par_id: "p1" } into e1a_kid');
			await runQuery(conn, 'add { id: "k2", par_id: "ghost" } into e1a_kid');
			await runQuery(conn, 'add { id: "k3", par_id: "ghost" } into e1a_kid');
			await runQuery(conn, 'add { id: "k4", par_id: null } into e1a_kid');

			const add = "add ref (par_id) references e1a_par.id into e1a_kid";
			await expect(runQuery(conn, add)).rejects.toThrow(
				/2 docs de 'e1a_kid' ont 'par_id' sans correspondance dans e1a_par\.id \(ex\. "ghost"\).*update e1a_kid where par_id = "ghost" set par_id = null/
			);

			await runQuery(
				conn,
				'update e1a_kid where par_id = "ghost" set par_id = null'
			);
			await runQuery(conn, add);
			const schema = await conn.introspect();
			expect(
				schema.refs?.find((r) => r.fromCollection === "e1a_kid")
			).toMatchObject({
				name: "fk_e1a_kid_par_id_e1a_par",
				toCollection: "e1a_par",
				toColumn: "id"
			});
			await expect(runQuery(conn, add)).rejects.toThrow(/existe déjà/);
			await expect(
				runQuery(conn, 'add { id: "k5", par_id: "ghost" } into e1a_kid')
			).rejects.toThrow(/viole la foreign key 'fk_e1a_kid_par_id_e1a_par'/);
		} finally {
			await drop();
			await conn.close();
		}
	}, 30_000);
});

describe.skipIf(!hasMongo)(
	"mongodb adapter — rename column (ADR-036 E/1b)",
	() => {
		it("champ, validateur, index et FK suivent le nouveau nom ; reprise idempotente", async () => {
			const conn = await mongoAdapter.connect(loadConfig());
			const drop = async () => {
				await runQuery(conn, "drop table e1b_kid if exists");
				await runQuery(conn, "drop table e1b_par if exists");
			};
			try {
				await drop();
				await runQuery(
					conn,
					"create table e1b_par { id: string, code: string unique, phone: string, primary key (id) }"
				);
				await runQuery(
					conn,
					"create table e1b_kid { label: string, par_code: string nullable ref e1b_par.code }"
				);
				await runQuery(conn, "add index (phone) into e1b_par");
				await runQuery(conn, 'add {code: "p1", phone: "01"} into e1b_par');
				await runQuery(conn, 'add {code: "p2", phone: "02"} into e1b_par');
				await runQuery(conn, 'add {label: "k1", par_code: "p1"} into e1b_kid');

				// Reprise : un document déjà renommé (interruption simulée) ne gêne pas.
				await runQuery(
					conn,
					'raw { "update": "e1b_par", "updates": [{ "q": { "code": "p2" }, "u": { "$rename": { "phone": "mobile" } } }], "bypassDocumentValidation": true }'
				);
				await runQuery(conn, "rename column e1b_par.phone to mobile");
				await runQuery(conn, "rename column e1b_par.code to slug");
				await runQuery(conn, "rename column e1b_kid.par_code to par_slug");

				const par = await runQuery(
					conn,
					"find e1b_par pick slug, mobile sort slug"
				);
				expect(par.rows).toEqual([
					{ slug: "p1", mobile: "01" },
					{ slug: "p2", mobile: "02" }
				]);
				const schema = await conn.introspect();
				const fields = schema.collections
					.find((c) => c.name === "e1b_par")
					?.fields.map((f) => f.name);
				expect(fields).toEqual(expect.arrayContaining(["slug", "mobile"]));
				expect(fields).not.toContain("phone");
				expect(
					schema.refs?.find((r) => r.fromCollection === "e1b_kid")
				).toMatchObject({
					fromColumn: "par_slug",
					toCollection: "e1b_par",
					toColumn: "slug"
				});
				const indexes = await runQuery(conn, "list indexes on e1b_par");
				const names = indexes.rows.map((r) => r["name"]);
				expect(names).toEqual(
					expect.arrayContaining(["unique_slug", "idx_e1b_par_mobile"])
				);
				expect(names).not.toContain("unique_code");
				// La FK renommée des deux côtés s'applique toujours.
				await expect(
					runQuery(conn, 'add {label: "k2", par_slug: "ghost"} into e1b_kid')
				).rejects.toThrow(/viole la foreign key/);
				await runQuery(conn, 'add {label: "k3", par_slug: "p2"} into e1b_kid');
				// L'index unique suit le champ : un doublon de slug est refusé.
				await expect(
					runQuery(conn, 'add {slug: "p1", mobile: "03"} into e1b_par')
				).rejects.toThrow();

				// Conflit : un document porte déjà le nouveau nom.
				await runQuery(
					conn,
					'add {label: "k4", par_slug: "p1", note: "a", memo: "b"} into e1b_kid'
				);
				await expect(
					runQuery(conn, "rename column e1b_kid.note to memo")
				).rejects.toThrow(
					/1 docs de 'e1b_kid' ont déjà 'memo' en plus de 'note'/
				);

				// L'alias `id` de `_id` garde son nom.
				await expect(
					runQuery(conn, "rename column e1b_par.id to key")
				).rejects.toThrow(/alias de '_id'/);
			} finally {
				await drop();
				await conn.close();
			}
		}, 60_000);
	}
);

describe.skipIf(!hasMongo)(
	"mongodb adapter — alter column (ADR-036 E/1c)",
	() => {
		it("nullabilité et type : préflight, conversion par lots, validateur et introspection", async () => {
			const conn = await mongoAdapter.connect(loadConfig());
			const cleanup = async () => {
				await runQuery(conn, "drop table e1c_m if exists");
				await runQuery(conn, "drop enum E1C_TIER if exists");
			};
			try {
				await cleanup();
				await runQuery(
					conn,
					"create table e1c_m { code: string, n: string nullable, flag: string nullable, tier: string nullable, ref: string nullable }"
				);
				await runQuery(
					conn,
					'add {code: "a", n: "5", flag: "yes", tier: "x", ref: "0f8fad5b-d9cb-469f-a165-70867728950e"} into e1c_m'
				);
				await runQuery(
					conn,
					'add {code: "b", n: null, flag: "false", tier: "y"} into e1c_m'
				);

				// Type : texte → entier, null conservé ; le validateur suit.
				await runQuery(conn, "alter column e1c_m.n set type int");
				const ints = await runQuery(conn, "find e1c_m pick code, n sort code");
				expect(ints.rows).toEqual([
					{ code: "a", n: 5 },
					{ code: "b", n: null }
				]);
				await expect(
					runQuery(conn, 'add {code: "c", n: "7"} into e1c_m')
				).rejects.toThrow();

				// Nullabilité : refus tant qu'un document est nul, puis appliquée.
				await expect(
					runQuery(conn, "alter column e1c_m.n set not null")
				).rejects.toThrow(
					/1 docs de 'e1c_m' ont 'n' nul ou absent — exécute d'abord : update e1c_m where n = null set n = <val>/
				);
				await runQuery(conn, "update e1c_m where n = null set n = 0");
				await runQuery(conn, "alter column e1c_m.n set not null");
				await expect(
					runQuery(conn, 'add {code: "c", n: null} into e1c_m')
				).rejects.toThrow();
				await runQuery(conn, "alter column e1c_m.n set nullable");
				await runQuery(conn, 'add {code: "c", n: null} into e1c_m');

				// Booléen depuis du texte : mots de Postgres, pas `$convert`.
				await runQuery(conn, "alter column e1c_m.flag set type bool");
				const flags = await runQuery(
					conn,
					"find e1c_m pick code, flag sort code"
				);
				expect(flags.rows.slice(0, 2)).toEqual([
					{ code: "a", flag: true },
					{ code: "b", flag: false }
				]);

				// Non convertible : refusé avec le nombre et un exemple, rien ne change.
				await expect(
					runQuery(conn, "alter column e1c_m.code set type int")
				).rejects.toThrow(
					/3 docs de 'e1c_m' ont une valeur de 'code' non convertible en int \(ex\. "a"\)/
				);

				// uuid : converti côté adapter.
				await runQuery(conn, "alter column e1c_m.ref set type uuid");
				const refs = await runQuery(
					conn,
					'find e1c_m where code = "a" pick ref'
				);
				expect(String(refs.rows[0]?.ref)).toBe(
					"0f8fad5b-d9cb-469f-a165-70867728950e"
				);

				// Enum : membres vérifiés, puis posés au validateur.
				await runQuery(conn, 'create enum E1C_TIER { "x" }');
				await expect(
					runQuery(
						conn,
						"alter column e1c_m.tier set type E1C_TIER",
						await conn.introspect()
					)
				).rejects.toThrow(/non convertible en enum \(ex\. "y"\)/);
				await runQuery(conn, 'add enum member E1C_TIER "y"');
				await runQuery(
					conn,
					"alter column e1c_m.tier set type E1C_TIER",
					await conn.introspect()
				);
				await expect(
					runQuery(conn, 'add {code: "d", tier: "z"} into e1c_m')
				).rejects.toThrow();

				// Introspection : type lisible sur une colonne nullable, valeurs d'enum.
				const fields = (await conn.introspect()).collections.find(
					(c) => c.name === "e1c_m"
				)?.fields;
				expect(fields?.find((f) => f.name === "n")).toMatchObject({
					type: "int",
					nullable: true
				});
				expect(fields?.find((f) => f.name === "tier")?.enumValues).toEqual([
					"x",
					"y"
				]);
			} finally {
				await cleanup();
				await conn.close();
			}
		}, 60_000);
	}
);

describe.skipIf(!hasMongo)("mongodb adapter — défauts (ADR-036 E/1d)", () => {
	it("défauts posés à l'insertion, remplissage, set / drop default, rename, introspection", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		try {
			await runQuery(conn, "drop table e1d_m if exists");
			await runQuery(
				conn,
				'create table e1d_m { code: text, tier: text nullable default "free", at: timestamp default now(), ref: uuid default uuid() }'
			);
			await runQuery(conn, 'add {code: "a"} into e1d_m');
			await runQuery(conn, 'add {code: "b", tier: null} into e1d_m');
			const rows = (
				await runQuery(conn, "find e1d_m pick code, tier, at, ref sort code")
			).rows;
			expect(rows[0]).toMatchObject({ code: "a", tier: "free" });
			expect(rows[1]).toMatchObject({ code: "b", tier: null });
			expect(rows[0]?.at).toBeTruthy();
			expect(String(rows[0]?.ref)).toMatch(/^[0-9a-f-]{36}$/);
			expect(rows[0]?.ref).not.toEqual(rows[1]?.ref);

			// Remplissage : un uuid distinct par document existant.
			await runQuery(conn, "add column tag uuid default uuid() into e1d_m");
			const tags = (await runQuery(conn, "find e1d_m pick tag")).rows.map((r) =>
				String(r.tag)
			);
			expect(new Set(tags).size).toBe(2);

			// set default : vaut pour les insertions à venir seulement.
			await runQuery(conn, 'alter column e1d_m.tier set default "pro"');
			await runQuery(conn, 'add {code: "c"} into e1d_m');
			const c = (await runQuery(conn, 'find e1d_m where code = "c" pick tier'))
				.rows[0];
			expect(c).toEqual({ tier: "pro" });
			const a = (await runQuery(conn, 'find e1d_m where code = "a" pick tier'))
				.rows[0];
			expect(a).toEqual({ tier: "free" });
			await runQuery(conn, "alter column e1d_m.tier drop default");
			await runQuery(conn, 'add {code: "d"} into e1d_m');
			const d = (await runQuery(conn, 'find e1d_m where code = "d" pick tier'))
				.rows[0];
			expect(d?.tier ?? null).toBeNull();

			// Le défaut suit un renommage.
			await runQuery(conn, "rename column e1d_m.at to created");
			await runQuery(conn, 'add {code: "e"} into e1d_m');
			const e = (
				await runQuery(conn, 'find e1d_m where code = "e" pick created')
			).rows[0];
			expect(e?.created).toBeTruthy();

			// Introspection : défauts lisibles ; la métadonnée n'est pas une table.
			const fields = (await conn.introspect()).collections.find(
				(col) => col.name === "e1d_m"
			)?.fields;
			expect(fields?.find((f) => f.name === "created")).toMatchObject({
				hasDefault: true,
				defaultExpr: "now()"
			});
			expect(
				fields?.find((f) => f.name === "tier")?.hasDefault
			).toBeUndefined();
			const tables = (await runQuery(conn, "list tables")).rows.map(
				(r) => r.name
			);
			expect(tables).not.toContain("_snql_defaults");
			// `describe` donne la même vue : défaut et nullabilité déclarés.
			const described = (await runQuery(conn, "describe e1d_m")).rows;
			expect(described.find((r) => r.name === "created")).toMatchObject({
				default: "now()"
			});
			expect(described.find((r) => r.name === "tier")).toMatchObject({
				nullable: true,
				default: null
			});
		} finally {
			await runQuery(conn, "drop table e1d_m if exists");
			await conn.close();
		}
	}, 60_000);
});

describe.skipIf(!hasMongo)("mongodb adapter — on update (ADR-031)", () => {
	it("restrict : refus typé si un enfant référence l'ancienne valeur, rien n'est écrit", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		const drop = async () => {
			await runQuery(conn, "drop table e1u_rkid if exists");
			await runQuery(conn, "drop table e1u_rpar if exists");
		};
		try {
			await drop();
			await runQuery(
				conn,
				"create table e1u_rpar { id: string, code: string, name: string nullable, primary key (id) }"
			);
			await runQuery(
				conn,
				"create table e1u_rkid { label: string, par_code: string nullable ref e1u_rpar.code, par_id: string nullable ref e1u_rpar.id }"
			);
			await runQuery(
				conn,
				'add {id: "r1", code: "a", name: "x"} into e1u_rpar'
			);
			await runQuery(
				conn,
				'add {id: "r2", code: "b", name: "w"} into e1u_rpar'
			);
			await runQuery(
				conn,
				'add {label: "k1", par_code: "a", par_id: "r1"} into e1u_rkid'
			);

			await expect(
				runQuery(conn, 'update e1u_rpar where code = "a" set code = "z"')
			).rejects.toThrow(
				/update de 'e1u_rpar' viole la foreign key 'fk_e1u_rkid_par_code_e1u_rpar' \(RESTRICT\) : e1u_rkid référence encore les anciennes valeurs de 'code' via 'par_code'/
			);
			// Même refus en forme pipeline (nouvelle valeur calculée).
			await expect(
				runQuery(conn, 'update e1u_rpar where code = "a" set code = name')
			).rejects.toThrow(/\(RESTRICT\)/);
			const codes = await runQuery(conn, "find e1u_rpar pick code sort code");
			expect(codes.rows).toEqual([{ code: "a" }, { code: "b" }]);

			// Clé non référencée, colonne non référencée, FK vers `_id` : rien à refuser.
			await runQuery(conn, 'update e1u_rpar where code = "b" set code = "y"');
			await runQuery(conn, 'update e1u_rpar where code = "a" set name = "n"');
			const after = await runQuery(
				conn,
				"find e1u_rpar pick code, name sort code"
			);
			expect(after.rows).toEqual([
				{ code: "a", name: "n" },
				{ code: "y", name: "w" }
			]);
		} finally {
			await drop();
			await conn.close();
		}
	}, 60_000);

	it("cascade et set null : enfants et petits-enfants suivent, échange de clés en forme pipeline", async () => {
		const conn = await mongoAdapter.connect(loadConfig());
		const drop = async () => {
			await runQuery(conn, "drop table e1u_sub if exists");
			await runQuery(conn, "drop table e1u_nul if exists");
			await runQuery(conn, "drop table e1u_kid if exists");
			await runQuery(conn, "drop table e1u_par if exists");
		};
		try {
			await drop();
			await runQuery(
				conn,
				"create table e1u_par { code: string, next_code: string nullable }"
			);
			await runQuery(
				conn,
				"create table e1u_kid { label: string, par_code: string nullable ref e1u_par.code on update cascade }"
			);
			await runQuery(
				conn,
				"create table e1u_sub { label: string, kid_code: string nullable ref e1u_kid.par_code on update cascade }"
			);
			await runQuery(
				conn,
				"create table e1u_nul { label: string, par_code: string nullable ref e1u_par.code on update set null }"
			);
			await runQuery(conn, 'add {code: "a", next_code: "b"} into e1u_par');
			await runQuery(conn, 'add {code: "b", next_code: "a"} into e1u_par');
			await runQuery(conn, 'add {code: "c"} into e1u_par');
			await runQuery(conn, 'add {label: "k1", par_code: "a"} into e1u_kid');
			await runQuery(conn, 'add {label: "k2", par_code: "a"} into e1u_kid');
			await runQuery(conn, 'add {label: "k3", par_code: "b"} into e1u_kid');
			await runQuery(conn, 'add {label: "k4", par_code: "c"} into e1u_kid');
			await runQuery(conn, 'add {label: "s1", kid_code: "a"} into e1u_sub');
			await runQuery(conn, 'add {label: "s2", kid_code: "b"} into e1u_sub');
			await runQuery(conn, 'add {label: "n1", par_code: "a"} into e1u_nul');
			await runQuery(conn, 'add {label: "n2", par_code: "c"} into e1u_nul');

			// a ↔ b : chaque enfant suit SA ligne, pas la valeur réécrite juste avant.
			const swap = await runQuery(
				conn,
				'update e1u_par where code != "c" set code = next_code'
			);
			expect(swap.rowCount).toBe(2);
			const pick = async (table: string, col: string) =>
				(await runQuery(conn, `find ${table} pick label, ${col} sort label`))
					.rows;
			expect(await pick("e1u_kid", "par_code")).toEqual([
				{ label: "k1", par_code: "b" },
				{ label: "k2", par_code: "b" },
				{ label: "k3", par_code: "a" },
				{ label: "k4", par_code: "c" }
			]);
			expect(await pick("e1u_sub", "kid_code")).toEqual([
				{ label: "s1", kid_code: "b" },
				{ label: "s2", kid_code: "a" }
			]);
			expect(await pick("e1u_nul", "par_code")).toEqual([
				{ label: "n1", par_code: null },
				{ label: "n2", par_code: "c" }
			]);

			// Forme littérale.
			await runQuery(conn, 'update e1u_par where code = "c" set code = "z"');
			expect(await pick("e1u_kid", "par_code")).toContainEqual({
				label: "k4",
				par_code: "z"
			});
			expect(await pick("e1u_nul", "par_code")).toContainEqual({
				label: "n2",
				par_code: null
			});
			// Les enfants réécrits respectent toujours la FK.
			await expect(
				runQuery(conn, 'add {label: "k5", par_code: "c"} into e1u_kid')
			).rejects.toThrow(/viole la foreign key/);
		} finally {
			await drop();
			await conn.close();
		}
	}, 60_000);
});
