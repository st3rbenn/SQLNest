import { describe, expect, it } from "vitest";
import { SnqlError } from "./diagnostics";
import { getMapper, lowerMutation, parse, tokenize } from "./index";

/** Compile une mutation SNQL en SQL Postgres (text + params). */
function sql(source: string): { text: string; params: readonly unknown[] } {
	const statement = parse(tokenize(source));
	if (statement.operation === "select") {
		throw new Error("attendu une mutation");
	}
	const native = getMapper("postgres").mapMutation(lowerMutation(statement));
	if (native.kind !== "sql") {
		throw new Error("attendu du SQL");
	}
	return { text: native.text, params: native.params };
}

describe("mutations → Postgres", () => {
	it("update simple", () => {
		const { text, params } = sql(
			'update users where id = 7 set status = "active"'
		);
		expect(text).toBe(
			'UPDATE "users" SET "status" = $1 WHERE "id" = $2 RETURNING *'
		);
		expect(params).toEqual(["active", 7]);
	});

	it("update multi-set", () => {
		const { text, params } = sql(
			'update users where id = 7 set status = "x", is_active = false'
		);
		expect(text).toBe(
			'UPDATE "users" SET "status" = $1, "is_active" = $2 WHERE "id" = $3 RETURNING *'
		);
		expect(params).toEqual(["x", false, 7]);
	});

	it("delete filtré", () => {
		const { text, params } = sql("remove from users where age < 18");
		expect(text).toBe('DELETE FROM "users" WHERE "age" < $1 RETURNING *');
		expect(params).toEqual([18]);
	});

	it("conjonction dans un where via 'and'", () => {
		const { text, params } = sql(
			"remove from orders where user_id = 1 and total_cents > 1000"
		);
		expect(text).toBe(
			'DELETE FROM "orders" WHERE ("user_id" = $1 AND "total_cents" > $2) RETURNING *'
		);
		expect(params).toEqual([1, 1000]);
	});

	it("bigint préservé dans un prédicat de mutation", () => {
		const { params } = sql(
			"remove from users where id = 9223372036854775807"
		);
		expect(params).toEqual([9223372036854775807n]);
	});

	it("update sans where affecte toutes les lignes (assumé)", () => {
		const { text, params } = sql("update users set is_active = false");
		expect(text).toBe('UPDATE "users" SET "is_active" = $1 RETURNING *');
		expect(params).toEqual([false]);
	});

	it("remove sans where supprime toutes les lignes (assumé)", () => {
		const { text, params } = sql("remove from users");
		expect(text).toBe('DELETE FROM "users" RETURNING *');
		expect(params).toEqual([]);
	});

	it("insert simple → INSERT … RETURNING *", () => {
		const { text, params } = sql(
			'add {email: "a@b.c", display_name: "Bob", is_active: true} into users'
		);
		expect(text).toBe(
			'INSERT INTO "users" ("email", "display_name", "is_active") VALUES ($1, $2, $3) RETURNING *'
		);
		expect(params).toEqual(["a@b.c", "Bob", true]);
	});

	it("insert multi-lignes (liste de documents)", () => {
		const { text, params } = sql("add [{a: 1}, {a: 2}] into t");
		expect(text).toBe('INSERT INTO "t" ("a") VALUES ($1), ($2) RETURNING *');
		expect(params).toEqual([1, 2]);
	});

	it("insert avec null (NULL en clair, pas paramétré)", () => {
		const { text, params } = sql("add {display_name: null} into users");
		expect(text).toBe(
			'INSERT INTO "users" ("display_name") VALUES (NULL) RETURNING *'
		);
		expect(params).toEqual([]);
	});

	it("clé de document entre guillemets acceptée", () => {
		const { text } = sql('add {"email": "a@b.c"} into users');
		expect(text).toBe('INSERT INTO "users" ("email") VALUES ($1) RETURNING *');
	});

	it("préserve la précision d'un décimal (pas de double lossy)", () => {
		const { text, params } = sql(
			"add {balance: 1.123456789012345678} into accounts"
		);
		expect(text).toBe(
			'INSERT INTO "accounts" ("balance") VALUES ($1) RETURNING *'
		);
		// Le texte brut exact est bindé — Postgres caste vers NUMERIC sans perte.
		expect(params).toEqual(["1.123456789012345678"]);
	});
});

describe("mutations — règles de correction", () => {
	it("refuse un update sans set (rien à écrire)", () => {
		expect(() => parse(tokenize("update users where id = 1"))).toThrow(
			SnqlError
		);
	});

	it("refuse une colonne affectée deux fois dans un set", () => {
		const statement = parse(
			tokenize("update users where id = 1 set x = 1, x = 2")
		);
		if (statement.operation === "select") {
			throw new Error("attendu une mutation");
		}
		expect(() => lowerMutation(statement)).toThrow(SnqlError);
	});

	it("refuse 'add' sans document { … }", () => {
		expect(() => parse(tokenize("add users"))).toThrow(SnqlError);
	});

	it("refuse un document vide", () => {
		expect(() => parse(tokenize("add {} into t"))).toThrow(SnqlError);
	});

	it("refuse une valeur d'insertion non littérale", () => {
		expect(() => sql("add {a: b} into t")).toThrow(SnqlError);
	});

	it("refuse des documents hétérogènes en insert multiple", () => {
		expect(() => sql("add [{a: 1}, {b: 2}] into t")).toThrow(SnqlError);
	});
});

/** Compile une mutation SNQL en commande d'écriture MongoDB. */
function mongo(source: string) {
	const statement = parse(tokenize(source));
	if (statement.operation === "select") {
		throw new Error("attendu une mutation");
	}
	const native = getMapper("mongodb").mapMutation(lowerMutation(statement));
	if (native.kind !== "mongo-write") {
		throw new Error("attendu une écriture mongo");
	}
	return native;
}

describe("mutations → MongoDB", () => {
	it("insert : un document", () => {
		const query = mongo('add {email: "a@b.c", age: 30} into users');
		expect(query).toEqual({
			engine: "mongodb",
			kind: "mongo-write",
			collection: "users",
			op: "insert",
			documents: [{ email: "a@b.c", age: 30 }]
		});
	});

	it("insert : plusieurs documents (colonnes homogènes)", () => {
		const query = mongo("add [{a: 1, b: true}, {a: 2, b: null}] into t");
		expect(query.op === "insert" && query.documents).toEqual([
			{ a: 1, b: true },
			{ a: 2, b: null }
		]);
	});

	it("update : $set + filtre", () => {
		const query = mongo('update users where id = 7 set status = "active"');
		expect(query).toEqual({
			engine: "mongodb",
			kind: "mongo-write",
			collection: "users",
			op: "update",
			filter: { id: { $eq: 7 } },
			update: { $set: { status: "active" } }
		});
	});

	it("update : multi-set", () => {
		const query = mongo("update t set a = 1, b = false");
		expect(query.op === "update" && query.update).toEqual({
			$set: { a: 1, b: false }
		});
	});

	it("update : une valeur référençant un champ bascule en forme pipeline", () => {
		// Seule la forme pipeline (Mongo 4.2+) évalue une expression sur le document.
		// `$ifNull` : sur un document sans `price`, écrire `null` plutôt que de
		// SUPPRIMER `total` (un `$set` pipeline omet une clé qui résout à *missing*).
		const query = mongo("update t where id = 1 set total = price");
		expect(query.op === "update" && query.update).toEqual([
			{ $set: { total: { $ifNull: ["$price", null] } } }
		]);
	});

	it("delete : filtre", () => {
		const query = mongo("remove from users where age < 18");
		expect(query).toEqual({
			engine: "mongodb",
			kind: "mongo-write",
			collection: "users",
			op: "delete",
			filter: { age: { $lt: 18 } }
		});
	});

	it("write non filtré : filtre vide = toutes les lignes (assumé, ADR-012)", () => {
		expect(mongo("remove from logs")).toMatchObject({ filter: {} });
		expect(mongo("update t set a = 1")).toMatchObject({ filter: {} });
	});

	it("forme pipeline : une chaîne littérale `$…` n'est pas prise pour un champ", () => {
		// En expression d'agrégation, "$price" désignerait la VALEUR du champ price.
		// Sans `$literal`, `label` recevrait le prix au lieu de la chaîne.
		const query = mongo('update t set label = "$price", total = qty');
		expect(query.op === "update" && query.update).toEqual([
			{
				$set: {
					label: { $literal: "$price" },
					total: { $ifNull: ["$qty", null] }
				}
			}
		]);
	});

	it("forme classique : une chaîne `$…` reste une donnée (pas d'expression)", () => {
		// Un `$set` classique n'évalue pas d'expression → aucun enrobage nécessaire.
		const query = mongo('update t set label = "$price"');
		expect(query.op === "update" && query.update).toEqual({
			$set: { label: "$price" }
		});
	});

	it("prédicats composés et `in` traduits comme en lecture", () => {
		const query = mongo('remove from t where a = 1 and b in ["x", "y"]');
		expect(query.op === "delete" && query.filter).toEqual({
			$and: [{ a: { $eq: 1 } }, { b: { $in: ["x", "y"] } }]
		});
	});
});

describe("mutations MongoDB — négation existence-aware (parité 3VL, anti-perte)", () => {
	const filter = (source: string) => {
		const q = mongo(source);
		if (q.op === "insert") {
			throw new Error("attendu un filtre");
		}
		return q.filter;
	};

	it("`!=` exclut l'absent/null (sinon un remove les détruirait)", () => {
		// `$ne` matcherait les documents où `age` est absent/null → perte de données.
		expect(filter("remove from t where age != 30")).toEqual({
			age: { $nin: [30, null] }
		});
	});

	it("`not (champ = v)` = `!=` existence-aware (pas `$nor`)", () => {
		expect(filter("remove from t where not (age = 30)")).toEqual({
			age: { $nin: [30, null] }
		});
	});

	it("`not (a and b)` → De Morgan (chaque feuille existence-aware)", () => {
		expect(
			filter("update t where not (a = 1 and b = 2) set x = 0")
		).toEqual({
			$or: [{ a: { $nin: [1, null] } }, { b: { $nin: [2, null] } }]
		});
	});

	it("`not (champ > v)` → opérateur inversé (>= exclut déjà l'absent)", () => {
		expect(filter("remove from t where not (age > 30)")).toEqual({
			age: { $lte: 30 }
		});
	});

	it("`not (champ in vals)` → `$nin` existence-aware", () => {
		expect(filter('remove from t where not (role in ["a", "b"])')).toEqual({
			role: { $nin: ["a", "b", null] }
		});
	});

	it("double négation revient au positif", () => {
		expect(filter("remove from t where not (not (age = 30))")).toEqual({
			age: { $eq: 30 }
		});
	});

	it("les comparaisons positives (`=`, `<`) restent inchangées", () => {
		expect(filter("remove from t where age < 18")).toEqual({
			age: { $lt: 18 }
		});
	});

	it("refuse une comparaison champ↔champ dans un filtre d'écriture (3VL ambiguë)", () => {
		// `$expr` ne distingue pas absent/null → risque de sur-suppression. On refuse.
		expect(() => mongo("remove from t where a = b")).toThrow(SnqlError);
		expect(() => mongo("remove from t where a != b")).toThrow(SnqlError);
		expect(() => mongo("remove from t where not (a = b)")).toThrow(SnqlError);
	});

	it("refuse `not (champ like <non-chaîne>)` comme la forme positive", () => {
		expect(() => mongo("remove from t where not (x like 5)")).toThrow(
			SnqlError
		);
	});
});

describe("mutations MongoDB — fidélité BSON (correction)", () => {
	it("refuse un bigint hors plage int64 (write)", () => {
		expect(() => mongo("add {big: 9223372036854775808} into t")).toThrow(
			SnqlError
		);
		expect(() =>
			mongo("remove from t where id = 9223372036854775808")
		).toThrow(SnqlError);
	});

	it("un bigint dans la plage int64 passe", () => {
		expect(() => mongo("add {big: 9223372036854775807} into t")).not.toThrow();
	});

	it("un décimal reste un marqueur exact (hydraté en Decimal128 par l'engine)", () => {
		const q = mongo("add {price: 1.123456789012345678} into t");
		// Pas de Number() lossy : le marqueur SqlDecimal traverse le codegen.
		expect(q.op === "insert" && q.documents[0]).toEqual({
			price: { kind: "decimal", raw: "1.123456789012345678" }
		});
	});
});
