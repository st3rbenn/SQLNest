import { describe, expect, it } from "vitest";
import type { LayoutResult } from "../layout";
import type { SchemaModel } from "../schema-model";
import type { TableNodeType } from "../TableNode";
import { syncLayoutTables } from "./layoutTables";

const collection = (name: string, fields: readonly string[] = ["id"]) => ({
	name,
	source: "declared" as const,
	fields: fields.map((f) => ({
		name: f,
		type: "int" as const,
		nullable: false,
		source: "declared" as const
	}))
});

const schemaOf = (...collections: ReturnType<typeof collection>[]) =>
	({ engine: "postgres", collections, relations: [] }) as SchemaModel;

const makeNode =
	(schema: SchemaModel) =>
	(name: string): TableNodeType => {
		const found = schema.collections.find((c) => c.name === name);
		if (found === undefined) throw new Error(name);
		return {
			id: name,
			type: "table",
			position: { x: 0, y: 0 },
			width: 240,
			height: 100,
			data: { collection: found, dimmed: false, focused: false, matched: false }
		};
	};

const layoutOf = (schema: SchemaModel, at: Record<string, [number, number]>) =>
	({
		nodes: schema.collections.map((c) => ({
			...makeNode(schema)(c.name),
			position: { x: at[c.name]?.[0] ?? 0, y: at[c.name]?.[1] ?? 0 }
		})),
		edges: [{ id: "e0", source: "a", target: "b" }]
	}) as LayoutResult;

describe("syncLayoutTables", () => {
	const before = schemaOf(collection("a"), collection("b"));
	const layout = layoutOf(before, { a: [10, 20], b: [300, 40] });

	it("mêmes tables : rien à faire", () => {
		expect(syncLayoutTables(layout, before, makeNode(before), null)).toBeNull();
	});

	it("table créée : centrée sur la vue, les autres gardent leur place", () => {
		const after = schemaOf(collection("a"), collection("b"), collection("c"));
		const synced = syncLayoutTables(layout, after, makeNode(after), {
			x: 500,
			y: 400
		});
		expect(synced?.placed).toEqual({ c: { x: 380, y: 350 } });
		expect(
			synced?.layout.nodes.map((n) => [n.id, n.position.x, n.position.y])
		).toEqual([
			["a", 10, 20],
			["b", 300, 40],
			["c", 380, 350]
		]);
	});

	it("table créée sur une place prise : à la place libre la plus proche", () => {
		const after = schemaOf(collection("a"), collection("b"), collection("c"));
		// Une carte occupe le centre de la vue ; la nouvelle (240 × 100) se
		// pose juste dessous, à 24 de marge, plutôt que plus loin sur le côté.
		const synced = syncLayoutTables(
			layout,
			after,
			makeNode(after),
			{ x: 500, y: 400 },
			[{ x: 380, y: 350, width: 240, height: 100 }]
		);
		expect(synced?.placed).toEqual({ c: { x: 380, y: 474 } });
	});

	it("deux tables créées d'un coup : côte à côte, sans se recouvrir", () => {
		const after = schemaOf(
			collection("a"),
			collection("b"),
			collection("c"),
			collection("d")
		);
		const synced = syncLayoutTables(layout, after, makeNode(after), {
			x: 500,
			y: 400
		});
		expect(synced?.placed).toEqual({
			c: { x: 380, y: 350 },
			d: { x: 380, y: 474 }
		});
	});

	it("table supprimée : son node et ses arêtes sortent du layout", () => {
		const after = schemaOf(collection("a"));
		const synced = syncLayoutTables(layout, after, makeNode(after), null);
		expect(synced?.layout.nodes.map((n) => n.id)).toEqual(["a"]);
		expect(synced?.layout.edges).toEqual([]);
		expect(synced?.placed).toEqual({});
	});

	it("les tables restantes reprennent les colonnes du schéma relu", () => {
		const after = schemaOf(
			collection("a", ["id", "label"]),
			collection("b"),
			collection("c")
		);
		const synced = syncLayoutTables(layout, after, makeNode(after), null);
		const a = synced?.layout.nodes.find((n) => n.id === "a");
		expect(a?.data.collection.fields.map((f) => f.name)).toEqual([
			"id",
			"label"
		]);
	});
});
