import { describe, expect, it } from "vitest";
import type { DDLStatement } from "../index";
import { lowerDDL, parse, tokenize } from "../index";
import { applyDdlToSchema } from "./apply-ddl";
import type { SchemaModel } from "./model";

const BASE: SchemaModel = {
	engine: "postgres",
	collections: [
		{
			name: "users",
			fields: [
				{ name: "id", type: "int", nullable: false, source: "declared" },
				{ name: "email", type: "string", nullable: false, source: "declared" }
			],
			primaryKey: ["id"],
			indexes: [],
			source: "declared"
		}
	],
	relations: [],
	enums: [{ name: "tier", members: ["free", "pro"], source: "declared" }]
};

/** Plan d'une instruction sur `schema`, puis schéma attendu. */
function apply(schema: SchemaModel, src: string, options = {}): SchemaModel {
	return applyDdlToSchema(
		schema,
		lowerDDL(parse(tokenize(src)) as DDLStatement, schema, options)
	);
}

function table(schema: SchemaModel, name: string) {
	return schema.collections.find((c) => c.name === name);
}

describe("applyDdlToSchema", () => {
	it("create table : colonnes, défaut, clé, unicité au nom choisi par le moteur, FK et relation", () => {
		const next = apply(
			BASE,
			'create table orders { id: int, user_id: int nullable ref users.id on delete cascade, code: string unique, state: tier default "free", primary key (id) }'
		);
		expect(table(next, "orders")).toEqual({
			name: "orders",
			fields: [
				{ name: "id", type: "int", nullable: false, source: "declared" },
				{ name: "user_id", type: "int", nullable: true, source: "declared" },
				{ name: "code", type: "string", nullable: false, source: "declared" },
				{
					name: "state",
					type: "enum",
					nullable: false,
					source: "declared",
					hasDefault: true,
					defaultExpr: '"free"',
					enumValues: ["free", "pro"],
					enumTypeName: "tier"
				}
			],
			primaryKey: ["id"],
			indexes: [{ name: "", columns: ["code"], unique: true }],
			source: "declared"
		});
		expect(next.refs).toEqual([
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
		]);
		expect(next.relations).toEqual([
			{
				from: { collection: "orders", fields: ["user_id"] },
				to: { collection: "users", fields: ["id"] },
				kind: "many-to-one",
				origin: "foreign-key",
				confidence: 1
			}
		]);
		// Profil ORM : le nom de la contrainte d'unicité est imposé.
		expect(
			table(
				apply(BASE, "create table t { id: int, code: string unique }", {
					ormProfile: "prisma"
				}),
				"t"
			)?.indexes
		).toEqual([{ name: "t_code_key", columns: ["code"], unique: true }]);
	});

	it("add column / add index / drop index ; `if not exists` sur l'existant : rien ne change", () => {
		let next = apply(BASE, "add column age int nullable into users");
		next = apply(next, "add unique index (email) into users");
		expect(table(next, "users")?.fields.map((f) => f.name)).toEqual([
			"id",
			"email",
			"age"
		]);
		expect(table(next, "users")?.indexes).toEqual([
			{ name: "unique_users_email", columns: ["email"], unique: true }
		]);
		expect(apply(next, "add column age int if not exists into users")).toBe(
			next
		);
		expect(
			table(apply(next, "drop index unique_users_email from users"), "users")
				?.indexes
		).toEqual([]);
	});

	it("drop column : index, clé et FK qui la portent partent avec elle", () => {
		let next = apply(
			BASE,
			"create table orders { id: int, user_id: int ref users.id, primary key (id) }"
		);
		next = apply(next, "add index (user_id, id) into orders");
		next = apply(next, "drop column user_id from orders");
		expect(table(next, "orders")).toMatchObject({
			primaryKey: ["id"],
			indexes: []
		});
		expect(next.refs).toEqual([]);
		expect(next.relations).toEqual([]);
		expect(
			table(apply(next, "drop column id from orders"), "orders")?.primaryKey
		).toBeUndefined();
	});

	it("drop table : la table, ses FK et celles qui la visent", () => {
		let next = apply(
			BASE,
			"create table orders { id: int, user_id: int ref users.id, primary key (id) }"
		);
		next = apply(next, "drop table orders");
		expect(table(next, "orders")).toBeUndefined();
		expect(next.refs).toEqual([]);
		expect(next.relations).toEqual([]);
	});

	it("rename column : clé, index, FK des deux côtés ; sous un profil, les noms conventionnels suivent", () => {
		const prisma = { ormProfile: "prisma" as const };
		let next = apply(
			BASE,
			"create table orders { id: int, user_id: int ref users.id, primary key (id) }",
			prisma
		);
		next = apply(next, "add index (user_id) into orders", prisma);
		next = apply(next, "rename column orders.user_id to buyer_id", prisma);
		expect(table(next, "orders")?.indexes).toEqual([
			{ name: "orders_buyer_id_idx", columns: ["buyer_id"], unique: false }
		]);
		expect(next.refs?.[0]).toMatchObject({
			name: "orders_buyer_id_fkey",
			fromColumn: "buyer_id"
		});
		expect(next.relations[0]?.from.fields).toEqual(["buyer_id"]);
		next = apply(next, "rename column users.id to uid");
		expect(table(next, "users")?.primaryKey).toEqual(["uid"]);
		expect(next.refs?.[0]?.toColumn).toBe("uid");
	});

	it("alter column : nullabilité, défaut, type ; un enum quitté perd ses valeurs", () => {
		let next = apply(BASE, "add column plan tier nullable into users");
		next = apply(next, "alter column users.plan set not null");
		next = apply(next, 'alter column users.plan set default "pro"');
		expect(table(next, "users")?.fields.at(-1)).toMatchObject({
			nullable: false,
			hasDefault: true,
			enumTypeName: "tier"
		});
		next = apply(next, "alter column users.plan drop default");
		next = apply(next, "alter column users.plan set type string");
		const plan = table(next, "users")?.fields.at(-1);
		expect(plan).toEqual({
			name: "plan",
			type: "string",
			nullable: false,
			source: "declared"
		});
	});

	it("set type : les colonnes liées par FK suivent", () => {
		let next = apply(
			BASE,
			"create table orders { id: int, user_id: int ref users.id, primary key (id) }"
		);
		next = apply(next, "alter column users.id set type bigint");
		expect(table(next, "users")?.fields[0]?.type).toBe("bigint");
		expect(table(next, "orders")?.fields[1]?.type).toBe("bigint");
	});

	it("enums : valeur ajoutée suivie par ses colonnes ; drop cascade retire les colonnes", () => {
		let next = apply(BASE, "add column plan tier nullable into users");
		next = apply(next, 'add enum member tier "team"');
		expect(next.enums?.[0]?.members).toEqual(["free", "pro", "team"]);
		expect(table(next, "users")?.fields.at(-1)?.enumValues).toEqual([
			"free",
			"pro",
			"team"
		]);
		next = apply(next, "drop enum tier cascade");
		expect(next.enums).toEqual([]);
		expect(table(next, "users")?.fields.map((f) => f.name)).toEqual([
			"id",
			"email"
		]);
	});

	it("add ref / drop ref", () => {
		let next = apply(
			BASE,
			"create table orders { id: int, user_id: int nullable, primary key (id) }"
		);
		next = apply(
			next,
			"add ref (user_id) references users.id on delete set null into orders"
		);
		expect(next.refs?.[0]).toMatchObject({
			onDelete: "set-null",
			fromColumn: "user_id"
		});
		next = apply(next, `drop ref ${next.refs?.[0]?.name} from orders`);
		expect(next.refs).toEqual([]);
		expect(next.relations).toEqual([]);
	});
});
