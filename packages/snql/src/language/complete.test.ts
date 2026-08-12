import { describe, expect, it } from "vitest";
import type { SchemaModel } from "../schema/model";
import { completeSnql } from "./complete";

const SCHEMA: SchemaModel = {
	engine: "postgres",
	collections: [
		{
			name: "users",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				{ name: "id", type: "bigint", nullable: false, source: "declared" },
				{ name: "email", type: "string", nullable: false, source: "declared" },
				{
					name: "display_name",
					type: "string",
					nullable: true,
					source: "declared"
				},
				{ name: "is_active", type: "bool", nullable: false, source: "declared" }
			]
		},
		{
			name: "orders",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				{ name: "id", type: "bigint", nullable: false, source: "declared" },
				{
					name: "user_id",
					type: "bigint",
					nullable: false,
					source: "declared"
				},
				{ name: "status", type: "string", nullable: false, source: "declared" },
				{
					name: "total_cents",
					type: "bigint",
					nullable: false,
					source: "declared"
				}
			]
		}
	],
	relations: [
		{
			from: { collection: "orders", fields: ["user_id"] },
			to: { collection: "users", fields: ["id"] },
			kind: "many-to-one",
			origin: "foreign-key",
			confidence: 1
		}
	]
};

const at = (src: string, offset = src.length) =>
	completeSnql(src, offset, SCHEMA);
const labels = (src: string, offset = src.length) =>
	at(src, offset).options.map((o) => o.label);

describe("completeSnql — début de requête", () => {
	it("propose les verbes canoniques sur une entrée vide", () => {
		expect(labels("")).toEqual(["get", "add", "update", "remove"]);
		expect(at("").options.every((o) => o.type === "verb")).toBe(true);
	});

	it("remplace le verbe partiel depuis son début", () => {
		const result = at("ge");
		expect(result.from).toBe(0);
		expect(result.options.map((o) => o.label)).toContain("get");
	});
});

describe("completeSnql — collection source", () => {
	it("propose les collections après un verbe de lecture", () => {
		expect(labels("get ")).toEqual(["users", "orders"]);
		expect(at("get ").options[0]?.type).toBe("collection");
		expect(at("get ").options[0]?.detail).toBe("4 champs");
	});

	it("propose les collections après update", () => {
		expect(labels("update ")).toEqual(["users", "orders"]);
	});

	it("remove propose d'abord 'from' puis les collections", () => {
		expect(labels("remove ")).toEqual(["from"]);
		expect(labels("remove from ")).toEqual(["users", "orders"]);
	});

	it("add … into propose les collections", () => {
		expect(labels('add {email: "x"} into ')).toEqual(["users", "orders"]);
	});

	it("remplace la collection partielle depuis son début", () => {
		const result = at("get us");
		expect(result.from).toBe(4);
		expect(result.options.map((o) => o.label)).toEqual(["users", "orders"]);
	});
});

describe("completeSnql — étapes après la source", () => {
	it("propose les étapes select dans l'ordre canonique", () => {
		expect(labels("get users ")).toEqual([
			"with",
			"where",
			"sort",
			"pick",
			"limit"
		]);
	});

	it("propose les étapes update", () => {
		expect(labels("update users ")).toEqual(["where", "set"]);
	});

	it("propose l'étape where pour delete", () => {
		expect(labels("remove from users ")).toEqual(["where"]);
	});

	it("filtre l'étape partielle depuis son début", () => {
		const result = at("get users wh");
		expect(result.from).toBe("get users ".length);
		expect(result.options.map((o) => o.label)).toContain("where");
	});

	it("ne propose plus une étape déjà présente (sauf `with`, répétable via `and`)", () => {
		expect(labels("get users where age = 1 ")).toEqual([
			"with",
			"sort",
			"pick",
			"limit"
		]);
	});
});

describe("completeSnql — champs", () => {
	it("propose les champs de la source après where", () => {
		expect(labels("get users where ")).toEqual([
			"id",
			"email",
			"display_name",
			"is_active"
		]);
	});

	it("annote le type et la nullabilité", () => {
		const opts = at("get users where ").options;
		expect(opts.find((o) => o.label === "email")?.detail).toBe("string");
		expect(opts.find((o) => o.label === "display_name")?.detail).toBe(
			"string ?"
		);
	});

	it("propose les champs après and / or / not", () => {
		expect(labels("get users where is_active = true and ")).toContain(
			"email"
		);
		expect(labels("get users where not ")).toContain("email");
	});

	it("propose les champs après pick et après une virgule de pick", () => {
		expect(labels("get users pick ")).toContain("email");
		expect(labels("get users pick id, ")).toContain("email");
	});

	it("propose les champs après sort et après une virgule de sort", () => {
		expect(labels("get users sort ")).toContain("email");
		expect(labels("get users sort id, ")).toContain("email");
	});

	it("propose les champs après set (update)", () => {
		expect(labels("update users set ")).toContain("is_active");
		expect(labels("update users set is_active = true, ")).toContain("email");
	});

	it("ne propose rien pour une source inconnue du schéma", () => {
		expect(labels("get inconnue where ")).toEqual([]);
	});
});

describe("completeSnql — jointures (relation-aware)", () => {
	it("propose la collection liée d'abord, clause on pré-remplie", () => {
		const opts = at("get orders with ").options;
		const users = opts.find((o) => o.label === "users");
		expect(users?.type).toBe("relation");
		expect(users?.detail).toBe("via user_id = id");
		expect(users?.apply).toBe("users on user_id = id");
	});

	it("oriente la relation selon la source", () => {
		const opts = at("get users with ").options;
		const orders = opts.find((o) => o.label === "orders");
		expect(orders?.type).toBe("relation");
		expect(orders?.apply).toBe("orders on id = user_id");
	});

	it("membre gauche de on = champ de la source", () => {
		expect(labels("get orders with users as u on ")).toEqual([
			"id",
			"user_id",
			"status",
			"total_cents"
		]);
	});

	it("membre droit de on = champ de la collection jointe", () => {
		expect(labels("get orders with users as u on user_id = ")).toEqual([
			"id",
			"email",
			"display_name",
			"is_active"
		]);
	});

	it("propose `one`/`many` en tête après `with`, avant les collections", () => {
		const opts = at("get orders with ").options;
		expect(opts.slice(0, 2).map((o) => o.label)).toEqual(["one", "many"]);
		expect(opts[0]?.type).toBe("keyword");
		expect(opts[0]?.detail).toContain("LEFT JOIN");
		expect(opts[1]?.detail).toContain("embed");
		// Les collections restent proposées derrière (schema-aware).
		expect(opts.map((o) => o.label)).toContain("users");
	});

	it("propose les collections après `with one` (multiplicité forcée)", () => {
		const opts = at("get orders with one ").options;
		expect(opts.map((o) => o.label)).toContain("users");
		expect(opts.map((o) => o.label)).not.toContain("one");
	});

	it("propose les collections après `with many`", () => {
		expect(labels("get orders with many ")).toContain("users");
	});

	it("propose `one`/`many` après un `and` de chaînage de join", () => {
		const opts = at(
			"get orders with users on user_id = id and "
		).options;
		expect(opts.slice(0, 2).map((o) => o.label)).toEqual(["one", "many"]);
	});

	it("`one` hors position `with` ne propose rien (usage errant)", () => {
		// Ici `one` est classifié keyword par le lexer mais il n'est pas après
		// `with` — la complétion ne doit PAS proposer de collections.
		expect(labels("get users where age = one ")).toEqual([]);
	});

	it("inclut l'alias de jointure dans un pick", () => {
		const opts = at(
			"get orders with users as u on user_id = id pick status, "
		).options;
		const alias = opts.find((o) => o.label === "u");
		expect(alias?.type).toBe("alias");
		expect(alias?.detail).toBe("→ users");
	});
});

describe("completeSnql — contextes vérifiés en review", () => {
	it("un alias de verbe hors tête de requête ne pilote pas le contexte", () => {
		// Le lexer classe `find`/`edit`/`delete` en `verb` où qu'ils soient : sans
		// garde de position, ces contextes proposeraient collections ou `from`.
		expect(labels("get users where find ")).toEqual([]);
		expect(labels("get users pick delete ")).toEqual([]);
		expect(labels("update users set edit ")).toEqual([]);
	});

	it("propose les champs après '(' dans un prédicat groupé", () => {
		expect(labels("get users where (")).toContain("email");
		expect(labels("get users where (is_active = true) and (")).toContain(
			"email"
		);
	});

	it("propose 'into' une fois le document d'insert refermé", () => {
		expect(labels('add {email: "x"} ')).toEqual(["into"]);
	});

	it("dans une liste de documents encore ouverte, ne propose pas 'into'", () => {
		expect(labels('add [{email: "x"} ')).toEqual([]);
		expect(labels('add [{email: "a"}, {email: "b"}] ')).toEqual(["into"]);
	});
});

describe("completeSnql — robustesse", () => {
	it("ne lève pas sur une chaîne non terminée (curseur dans le littéral)", () => {
		const result = at('get users where email = "ab');
		expect(result.options).toEqual([]);
	});

	it("ne complète pas un chemin pointé (champ imbriqué) en v1", () => {
		expect(at("get orders pick user.").options).toEqual([]);
	});

	it("borne un offset hors limites", () => {
		expect(() => completeSnql("get ", 999, SCHEMA)).not.toThrow();
		expect(
			completeSnql("get ", 999, SCHEMA).options.map((o) => o.label)
		).toEqual(["users", "orders"]);
	});

	it("schéma sans collection : propose quand même les verbes/étapes", () => {
		const empty: SchemaModel = {
			engine: "postgres",
			collections: [],
			relations: []
		};
		expect(completeSnql("", 0, empty).options.map((o) => o.label)).toEqual([
			"get",
			"add",
			"update",
			"remove"
		]);
		expect(
			completeSnql("get users ", 10, empty).options.map((o) => o.label)
		).toContain("where");
	});
});
