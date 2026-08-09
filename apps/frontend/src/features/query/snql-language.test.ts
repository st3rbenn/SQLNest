import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import type { SchemaModel } from "@sqlnest/snql";
import { describe, expect, it } from "vitest";
import { snqlCompletionSource } from "./snql-language";

// Petit schéma dédié — deux collections liées par une FK, pour couvrir champs,
// collections et cibles de jointure sans dépendre d'un fixture partagé.
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
				}
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
				{ name: "status", type: "string", nullable: false, source: "declared" }
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

// Invoque la source CM comme le ferait le pipeline `autocompletion`.
function complete(doc: string, offset = doc.length, schema = SCHEMA) {
	const src = snqlCompletionSource(() => schema);
	const state = EditorState.create({ doc });
	const ctx = new CompletionContext(state, offset, true);
	return src(ctx);
}

describe("snqlCompletionSource — schéma indéfini", () => {
	it("retourne null tant que le schéma n'est pas chargé", () => {
		const src = snqlCompletionSource(() => undefined);
		const state = EditorState.create({ doc: "get " });
		const ctx = new CompletionContext(state, state.doc.length, true);
		expect(src(ctx)).toBeNull();
	});
});

describe("snqlCompletionSource — verbes", () => {
	it("propose les verbes primaires sur une entrée vide", () => {
		const res = complete("");
		expect(res).not.toBeNull();
		const labels = res?.options.map((o) => o.label);
		expect(labels).toEqual(
			expect.arrayContaining(["get", "add", "update", "remove"])
		);
	});

	it("étiquette les verbes avec le type CM `keyword` (icône verbe)", () => {
		const res = complete("");
		expect(res?.options.every((o) => o.type === "keyword")).toBe(true);
	});
});

describe("snqlCompletionSource — collections", () => {
	it("propose les collections après le verbe `get`", () => {
		const res = complete("get ");
		const labels = res?.options.map((o) => o.label);
		expect(labels).toEqual(expect.arrayContaining(["users", "orders"]));
	});

	it("mappe les collections vers le type CM `class`", () => {
		const res = complete("get ");
		expect(res?.options.every((o) => o.type === "class")).toBe(true);
	});

	it("remplace le préfixe de collection en cours de frappe", () => {
		const res = complete("get us");
		// `from` couvre le préfixe `us`, pas la position du curseur.
		expect(res?.from).toBe("get ".length);
		expect(res?.options.map((o) => o.label)).toContain("users");
	});
});

describe("snqlCompletionSource — champs après `where`", () => {
	it("propose les champs de la collection source", () => {
		const res = complete("get users where ");
		const labels = res?.options.map((o) => o.label);
		expect(labels).toEqual(
			expect.arrayContaining(["id", "email", "display_name"])
		);
	});

	it("mappe les champs vers le type CM `property` et porte le type SNQL en `detail`", () => {
		const res = complete("get users where ");
		const email = res?.options.find((o) => o.label === "email");
		expect(email?.type).toBe("property");
		expect(email?.detail).toBe("string");
		const displayName = res?.options.find((o) => o.label === "display_name");
		// Nullable → marqueur `?` dans le detail.
		expect(displayName?.detail).toBe("string ?");
	});
});

describe("snqlCompletionSource — cibles de jointure après `with`", () => {
	it("propose la collection liée en tête, annotée `relation`", () => {
		const res = complete("get orders with ");
		const first = res?.options[0];
		expect(first?.label).toBe("users");
		expect(first?.type).toBe("function"); // relation → CM `function`
		expect(first?.detail).toBe("via user_id = id");
	});

	it("pré-remplit la clause `on` via `apply` pour une relation à champ unique", () => {
		const res = complete("get orders with ");
		const users = res?.options.find((o) => o.label === "users");
		expect(users?.apply).toBe("users on user_id = id");
	});

	it("liste les collections non liées derrière, sans `apply`", () => {
		const res = complete("get users with ");
		const orders = res?.options.find((o) => o.label === "orders");
		expect(orders?.type).toBe("function"); // orders reste lié à users (via FK)
		// La collection source n'apparaît jamais comme cible.
		expect(res?.options.map((o) => o.label)).not.toContain("users");
	});
});

describe("snqlCompletionSource — tolérance à l'input incomplet", () => {
	it("propose les collections après `delete from` (alias de remove)", () => {
		expect(() => complete("delete from ")).not.toThrow();
		const res = complete("delete from ");
		expect(res?.options.map((o) => o.label)).toEqual(
			expect.arrayContaining(["users", "orders"])
		);
	});

	it("retourne null (aucun candidat) sur un chemin pointé non supporté en v1", () => {
		// `alias.` → completeSnql renvoie 0 options ; la source doit retourner null.
		const res = complete("get users pick users.");
		expect(res).toBeNull();
	});

	it("retourne null quand aucune complétion n'est pertinente au curseur", () => {
		// Après une string littérale ouverte, aucun candidat structurel n'a de sens.
		const res = complete('get users where email = "foo');
		expect(res).toBeNull();
	});

	it("expose `validFor` pour laisser CM filtrer sans re-solliciter la source", () => {
		const res = complete("get ");
		expect(res?.validFor).toBeInstanceOf(RegExp);
		// Le pattern accepte tout identifiant partiel (préfixe en cours de frappe).
		expect((res?.validFor as RegExp).test("us")).toBe(true);
		expect((res?.validFor as RegExp).test("user_id")).toBe(true);
	});
});
