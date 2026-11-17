import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runConsoleQuery } from "../../query/consoleQueriesStore";
import type { QueryResult } from "../../query/useRunQuery";
import type { ConsoleEntry } from "./useConsoleIndex";
import { resultKey, useResultRuns, useRunStatuses } from "./useResultRuns";

// La requête part quand le test le décide : `settle` la fait aboutir.
let settle: {
	resolve: (result: QueryResult) => void;
	reject: (error: Error) => void;
};
vi.mock("../../query/useRunQuery", async (original) => ({
	...(await original<typeof import("../../query/useRunQuery")>()),
	runQueryRequest: () =>
		new Promise<QueryResult>((resolve, reject) => {
			settle = { resolve, reject };
		})
}));

const CONN = "11111111-1111-4111-8111-111111111111";
let seq = 0;
/** Une console neuve par test : le store de requêtes vit au niveau module. */
function freshEntry(): ConsoleEntry {
	seq += 1;
	return {
		id: `console:${seq}`,
		tabId: "t",
		source: "find track",
		title: "Pistes",
		root: "track",
		joined: []
	};
}
const input = { connectionId: CONN, source: "find track", teamSlug: "team" };
const rows = (columns: string[]): QueryResult =>
	({ columns, rows: [], rowCount: 0 }) as unknown as QueryResult;

describe("useRunStatuses", () => {
	let entry: ConsoleEntry;
	beforeEach(() => {
		entry = freshEntry();
	});

	it("suit une requête de son départ à sa réussite", async () => {
		const entries = [entry];
		const { result } = renderHook(() => useRunStatuses(CONN, entries));
		expect(result.current.size).toBe(0);
		let run: Promise<void> = Promise.resolve();
		act(() => {
			run = runConsoleQuery(resultKey(CONN, entry), input);
		});
		expect(result.current.get(entry.id)).toBe("running");
		await act(async () => {
			settle.resolve(rows(["name"]));
			await run;
		});
		expect(result.current.size).toBe(0);
	});

	it("retient une requête en échec", async () => {
		const entries = [entry];
		const { result } = renderHook(() => useRunStatuses(CONN, entries));
		let run: Promise<void> = Promise.resolve();
		act(() => {
			run = runConsoleQuery(resultKey(CONN, entry), input);
		});
		await act(async () => {
			settle.reject(new Error("relation inconnue"));
			await run;
		});
		expect(result.current.get(entry.id)).toBe("error");
	});
});

describe("useResultRuns", () => {
	it("ne retient que les exécutions qui ont des colonnes", async () => {
		const read = freshEntry();
		const write = freshEntry();
		const entries = [read, write];
		const { result } = renderHook(() => useResultRuns(CONN, entries));
		await act(async () => {
			const run = runConsoleQuery(resultKey(CONN, read), input);
			settle.resolve(rows(["name"]));
			await run;
		});
		await act(async () => {
			const run = runConsoleQuery(resultKey(CONN, write), input);
			settle.resolve(rows([]));
			await run;
		});
		expect([...result.current.keys()]).toEqual([read.id]);
		expect(typeof result.current.get(read.id)).toBe("number");
	});
});
