/**
 * Alias `id ↔ _id` (ADR-029 D13, ADR-036 E/1f) : le lower réécrit les noms
 * SNQL vers les noms stockés, la sortie garde le nom SNQL.
 */

import { describe, expect, it } from "vitest";
import { tokenize } from "../lexer/lexer";
import type { InsertStatement, Query, UpdateStatement } from "../parser/ast";
import { parse } from "../parser/parser";
import type { SchemaModel } from "../schema/model";
import { lower, lowerMutation } from "./lower";
import { type LogicalPlan, linearize } from "./plan";

const SCHEMA: SchemaModel = {
	engine: "mongodb",
	collections: [
		{
			name: "seat",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				{
					name: "id",
					type: "int",
					nullable: false,
					source: "declared",
					nativeName: "_id"
				},
				{ name: "label", type: "string", nullable: true, source: "declared" }
			]
		},
		{
			name: "ticket",
			source: "declared",
			primaryKey: ["id"],
			fields: [
				{
					name: "id",
					type: "int",
					nullable: false,
					source: "declared",
					nativeName: "_id"
				},
				{ name: "seat_id", type: "int", nullable: true, source: "declared" }
			]
		}
	],
	relations: []
};

const read = (src: string, schema: SchemaModel = SCHEMA): LogicalPlan =>
	lower(parse(tokenize(src)) as Query, schema);
const write = (src: string) =>
	lowerMutation(
		parse(tokenize(src)) as InsertStatement | UpdateStatement,
		SCHEMA
	);
const ops = (src: string) => linearize(read(src));

describe("alias id ↔ _id — lecture (ADR-036 E/1f)", () => {
	it("filtre et tri sur `_id`, scan marqué pour la sortie", () => {
		const [scan, ...rest] = ops("find seat where id = 2 sort id");
		expect(scan).toMatchObject({ op: "scan", nativeNames: { _id: "id" } });
		expect(rest.find((o) => o.op === "filter")).toMatchObject({
			predicate: { left: { kind: "field", path: ["_id"] } }
		});
		expect(rest.find((o) => o.op === "sort")).toMatchObject({
			keys: [{ path: ["_id"] }]
		});
	});

	it("pick id → `_id` projeté sous le nom `id`", () => {
		expect(
			ops("find seat pick id, label").find((o) => o.op === "project")
		).toMatchObject({
			fields: [{ path: ["_id"], alias: "id" }, { path: ["label"] }]
		});
	});

	it("group by id : clé `_id`, sortie `id`", () => {
		expect(
			ops("find seat group by id pick id, count(*) as n").find(
				(o) => o.op === "aggregate"
			)
		).toMatchObject({
			groupKeys: [["_id"]],
			fields: [{ path: ["_id"], alias: "id" }, {}]
		});
	});

	it("alias de source et jointure : chaque côté vers son `_id`", () => {
		const join = ops(
			"find ticket as t with seat as s on seat_id = id where t.id = 1"
		).find((o) => o.op === "join");
		expect(join).toMatchObject({
			localField: ["seat_id"],
			foreignField: ["_id"],
			nativeNames: { _id: "id" }
		});
		expect(
			ops("find ticket as t where t.id = 1").find((o) => o.op === "filter")
		).toMatchObject({
			predicate: { left: { path: ["t", "_id"] } }
		});
	});

	it("sous-requête corrélée : la référence extérieure aussi", () => {
		const filter = ops(
			"find seat as s where exists (find ticket as t where t.seat_id = s.id)"
		).find((o) => o.op === "filter");
		const sub = (filter as { predicate: { subplan: LogicalPlan } }).predicate
			.subplan;
		expect(linearize(sub).find((o) => o.op === "filter")).toMatchObject({
			predicate: {
				left: { path: ["t", "seat_id"] },
				right: { path: ["s", "_id"] }
			}
		});
	});

	it("sans nom natif dans le schéma, le plan ne change pas", () => {
		const plain: SchemaModel = {
			...SCHEMA,
			collections: SCHEMA.collections.map((c) => ({
				...c,
				fields: c.fields.map(({ nativeName: _n, ...f }) => f)
			}))
		};
		expect(read("find seat where id = 2 pick id", plain)).toEqual(
			lower(parse(tokenize("find seat where id = 2 pick id")) as Query)
		);
	});
});

describe("alias id ↔ _id — écritures (ADR-036 E/1f)", () => {
	it("insert : colonne `_id`, documents rendus sous `id`", () => {
		expect(write('add {id: 1, label: "a"} into seat')).toMatchObject({
			op: "insert",
			columns: ["_id", "label"],
			nativeNames: { _id: "id" }
		});
	});

	it("upsert : clé de conflit `_id`", () => {
		expect(
			write(
				'add {id: 1, label: "a"} into seat on conflict (id) edit set label = "b"'
			)
		).toMatchObject({ onConflict: { keys: ["_id"] } });
	});

	it("update / delete : filtre sur `_id`", () => {
		expect(write('update seat where id = 1 set label = "b"')).toMatchObject({
			predicate: { left: { path: ["_id"] } }
		});
		expect(
			lowerMutation(
				parse(tokenize("remove from seat where id = 1")) as never,
				SCHEMA
			)
		).toMatchObject({ predicate: { left: { path: ["_id"] } } });
	});

	it("modifier `id` est refusé : `_id` est immuable", () => {
		expect(() => write("update seat where id = 1 set id = 2")).toThrow(
			/'id' est l'alias de '_id'/
		);
	});
});

describe("alias id ↔ _id — types de sortie (ADR-036 E/1f)", () => {
	it("pick id : colonne `id`, typée depuis le schéma", async () => {
		const { inferResultColumns } = await import(
			"../runtime/infer-column-types"
		);
		const { plan } = await import("../planner/planner");
		const { MONGODB_CAPABILITIES } = await import("../planner/capabilities");
		const physical = plan(
			read("find seat pick id, label"),
			MONGODB_CAPABILITIES
		);
		expect(
			inferResultColumns(physical, SCHEMA).map((c) => [c.name, c.type])
		).toEqual([
			["id", "int"],
			["label", "string"]
		]);
	});
});
