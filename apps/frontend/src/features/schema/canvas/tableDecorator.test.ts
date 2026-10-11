import { describe, expect, it, vi } from "vitest";
import type { TableNodeType } from "../TableNode";
import { createTableDecorator } from "./tableDecorator";

const table = (id: string, x = 0): TableNodeType =>
	({
		id,
		type: "table",
		position: { x, y: 0 },
		data: {
			collection: { name: id, fields: [], source: "declared" },
			dimmed: false,
			focused: false,
			matched: false
		}
	}) as TableNodeType;

const idle = { dimmed: false, focused: false, hoverHighlight: false };

describe("habillage des tables", () => {
	it("table et drapeaux inchangés : même objet", () => {
		const decorate = createTableDecorator(() => {});
		const t = table("a");
		expect(decorate(t, idle)).toBe(decorate(t, { ...idle }));
	});

	it("table seulement déplacée : nouvel objet, même data", () => {
		const decorate = createTableDecorator(() => {});
		const t = table("a");
		const before = decorate(t, idle);
		const after = decorate({ ...t, position: { x: 50, y: 0 } }, idle);
		expect(after).not.toBe(before);
		expect(after.position).toEqual({ x: 50, y: 0 });
		expect(after.data).toBe(before.data);
	});

	it("drapeau changé : nouvelle data", () => {
		const decorate = createTableDecorator(() => {});
		const t = table("a");
		const before = decorate(t, idle);
		const after = decorate(t, { ...idle, focused: true });
		expect(after.data).not.toBe(before.data);
		expect(after.data).toMatchObject({
			focused: true,
			dimmed: false,
			matched: false
		});
	});

	it("resize : rappelle le handler avec l'id de la table", () => {
		const onResize = vi.fn();
		const decorate = createTableDecorator(onResize);
		const size = { width: 300, height: 200, x: 10, y: 20 };
		decorate(table("a"), idle).data.onResizeEnd?.(size);
		expect(onResize).toHaveBeenCalledWith("a", size);
	});
});
