import { describe, expect, it, vi } from "vitest";
import type { SpotlightActionGroupData } from "@sqlnest/design-system";
import { buildCanvasCommands, type CanvasCommandCallbacks } from "./commands";
import { SAMPLE_POSTGRES } from "./schema-model";

function makeCbs(overrides: Partial<CanvasCommandCallbacks> = {}): CanvasCommandCallbacks {
	return {
		onFocusTable: vi.fn(),
		onFitView: vi.fn(),
		onAskAi: vi.fn(),
		onToggleTheme: vi.fn(),
		...overrides
	};
}

function group(groups: SpotlightActionGroupData[], name: string) {
	const g = groups.find((x) => x.group === name);
	if (!g) throw new Error(`group ${name} not found`);
	return g;
}

function actions(g: SpotlightActionGroupData) {
	return g.actions.filter((a) => "id" in a) as Array<
		Extract<(typeof g.actions)[number], { id: string }>
	>;
}

describe("buildCanvasCommands", () => {
	it("produces one Tables group with one entry per collection", () => {
		const groups = buildCanvasCommands(SAMPLE_POSTGRES, makeCbs());
		const tables = group(groups, "Tables");
		expect(actions(tables)).toHaveLength(SAMPLE_POSTGRES.collections.length);
	});

	it("produces a Canvas actions group with at least: fit view, ask ai, toggle theme", () => {
		const groups = buildCanvasCommands(SAMPLE_POSTGRES, makeCbs());
		const canvas = group(groups, "Actions canvas");
		const ids = actions(canvas).map((a) => a.id);
		expect(ids).toEqual(
			expect.arrayContaining(["fit-view", "ask-ai", "toggle-theme"])
		);
	});

	it("each table action invokes onFocusTable with its own name", () => {
		const onFocusTable = vi.fn();
		const groups = buildCanvasCommands(SAMPLE_POSTGRES, makeCbs({ onFocusTable }));
		const tables = group(groups, "Tables");
		const users = actions(tables).find((a) => a.id === "table:users");
		expect(users).toBeDefined();
		users?.onClick?.(new MouseEvent("click") as unknown as never);
		expect(onFocusTable).toHaveBeenCalledWith("users");
	});

	it("each table action includes the collection name in searchable keywords", () => {
		const groups = buildCanvasCommands(SAMPLE_POSTGRES, makeCbs());
		const tables = group(groups, "Tables");
		const users = actions(tables).find((a) => a.id === "table:users");
		expect(users?.keywords).toEqual(expect.arrayContaining(["users"]));
	});

	it("Fit view action calls onFitView", () => {
		const onFitView = vi.fn();
		const groups = buildCanvasCommands(SAMPLE_POSTGRES, makeCbs({ onFitView }));
		const fit = actions(group(groups, "Actions canvas")).find(
			(a) => a.id === "fit-view"
		);
		fit?.onClick?.(new MouseEvent("click") as unknown as never);
		expect(onFitView).toHaveBeenCalledOnce();
	});
});
