/**
 * Autocomplete forward-nav (ADR-031 D6, FK/2b) : `pick |` propose les noms de
 * nav des FK sortantes ; `pick user.|` drille vers les colonnes de la cible.
 */

import { describe, expect, it } from "vitest";
import type { SchemaModel } from "../schema/model";
import { completeSnql } from "./complete";

const SCHEMA: SchemaModel = {
	engine: "postgres",
	collections: [
		{
			name: "orders",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				{ name: "id", type: "bigint", nullable: false, source: "declared" },
				{ name: "user_id", type: "bigint", nullable: true, source: "declared" },
				{ name: "total", type: "int", nullable: false, source: "declared" }
			]
		},
		{
			name: "users",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				{ name: "id", type: "bigint", nullable: false, source: "declared" },
				{ name: "name", type: "string", nullable: false, source: "declared" },
				{ name: "email", type: "string", nullable: true, source: "declared" }
			]
		}
	],
	relations: [],
	refs: [
		{
			name: "fk_orders_user_id_users",
			fromCollection: "orders",
			fromColumn: "user_id",
			toCollection: "users",
			toColumn: "id",
			onDelete: "cascade",
			onUpdate: "restrict",
			source: "declared"
		}
	]
};

const at = (src: string, offset = src.length) => completeSnql(src, offset, SCHEMA);
const labels = (src: string) => at(src).options.map((o) => o.label);

describe("forward-nav autocomplete (ADR-031 D6)", () => {
	it("`pick |` propose le nom de nav `user` en plus des colonnes locales", () => {
		const ls = labels("find orders pick ");
		expect(ls).toContain("user"); // nav de user_id → users
		expect(ls).toContain("total"); // colonne locale
	});

	it("le nav a `apply: user.` pour driller directement", () => {
		const nav = at("find orders pick ").options.find((o) => o.label === "user");
		expect(nav?.apply).toBe("user.");
		expect(nav?.type).toBe("relation");
	});

	it("`pick user.|` propose les colonnes de la cible users", () => {
		const ls = labels("find orders pick user.");
		expect(ls).toEqual(expect.arrayContaining(["id", "name", "email"]));
	});

	it("`where |` propose aussi le nav", () => {
		expect(labels("find orders where ")).toContain("user");
	});

	it("nav absent si pas de FK sortante", () => {
		// depuis users (aucune FK sortante) → pas de nav.
		expect(labels("find users pick ")).not.toContain("user");
	});

	it("`pick <alias>.|` d'un join explicite drille aussi", () => {
		const ls = labels("find orders with one users as u on user_id = id pick u.");
		expect(ls).toEqual(expect.arrayContaining(["name", "email"]));
	});
});

describe("reverse-nav autocomplete (ADR-031 D7, FK/2b)", () => {
	it("`find users pick |` propose la collection référençante `orders`", () => {
		// users est référencé par orders.user_id → reverse-nav `orders`.
		expect(labels("find users pick ")).toContain("orders");
	});

	it("le reverse-nav a `apply: orders.`", () => {
		const rev = at("find users pick ").options.find((o) => o.label === "orders");
		expect(rev?.apply).toBe("orders.");
	});

	it("`find users pick orders.|` propose `count`", () => {
		expect(labels("find users pick orders.")).toEqual(["count"]);
	});
});

describe("drop ref autocomplete (ADR-031 FK/3)", () => {
	it("`drop ` propose `ref` parmi les cibles drop", () => {
		expect(labels("drop ")).toContain("ref");
	});

	it("`drop ref ` propose les refs déclarées avec nav en detail", () => {
		const opts = at("drop ref ").options;
		const ref = opts.find((o) => o.label === "fk_orders_user_id_users");
		expect(ref).toBeDefined();
		expect(ref?.type).toBe("relation");
		expect(ref?.detail).toBe("orders.user_id → users.id");
	});

	it("`drop ref NAME ` propose `from`", () => {
		expect(labels("drop ref fk_orders_user_id_users ")).toContain("from");
	});

	it("`drop ref NAME from ` propose la table porteuse (précis)", () => {
		expect(labels("drop ref fk_orders_user_id_users from ")).toEqual([
			"orders"
		]);
	});

	it("`drop ref inconnu from ` retombe sur toutes les collections", () => {
		const l = labels("drop ref fk_ghost from ");
		expect(l).toContain("orders");
		expect(l).toContain("users");
	});
});
